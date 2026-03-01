/**
 * Reef — an agent with a server.
 *
 * Each task gets its own pi process (RPC mode). Fresh extensions every time.
 * Concurrent tasks = concurrent pi processes. The conversation tree is memory.
 *
 * Lifecycle per task:
 *   1. POST /reef/submit
 *   2. Spawn pi --mode rpc --no-session (fresh process, fresh extensions)
 *   3. Send task with tree context via --append-system-prompt
 *   4. Stream events to SSE clients
 *   5. agent_end → capture result, append to tree, kill pi
 *
 * Routes:
 *   POST /reef/submit   — start a task
 *   GET  /reef/tasks     — list active + completed tasks
 *   GET  /reef/tree      — conversation history
 *   GET  /reef/state     — status
 *   GET  /reef/events    — SSE stream
 */

import { Hono } from "hono";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer, type ServerOptions } from "./core/server.js";
import { ConversationTree, type TaskArtifacts } from "./tree.js";
import { bearerAuth } from "./core/auth.js";

// =============================================================================
// Task — one pi process per task
// =============================================================================

interface Task {
  id: string;
  prompt: string;
  status: "running" | "done" | "error";
  output: string;
  events: any[];
  startedAt: number;
  completedAt?: number;
  error?: string;
}

let taskCounter = 0;

function spawnTask(
  prompt: string,
  treeContext: string,
  opts: { model?: string; onEvent: (event: any) => void; onDone: (output: string) => void; onError: (err: string) => void },
): ChildProcess {
  const piPath = process.env.PI_PATH ?? "pi";
  const cwd = process.env.REEF_DIR ?? process.cwd();

  const child = spawn(piPath, [
    "--mode", "rpc",
    "--no-session",
    "--append-system-prompt", treeContext,
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: {
      ...process.env,
      ...(opts.model ? { PI_MODEL: opts.model } : {}),
    },
  });

  let lineBuf = "";
  let output = "";

  child.stdout.on("data", (data: Buffer) => {
    lineBuf += data.toString();
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        opts.onEvent(event);

        // Accumulate assistant text
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          output += event.assistantMessageEvent.delta;
        }

        // Task complete
        if (event.type === "agent_end") {
          child.kill("SIGTERM");
          opts.onDone(output);
        }
      } catch { /* not JSON */ }
    }
  });

  child.stderr.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.error(`  [pi] ${msg}`);
  });

  child.on("close", (code) => {
    if (code && code !== 0) {
      opts.onError(`pi exited with code ${code}`);
    }
  });

  // Send the prompt once pi is ready
  // Wait for the RPC ready signal, then send
  const readyCheck = setInterval(() => {
    try {
      child.stdin.write(JSON.stringify({ id: "ready-check", type: "get_state" }) + "\n");
    } catch { /* stdin closed */ clearInterval(readyCheck); }
  }, 1000);

  const originalOnEvent = opts.onEvent;
  let prompted = false;
  opts.onEvent = (event) => {
    if (!prompted && event.type === "response" && event.command === "get_state") {
      prompted = true;
      clearInterval(readyCheck);
      child.stdin.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");
    }
    originalOnEvent(event);
  };

  return child;
}

// =============================================================================
// Reef
// =============================================================================

export interface ReefConfig {
  agent?: { model?: string; systemPrompt?: string };
  server?: ServerOptions;
}

export async function createReef(config: ReefConfig = {}) {
  const { app: serviceApp, liveModules, events, ctx } = await createServer(config.server ?? {});

  const tree = new ConversationTree();
  if (!existsSync("data")) mkdirSync("data", { recursive: true });
  tree.persist("data/tree.json");

  const piProcesses = new Map<string, Task>();
  const sseClients = new Set<ReadableStreamDefaultController>();

  // Only add system prompt if tree is empty (fresh start)
  if (tree.size() === 0) {
    const systemPrompt = config.agent?.systemPrompt
      ?? process.env.REEF_SYSTEM_PROMPT
      ?? "You are a reef agent. You have tools to manage VMs, spawn swarms, deploy services, and store state. When given a task, decide the best approach — do it yourself, delegate to a swarm, or decompose it. You build your own tools.";
    const sysNode = tree.add(null, "system", systemPrompt);
    tree.setRef("main", sysNode.id);
  }

  function broadcast(event: any) {
    const data = JSON.stringify(event);
    for (const c of sseClients) {
      try { c.enqueue(`data: ${data}\n\n`); } catch { sseClients.delete(c); }
    }
  }

  // Track event parents — e.g. cron_done is child of cron_start
  const eventParents = new Map<string, string>(); // runId/groupKey → nodeId

  // Wire event bus → SSE + tree: every event is a node with a parent
  events.on('reef:event', (data: any) => {
    const { type, source, ...meta } = data;
    const content = meta.prompt || meta.jobName || meta.name || meta.error || type;

    let parentId: string | null = null;

    // Cron done/error are children of their cron_start
    if ((type === 'cron_done' || type === 'cron_error') && meta.runId) {
      parentId = eventParents.get(meta.runId) ?? null;
    }

    // If no specific parent, add as child of main's current node (sibling, not chain)
    let node: import("./tree.js").TreeNode;
    if (parentId) {
      node = tree.add(parentId, "event", content, { eventType: type, source, meta });
    } else {
      // Events are siblings under main — don't advance the ref
      const mainId = tree.getRef("main") ?? null;
      node = tree.add(mainId, "event", content, { eventType: type, source, meta });
    }

    // Track: cron_start becomes parent for its run
    if (type === 'cron_start' && meta.runId) {
      eventParents.set(meta.runId, node.id);
    }

    broadcast({ ...data, nodeId: node.id, parentId: node.parentId });
  });

  // ==========================================================================
  // Routes
  // ==========================================================================

  const reef = new Hono();
  const auth = bearerAuth();
  reef.use("*", async (c, next) => await auth(c, next));

  reef.post("/submit", async (c) => {
    const body = await c.req.json();
    const prompt = body.task;
    if (!prompt || typeof prompt !== "string") {
      return c.json({ error: "Missing 'task' string in body." }, 400);
    }

    const taskId = body.taskId || `task-${++taskCounter}-${Date.now()}`;
    const parentId = body.parentId ?? tree.getRef("main") ?? null;
    const continuing = !!body.parentId;

    // Create user node in the tree — either forking from main or continuing a conversation
    const userNode = continuing
      ? tree.add(parentId, "user", prompt) // reply to specific node
      : tree.startTask(taskId, prompt, parentId); // new task

    // If continuing, reopen the task and advance its ref
    if (continuing) {
      // Find which task owns this parentId
      const existingTask = body.taskId ? tree.getTask(body.taskId) : undefined;
      if (existingTask) {
        tree.reopenTask(taskId);
        tree.setRef(taskId, userNode.id);
      }
    }

    const task: Task = {
      id: taskId,
      prompt,
      status: "running",
      output: "",
      events: [],
      startedAt: Date.now(),
    };
    piProcesses.set(taskId, task);

    broadcast({ type: "branch_started", taskId, prompt, nodeId: userNode.id, parentId: userNode.parentId, continuing });

    // Build context: all ancestors of the user node
    const treeContext = tree.contextFor(userNode.id);

    // Track the last tool call for nesting results
    let lastToolNode: import("./tree.js").TreeNode | null = null;

    // Spawn fresh pi process
    spawnTask(prompt, treeContext, {
      model: config.agent?.model,
      onEvent(event) {
        task.events.push(event);
        if (task.events.length > 500) task.events.shift();

        // Tool calls are children of the user node (siblings of each other)
        if (event.type === 'tool_execution_start') {
          const toolNode = tree.add(userNode.id, "tool_call", event.toolName, {
            toolName: event.toolName, toolParams: event.args,
          });
          // Track this tool call so its result can be a child of it
          lastToolNode = toolNode;
          broadcast({ taskId, ...event, nodeId: toolNode.id, parentId: toolNode.parentId });
          return;
        }

        // Tool results are children of their tool_call
        if (event.type === 'tool_execution_end') {
          const parentToolId = lastToolNode?.id ?? userNode.id;
          const resultText = event.result?.content
            ?.filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('') || '';
          const resultNode = tree.add(parentToolId, "tool_result", resultText.slice(0, 1000), {
            toolCallId: event.toolCallId,
            result: event.result,
          });
          broadcast({ taskId, ...event, nodeId: resultNode.id, parentId: resultNode.parentId });
          return;
        }

        broadcast({ taskId, ...event });
      },
      onDone(output) {
        task.status = "done";
        task.output = output;
        task.completedAt = Date.now();

        // Assistant response is a child of the user node (sibling of tool calls)
        const assistantNode = tree.add(userNode.id, "assistant", output.trim());
        tree.setRef(taskId, assistantNode.id);
        tree.completeTask(taskId, { summary: output.trim().slice(0, 500), filesChanged: [] });

        broadcast({ taskId, type: "branch_done", summary: output.trim().slice(0, 200), nodeId: assistantNode.id, parentId: assistantNode.parentId });
      },
      onError(err) {
        task.status = "error";
        task.error = err;
        task.completedAt = Date.now();

        tree.failTask(taskId, err);
        broadcast({ taskId, type: "branch_error", error: err });
      },
    });

    return c.json({ id: taskId, status: "running", prompt, nodeId: userNode.id }, 202);
  });

  reef.get("/tasks", (c) => {
    const status = c.req.query("status");
    let list = tree.listTasks();
    if (status) list = list.filter(t => t.info.status === status);
    return c.json({
      tasks: list.map(t => ({
        name: t.name,
        ...t.info,
        leafId: t.leafId,
      })),
    });
  });

  reef.get("/tasks/:name", (c) => {
    const name = c.req.param("name");
    const info = tree.getTask(name);
    if (!info) return c.json({ error: "not found" }, 404);
    const leafId = tree.getRef(name);
    const path = leafId ? tree.ancestors(leafId) : [];
    return c.json({ name, ...info, leafId, nodes: path });
  });

  reef.get("/tree", (c) => c.json(tree.toJSON()));

  /** Get a node and its children. */
  reef.get("/tree/:id", (c) => {
    const node = tree.get(c.req.param("id"));
    if (!node) return c.json({ error: "not found" }, 404);
    const children = tree.children(node.id);
    return c.json({ node, children });
  });

  /** Get ancestors of a node (the conversation path). */
  reef.get("/tree/:id/path", (c) => {
    const node = tree.get(c.req.param("id"));
    if (!node) return c.json({ error: "not found" }, 404);
    return c.json({ path: tree.ancestors(node.id) });
  });

  reef.get("/state", (c) => {
    return c.json({
      mode: "agent",
      activeTasks: tree.activeTasks(),
      totalTasks: tree.tasks.size,
      totalNodes: tree.size(),
      services: Array.from(liveModules.keys()),
    });
  });

  // SSE heartbeat — keeps connections alive past Bun's idleTimeout
  setInterval(() => {
    for (const c of sseClients) {
      try { c.enqueue(`: ping\n\n`); } catch { sseClients.delete(c); }
    }
  }, 30_000);

  reef.get("/events", (c) => {
    const stream = new ReadableStream({
      start(controller) {
        sseClients.add(controller);
        controller.enqueue(`: connected\n\n`);
      },
      cancel(controller) { sseClients.delete(controller); },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Transfer-Encoding": "chunked",
      },
    });
  });

  const wrapper = new Hono();
  wrapper.route("/reef", reef);
  wrapper.route("/", serviceApp);

  return { app: wrapper, tree, piProcesses, liveModules, events, ctx, sseClients };
}

export async function startReef(config: ReefConfig = {}) {
  const { app, tree, piProcesses, liveModules, sseClients } = await createReef(config);
  const port = config.server?.port ?? parseInt(process.env.PORT ?? "3000", 10);

  console.log("  mode: agent");
  console.log("  services:");
  for (const mod of liveModules.values()) {
    if (mod.routes) console.log(`    /${mod.name} — ${mod.description || mod.name}`);
  }
  console.log(`    /reef — agent conversation + task submission`);

  const server = Bun.serve({ fetch: app.fetch, port, hostname: "::", idleTimeout: 120 });
  console.log(`\n  reef running on :${port}\n`);

  async function shutdown() {
    console.log("\n  shutting down...");
    for (const c of sseClients) { try { c.close(); } catch {} }
    for (const mod of liveModules.values()) {
      if (mod.store?.flush) mod.store.flush();
      if (mod.store?.close) await mod.store.close();
    }
    server.stop();
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return { app, server, tree, piProcesses, liveModules };
}











































