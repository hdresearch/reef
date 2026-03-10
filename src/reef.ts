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

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { Hono } from "hono";
import { bearerAuth } from "./core/auth.js";
import { createServer, type ServerOptions } from "./core/server.js";
import { ConversationTree } from "./tree.js";

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
  opts: {
    model?: string;
    onEvent: (event: any) => void;
    onDone: (output: string) => void;
    onError: (err: string) => void;
  },
): ChildProcess {
  const piPath = process.env.PI_PATH ?? "pi";
  const cwd = process.env.REEF_DIR ?? process.cwd();

  const child = spawn(piPath, ["--mode", "rpc", "--no-session", "--append-system-prompt", treeContext], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: {
      ...process.env,
      ...(opts.model ? { PI_MODEL: opts.model } : {}),
    },
  });

  let lineBuf = "";
  let output = "";
  let prompted = false;

  // Poll for pi readiness, then send the prompt
  const readyCheck = setInterval(() => {
    try {
      child.stdin.write(`${JSON.stringify({ id: "ready-check", type: "get_state" })}\n`);
    } catch {
      clearInterval(readyCheck);
    }
  }, 1000);

  function handleEvent(event: any) {
    // Wait for ready response before sending prompt
    if (!prompted && event.type === "response" && event.command === "get_state") {
      prompted = true;
      clearInterval(readyCheck);
      child.stdin.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);
    }

    opts.onEvent(event);

    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      output += event.assistantMessageEvent.delta;
    }

    if (event.type === "agent_end") {
      child.kill("SIGTERM");
      opts.onDone(output);
    }
  }

  child.stdout.on("data", (data: Buffer) => {
    lineBuf += data.toString();
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handleEvent(JSON.parse(line));
      } catch {
        /* not JSON */
      }
    }
  });

  child.stderr.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.error(`  [pi] ${msg}`);
  });

  child.on("error", (err) => {
    clearInterval(readyCheck);
    opts.onError(`Failed to spawn pi: ${err.message}`);
  });

  child.on("close", (code) => {
    clearInterval(readyCheck);
    if (code && code !== 0) opts.onError(`pi exited with code ${code}`);
  });

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
  const dataDir = process.env.REEF_DATA_DIR ?? "data";
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  tree.persist(`${dataDir}/tree.json`);

  const piProcesses = new Map<string, Task>();
  const sseClients = new Set<ReadableStreamDefaultController>();

  // Only add system prompt if tree is empty (fresh start)
  if (tree.size() === 0) {
    const systemPrompt =
      config.agent?.systemPrompt ??
      process.env.REEF_SYSTEM_PROMPT ??
      "You are a reef agent. You have tools to manage VMs, spawn swarms, deploy services, and store state. When given a task, decide the best approach — do it yourself, delegate to a swarm, or decompose it. You build your own tools.";
    const sysNode = tree.add(null, "system", systemPrompt);
    tree.setRef("main", sysNode.id);
  }

  function broadcast(event: any) {
    const data = JSON.stringify(event);
    for (const c of sseClients) {
      try {
        c.enqueue(`data: ${data}\n\n`);
      } catch {
        sseClients.delete(c);
      }
    }
  }

  // Track event parents — e.g. cron_done is child of cron_start
  const eventParents = new Map<string, string>(); // runId/groupKey → nodeId

  // Wire event bus → SSE + tree: every event is a node with a parent
  events.on("reef:event", (data: any) => {
    const { type, source, ...meta } = data;
    const content = meta.prompt || meta.jobName || meta.name || meta.error || type;

    let parentId: string | null = null;

    // Cron done/error are children of their cron_start
    if ((type === "cron_done" || type === "cron_error") && meta.runId) {
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
    if (type === "cron_start" && meta.runId) {
      eventParents.set(meta.runId, node.id);
    }

    broadcast({ ...data, nodeId: node.id, parentId: node.parentId });
  });

  // ==========================================================================
  // Task launcher — spawn pi and wire events to the tree
  // ==========================================================================

  function failTask(task: Task, taskId: string, error: string) {
    task.status = "error";
    task.error = error;
    task.completedAt = Date.now();
    tree.failTask(taskId, error);
    broadcast({ taskId, type: "task_error", error });
    tree.pruneToLimit();
  }

  function launchTask(task: Task, taskId: string, userNode: import("./tree.js").TreeNode, treeContext: string) {
    let lastToolNode: import("./tree.js").TreeNode | null = null;

    try {
      spawnTask(task.prompt, treeContext, {
        model: config.agent?.model,
        onEvent(event) {
          task.events.push(event);
          if (task.events.length > 500) task.events.shift();

          if (event.type === "tool_execution_start") {
            const toolNode = tree.add(userNode.id, "tool_call", event.toolName, {
              toolName: event.toolName,
              toolParams: event.args,
            });
            lastToolNode = toolNode;
            broadcast({ taskId, ...event, nodeId: toolNode.id, parentId: toolNode.parentId });
            return;
          }

          if (event.type === "tool_execution_end") {
            const parentToolId = lastToolNode?.id ?? userNode.id;
            const resultText =
              event.result?.content
                ?.filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("") || "";
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

          const assistantNode = tree.add(userNode.id, "assistant", output.trim());
          tree.setRef(taskId, assistantNode.id);
          tree.completeTask(taskId, { summary: output.trim().slice(0, 500), filesChanged: [] });

          broadcast({
            taskId,
            type: "task_done",
            summary: output.trim().slice(0, 200),
            nodeId: assistantNode.id,
            parentId: assistantNode.parentId,
          });

          tree.pruneToLimit();
        },
        onError(err) {
          failTask(task, taskId, err);
        },
      });
    } catch (err: any) {
      failTask(task, taskId, err.message);
    }
  }

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

    broadcast({ type: "task_started", taskId, prompt, nodeId: userNode.id, parentId: userNode.parentId, continuing });
    launchTask(task, taskId, userNode, tree.contextFor(userNode.id));

    return c.json({ id: taskId, status: "running", prompt, nodeId: userNode.id }, 202);
  });

  reef.get("/tasks", (c) => {
    const status = c.req.query("status");
    let list = tree.listTasks();
    if (status) list = list.filter((t) => t.info.status === status);
    return c.json({
      tasks: list.map((t) => ({
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
      try {
        c.enqueue(`: ping\n\n`);
      } catch {
        sseClients.delete(c);
      }
    }
  }, 30_000);

  reef.get("/events", (_c) => {
    const stream = new ReadableStream({
      start(controller) {
        sseClients.add(controller);
        controller.enqueue(`: connected\n\n`);
      },
      cancel(controller) {
        sseClients.delete(controller);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
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
  // Bun version guard
  const MIN_BUN = "1.2.0";
  const bunVersion = typeof Bun !== "undefined" ? Bun.version : undefined;
  if (!bunVersion) {
    console.error("  reef requires Bun. Install it: https://bun.sh");
    process.exit(1);
  }
  const [major, minor, patch] = bunVersion.split(".").map(Number);
  const [minMajor, minMinor, minPatch] = MIN_BUN.split(".").map(Number);
  if (
    major < minMajor ||
    (major === minMajor && minor < minMinor) ||
    (major === minMajor && minor === minMinor && patch < minPatch)
  ) {
    console.error(`  reef requires Bun >= ${MIN_BUN} (you have ${bunVersion}). Run: bun upgrade`);
    process.exit(1);
  }

  const { app, tree, piProcesses, liveModules, sseClients } = await createReef(config);
  const port = config.server?.port ?? parseInt(process.env.PORT ?? "4200", 10);

  // Port conflict detection
  try {
    const test = Bun.serve({ fetch: () => new Response(), port, hostname: "::" });
    test.stop();
  } catch (e: any) {
    if (e?.code === "EADDRINUSE" || e?.message?.includes("address already in use")) {
      console.error(`\n  Port ${port} is already in use.`);
      console.error(`  Try: PORT=${port + 1} bun run start\n`);
      process.exit(1);
    }
    // Other errors — let Bun.serve below handle it
  }

  console.log("\n  🐚 reef\n");
  console.log("  services:");
  for (const mod of liveModules.values()) {
    if (mod.routes) console.log(`    /${mod.name} — ${mod.description || mod.name}`);
  }
  console.log(`    /reef — agent conversation + task submission`);

  const server = Bun.serve({ fetch: app.fetch, port, hostname: "::", idleTimeout: 120 });

  console.log();
  console.log(`  Dashboard  http://localhost:${port}/ui`);
  console.log(`  API docs   http://localhost:${port}/docs`);
  console.log(`  Health     http://localhost:${port}/health`);
  console.log(`\n  reef running on :${port}\n`);

  async function shutdown() {
    console.log("\n  shutting down...");
    for (const c of sseClients) {
      try {
        c.close();
      } catch {}
    }
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
