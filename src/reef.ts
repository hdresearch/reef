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
import { createServer, type ServerOptions } from "./core/server.js";
import { ConversationTree } from "./tree.js";
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
  const tasks = new Map<string, Task>();
  const sseClients = new Set<ReadableStreamDefaultController>();

  const systemPrompt = config.agent?.systemPrompt
    ?? process.env.REEF_SYSTEM_PROMPT
    ?? "You are a reef agent. You have tools to manage VMs, spawn swarms, deploy services, and store state. When given a task, decide the best approach — do it yourself, delegate to a swarm, or decompose it. You build your own tools.";
  tree.append("system", systemPrompt);

  function broadcast(event: any) {
    const data = JSON.stringify(event);
    for (const c of sseClients) {
      try { c.enqueue(`data: ${data}\n\n`); } catch { sseClients.delete(c); }
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

    const id = `task-${++taskCounter}-${Date.now()}`;
    const task: Task = {
      id,
      prompt,
      status: "running",
      output: "",
      events: [],
      startedAt: Date.now(),
    };
    tasks.set(id, task);

    // Append user message to tree
    tree.append("user", prompt);

    // Build context from tree history
    const treeContext = tree.mainHistory()
      .map((n) => `[${n.role}] ${n.content}`)
      .join("\n\n");

    // Spawn fresh pi process
    spawnTask(prompt, treeContext, {
      model: config.agent?.model,
      onEvent(event) {
        task.events.push(event);
        if (task.events.length > 500) task.events.shift();
        broadcast({ taskId: id, ...event });
      },
      onDone(output) {
        task.status = "done";
        task.output = output;
        task.completedAt = Date.now();
        tree.append("assistant", output.trim());
        broadcast({ taskId: id, type: "task_done" });
      },
      onError(err) {
        task.status = "error";
        task.error = err;
        task.completedAt = Date.now();
        tree.append("assistant", `Error: ${err}`);
        broadcast({ taskId: id, type: "task_error", error: err });
      },
    });

    return c.json({ id, status: "running", prompt }, 202);
  });

  reef.get("/tasks", (c) => {
    const list = [...tasks.values()].map((t) => ({
      id: t.id, prompt: t.prompt, status: t.status,
      startedAt: t.startedAt, completedAt: t.completedAt,
      outputLength: t.output.length, error: t.error,
    }));
    return c.json({ tasks: list });
  });

  reef.get("/tasks/:id", (c) => {
    const task = tasks.get(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json(task);
  });

  reef.get("/tree", (c) => c.json({ main: tree.mainHistory() }));

  reef.get("/state", (c) => {
    const active = [...tasks.values()].filter((t) => t.status === "running").length;
    return c.json({
      mode: "agent",
      activeTasks: active,
      totalTasks: tasks.size,
      conversationLength: tree.main.length,
      services: Array.from(liveModules.keys()),
    });
  });

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

  return { app: wrapper, tree, tasks, liveModules, events, ctx, sseClients };
}

export async function startReef(config: ReefConfig = {}) {
  const { app, tree, tasks, liveModules, sseClients } = await createReef(config);
  const port = config.server?.port ?? parseInt(process.env.PORT ?? "3000", 10);

  console.log("  mode: agent");
  console.log("  services:");
  for (const mod of liveModules.values()) {
    if (mod.routes) console.log(`    /${mod.name} — ${mod.description || mod.name}`);
  }
  console.log(`    /reef — agent conversation + task submission`);

  const server = Bun.serve({ fetch: app.fetch, port, hostname: "::" });
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

  return { app, server, tree, tasks, liveModules };
}
