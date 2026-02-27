/**
 * Agent service — run tasks and interactive sessions using pi.
 *
 * Fire-and-forget tasks (automation):
 *   POST   /agent/tasks              — submit a task (spawns pi -p)
 *   GET    /agent/tasks              — list runs
 *   GET    /agent/tasks/:id          — get run status + output
 *   POST   /agent/tasks/:id/cancel   — cancel a running task
 *
 * Interactive sessions (chat):
 *   POST   /agent/sessions           — start a session (spawns pi --mode rpc)
 *   GET    /agent/sessions           — list sessions
 *   GET    /agent/sessions/:id/events — SSE stream of pi events
 *   POST   /agent/sessions/:id/message — send a message
 *   POST   /agent/sessions/:id/abort — abort current operation
 *   DELETE /agent/sessions/:id       — end session
 *
 * The UI service (examples/services/ui) provides the chat web interface.
 *
 * Config (env vars):
 *   PI_PATH        — path to pi binary (default: "pi")
 *   PI_MODEL       — model to use (default: "claude-sonnet-4-20250514")
 *   PI_PROVIDER    — provider (default: "anthropic")
 */

import { Hono } from "hono";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { ulid } from "ulid";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ServiceModule, ServiceContext } from "../src/core/types.js";

let ctx: ServiceContext;
let piAvailable = false;

// =============================================================================
// Shared config
// =============================================================================

function piPath(): string {
  return process.env.PI_PATH || "pi";
}
function piModel(): string {
  return process.env.PI_MODEL || "claude-sonnet-4-20250514";
}
function piProvider(): string {
  return process.env.PI_PROVIDER || "anthropic";
}
function serverPort(): number {
  return parseInt(process.env.PORT || "3000", 10);
}

// =============================================================================
// Fire-and-forget tasks
// =============================================================================

interface Run {
  id: string;
  task: string;
  status: "running" | "done" | "error" | "cancelled";
  output: string;
  pid?: number;
  createdAt: string;
  finishedAt?: string;
  exitCode?: number | null;
}

const runs = new Map<string, Run>();
const taskProcesses = new Map<string, ChildProcess>();

function buildSystemAppend(projectRoot: string, port: number): string {
  const lines: string[] = [];
  lines.push(`You are working inside a reef server (running on localhost:${port}).`);
  lines.push(`Project root: ${projectRoot}`);
  lines.push("");
  lines.push("## Reef conventions");
  lines.push("- Service modules go in services/<name>/index.ts");
  lines.push("- Each module default-exports a ServiceModule (see src/core/types.ts)");
  lines.push("- After writing a service, reload it:");
  lines.push(
    `  curl -X POST localhost:${port}/services/reload/<name> -H "Authorization: Bearer $VERS_AUTH_TOKEN"`,
  );
  lines.push("- Example services are in examples/services/");
  lines.push("");

  const skillPath = join(projectRoot, "skills/create-service/SKILL.md");
  if (existsSync(skillPath)) {
    lines.push("## Create-service skill reference");
    lines.push("");
    lines.push(readFileSync(skillPath, "utf-8"));
  }

  return lines.join("\n");
}

/** Discover all extension paths: src/extension.ts + extensions/*.ts */
function discoverExtensions(projectRoot: string): string[] {
  const paths: string[] = [];

  // Main reef extension (service module tools)
  const mainExt = join(projectRoot, "src", "extension.ts");
  if (existsSync(mainExt)) paths.push(mainExt);

  // Additional extensions (vers-vm, etc.)
  const extDir = join(projectRoot, "extensions");
  if (existsSync(extDir)) {
    try {
      for (const f of readdirSync(extDir)) {
        if (f.endsWith(".ts") && !f.endsWith(".test.ts")) {
          paths.push(join(extDir, f));
        }
      }
    } catch {}
  }

  return paths;
}

function spawnTask(run: Run, projectRoot: string, port: number): ChildProcess {
  const contextText = buildSystemAppend(projectRoot, port);
  const extensionArgs = discoverExtensions(projectRoot).flatMap((p) => ["--extension", p]);
  const args = [
    "-p",
    "--no-session",
    "--provider", piProvider(),
    "--model", piModel(),
    "--append-system-prompt", contextText,
    ...extensionArgs,
    run.task,
  ];

  const child = spawn(piPath(), args, {
    cwd: projectRoot,
    env: { ...process.env, VERS_AUTH_TOKEN: process.env.VERS_AUTH_TOKEN || "" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    run.output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    run.output += chunk.toString();
  });

  child.on("close", (code) => {
    run.exitCode = code;
    run.finishedAt = new Date().toISOString();
    if (run.status !== "cancelled") {
      run.status = code === 0 ? "done" : "error";
    }
    taskProcesses.delete(run.id);
  });

  child.on("error", (err) => {
    run.output += `\nProcess error: ${err.message}`;
    run.status = "error";
    run.finishedAt = new Date().toISOString();
    taskProcesses.delete(run.id);
  });

  return child;
}

// =============================================================================
// Interactive sessions (pi RPC mode)
// =============================================================================

interface Session {
  id: string;
  process: ChildProcess;
  rl: ReadlineInterface;
  sseClients: Set<ReadableStreamDefaultController<Uint8Array>>;
  status: "active" | "closed";
  createdAt: string;
  model: string;
  provider: string;
  recentEvents: string[];
}

const sessions = new Map<string, Session>();
const MAX_RECENT_EVENTS = 200;

function spawnSession(id: string): Session {
  const projectRoot = process.cwd();
  const contextText = buildSystemAppend(projectRoot, serverPort());
  const extensionArgs = discoverExtensions(projectRoot).flatMap((p) => ["--extension", p]);

  const args = [
    "--mode", "rpc",
    "--no-session",
    "--provider", piProvider(),
    "--model", piModel(),
    "--append-system-prompt", contextText,
    ...extensionArgs,
  ];

  const child = spawn(piPath(), args, {
    cwd: projectRoot,
    env: { ...process.env, VERS_AUTH_TOKEN: process.env.VERS_AUTH_TOKEN || "" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const session: Session = {
    id,
    process: child,
    rl: createInterface({ input: child.stdout! }),
    sseClients: new Set(),
    status: "active",
    createdAt: new Date().toISOString(),
    model: piModel(),
    provider: piProvider(),
    recentEvents: [],
  };

  session.rl.on("line", (line) => {
    try {
      JSON.parse(line);
      const sseData = `data: ${line}\n\n`;
      const encoded = new TextEncoder().encode(sseData);
      for (const controller of session.sseClients) {
        try {
          controller.enqueue(encoded);
        } catch {
          session.sseClients.delete(controller);
        }
      }
      session.recentEvents.push(line);
      if (session.recentEvents.length > MAX_RECENT_EVENTS) {
        session.recentEvents.shift();
      }
    } catch {}
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.log(`  [agent] session ${id} stderr: ${text}`);
  });

  child.on("close", () => {
    session.status = "closed";
    for (const controller of session.sseClients) {
      try { controller.close(); } catch {}
    }
    session.sseClients.clear();
  });

  return session;
}

function sendToSession(session: Session, command: Record<string, unknown>): boolean {
  if (session.status !== "active" || !session.process.stdin?.writable) return false;
  session.process.stdin.write(JSON.stringify(command) + "\n");
  return true;
}

function endSession(session: Session): void {
  session.status = "closed";
  session.process.kill("SIGTERM");
  setTimeout(() => {
    try { session.process.kill("SIGKILL"); } catch {}
  }, 3000);
  for (const controller of session.sseClients) {
    try { controller.close(); } catch {}
  }
  session.sseClients.clear();
}

// =============================================================================
// Routes
// =============================================================================

const routes = new Hono();

// ---------------------------------------------------------------------------
// Tasks (fire-and-forget)
// ---------------------------------------------------------------------------

routes.post("/tasks", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const task = (body.task as string)?.trim();

  if (!task) return c.json({ error: "task is required" }, 400);
  if (!piAvailable) return c.json({ error: `pi not found at "${piPath()}". Set PI_PATH env var.` }, 500);

  const id = ulid();
  const run: Run = { id, task, status: "running", output: "", createdAt: new Date().toISOString() };
  runs.set(id, run);

  const child = spawnTask(run, process.cwd(), serverPort());
  run.pid = child.pid;
  taskProcesses.set(id, child);

  console.log(`  [agent] task ${id}: ${task.slice(0, 80)}${task.length > 80 ? "..." : ""}`);
  return c.json({ id, status: run.status, task, createdAt: run.createdAt }, 201);
});

routes.get("/tasks", (c) => {
  const items = Array.from(runs.values())
    .map(({ id, task, status, createdAt, finishedAt }) => ({ id, task, status, createdAt, finishedAt }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return c.json({ runs: items, count: items.length });
});

routes.get("/tasks/:id", (c) => {
  const run = runs.get(c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);

  const tail = parseInt(c.req.query("tail") || "0", 10);
  const output = tail > 0 ? run.output.slice(-tail) : run.output;
  return c.json({ ...run, output, outputLength: run.output.length });
});

routes.post("/tasks/:id/cancel", (c) => {
  const run = runs.get(c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  if (run.status !== "running") return c.json({ error: `run is already ${run.status}` }, 400);

  const child = taskProcesses.get(run.id);
  if (child) {
    child.kill("SIGTERM");
    setTimeout(() => { if (taskProcesses.has(run.id)) child.kill("SIGKILL"); }, 5000);
  }
  run.status = "cancelled";
  run.finishedAt = new Date().toISOString();
  console.log(`  [agent] cancelled task ${run.id}`);
  return c.json({ id: run.id, status: "cancelled" });
});

// ---------------------------------------------------------------------------
// Sessions (interactive chat via pi RPC)
// ---------------------------------------------------------------------------

routes.post("/sessions", (c) => {
  if (!piAvailable) return c.json({ error: `pi not found at "${piPath()}". Set PI_PATH env var.` }, 500);

  const id = ulid();
  const session = spawnSession(id);
  sessions.set(id, session);

  console.log(`  [agent] session ${id} started`);
  return c.json({ id, status: session.status, createdAt: session.createdAt, model: session.model }, 201);
});

routes.get("/sessions", (c) => {
  const items = Array.from(sessions.values()).map(({ id, status, createdAt, model }) => ({
    id, status, createdAt, model,
  }));
  return c.json({ sessions: items, count: items.length });
});

routes.get("/sessions/:id/events", (c) => {
  const session = sessions.get(c.req.param("id"));
  if (!session) return c.json({ error: "session not found" }, 404);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const evt of session.recentEvents) {
        controller.enqueue(new TextEncoder().encode(`data: ${evt}\n\n`));
      }
      session.sseClients.add(controller);
    },
    cancel(controller) {
      session.sseClients.delete(controller);
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

routes.post("/sessions/:id/message", async (c) => {
  const session = sessions.get(c.req.param("id"));
  if (!session) return c.json({ error: "session not found" }, 404);
  if (session.status !== "active") return c.json({ error: "session is closed" }, 400);

  const body = await c.req.json().catch(() => ({}));
  const message = (body.message as string)?.trim();
  if (!message) return c.json({ error: "message is required" }, 400);

  const streamingBehavior = body.streamingBehavior as string | undefined;
  const command: Record<string, unknown> = { type: "prompt", message };
  if (streamingBehavior) command.streamingBehavior = streamingBehavior;

  const ok = sendToSession(session, command);
  if (!ok) return c.json({ error: "failed to send to pi process" }, 500);

  return c.json({ ok: true });
});

routes.post("/sessions/:id/abort", (c) => {
  const session = sessions.get(c.req.param("id"));
  if (!session) return c.json({ error: "session not found" }, 404);

  sendToSession(session, { type: "abort" });
  return c.json({ ok: true });
});

routes.delete("/sessions/:id", (c) => {
  const session = sessions.get(c.req.param("id"));
  if (!session) return c.json({ error: "session not found" }, 404);

  endSession(session);
  console.log(`  [agent] session ${session.id} ended`);
  return c.json({ id: session.id, status: "closed" });
});

// =============================================================================
// Module
// =============================================================================

const agent: ServiceModule = {
  name: "agent",
  description: "Run tasks and interactive sessions using pi",
  routes,

  init(serviceCtx: ServiceContext) {
    ctx = serviceCtx;
    try {
      execSync(`${piPath()} --help`, { stdio: "ignore", timeout: 5000 });
      piAvailable = true;
      console.log(`  [agent] pi found at "${piPath()}"`);
    } catch {
      console.warn(`  [agent] pi not found at "${piPath()}" — set PI_PATH env var`);
    }
  },

  routeDocs: {
    "POST /tasks": {
      summary: "Submit a fire-and-forget task",
      detail: "Spawns pi in print mode. Returns immediately with a run ID.",
      body: { task: { type: "string", required: true, description: "What to do" } },
      response: "{ id, status, task, createdAt }",
    },
    "GET /tasks": {
      summary: "List all task runs",
      response: "{ runs: [...], count }",
    },
    "GET /tasks/:id": {
      summary: "Get task run status and output",
      params: { id: { type: "string", required: true, description: "Run ID" } },
      query: { tail: { type: "number", description: "Last N chars of output" } },
      response: "{ id, task, status, output, outputLength, ... }",
    },
    "POST /tasks/:id/cancel": {
      summary: "Cancel a running task",
      params: { id: { type: "string", required: true, description: "Run ID" } },
      response: "{ id, status: 'cancelled' }",
    },
    "POST /sessions": {
      summary: "Start an interactive chat session",
      detail: "Spawns pi in RPC mode. Connect to /sessions/:id/events for SSE stream.",
      response: "{ id, status, createdAt, model }",
    },
    "GET /sessions": {
      summary: "List all sessions",
      response: "{ sessions: [...], count }",
    },
    "GET /sessions/:id/events": {
      summary: "SSE stream of pi events",
      params: { id: { type: "string", required: true, description: "Session ID" } },
      response: "text/event-stream",
    },
    "POST /sessions/:id/message": {
      summary: "Send a message to a session",
      params: { id: { type: "string", required: true, description: "Session ID" } },
      body: {
        message: { type: "string", required: true, description: "Message text" },
        streamingBehavior: { type: "string", description: "'steer' or 'followUp' (if agent is mid-response)" },
      },
      response: "{ ok: true }",
    },
    "POST /sessions/:id/abort": {
      summary: "Abort current operation in a session",
      params: { id: { type: "string", required: true, description: "Session ID" } },
      response: "{ ok: true }",
    },
    "DELETE /sessions/:id": {
      summary: "End a session",
      params: { id: { type: "string", required: true, description: "Session ID" } },
      response: "{ id, status: 'closed' }",
    },
  },

  // Seed capabilities this service provides to the substrate
  capabilities: [
    "agent.spawn",              // POST /agent/tasks spawns pi processes
    "agent.spawn.concurrent",   // multiple tasks can run simultaneously
    "agent.communicate",        // POST /agent/sessions/:id/message
    "agent.communicate.streaming", // GET /agent/sessions/:id/events (SSE)
    "agent.communicate.bidirectional", // send messages to running sessions
    "agent.lifecycle",          // list, cancel, abort, delete
  ],
};

export default agent;
