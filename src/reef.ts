/**
 * Reef — an agent with a server.
 *
 * The agent (pi) is the core. The HTTP server feeds events into it.
 * The conversation tree is the agent's memory.
 *
 * When a task arrives via POST /reef/submit, it becomes a message to pi.
 * Pi decides what to do — build it directly, spawn a swarm, decompose,
 * whatever. We don't write orchestration code. The agent orchestrates itself.
 *
 * Routes:
 *   POST /reef/submit  — send a task to the agent
 *   GET  /reef/tree     — the agent's conversation history
 *   GET  /reef/state    — current status
 *   GET  /reef/events   — SSE stream of agent events
 */

import { Hono } from "hono";
import { spawn } from "node:child_process";
import { createServer, type ServerOptions } from "./core/server.js";
import { ConversationTree, type TreeNode } from "./tree.js";
import { bearerAuth } from "./core/auth.js";

// =============================================================================
// Pi RPC — communicate with the agent
// =============================================================================

interface PiRpc {
  send(cmd: object): void;
  onEvent(handler: (event: any) => void): void;
  kill(): Promise<void>;
}

/**
 * Start pi in RPC mode. Returns a handle to send commands and receive events.
 */
function startPiRpc(opts: { model?: string }): PiRpc {
  const piPath = process.env.PI_PATH ?? "pi";
  const model = opts.model ?? process.env.PI_MODEL ?? "claude-sonnet-4-20250514";

  const child = spawn(piPath, ["--mode", "rpc", "--no-session"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_MODEL: model },
  });

  let eventHandler: ((event: any) => void) | undefined;
  let lineBuf = "";

  child.stdout.on("data", (data: Buffer) => {
    lineBuf += data.toString();
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (eventHandler) eventHandler(event);
      } catch { /* not JSON */ }
    }
  });

  child.stderr.on("data", (data: Buffer) => {
    // Pi stderr — log but don't crash
    const msg = data.toString().trim();
    if (msg) console.error(`  [pi] ${msg}`);
  });

  return {
    send(cmd: object) {
      child.stdin.write(JSON.stringify(cmd) + "\n");
    },
    onEvent(handler) {
      eventHandler = handler;
    },
    async kill() {
      child.kill("SIGTERM");
    },
  };
}

// =============================================================================
// Reef
// =============================================================================

export interface ReefConfig {
  agent?: {
    model?: string;
    systemPrompt?: string;
  };
  server?: ServerOptions;
}

export async function createReef(config: ReefConfig = {}) {
  const { app: serviceApp, liveModules, events, ctx } = await createServer(config.server ?? {});

  const tree = new ConversationTree();
  const sseClients = new Set<ReadableStreamDefaultController>();

  // Initialize tree with system prompt
  const systemPrompt = config.agent?.systemPrompt
    ?? process.env.REEF_SYSTEM_PROMPT
    ?? "You are a reef agent. You have tools to manage VMs, spawn swarms, deploy services, and store state. When given a task, decide the best approach — do it yourself, delegate to a swarm, or decompose it. You build your own tools.";
  tree.append("system", systemPrompt);

  // Start pi RPC (if we have an API key)
  let rpc: PiRpc | null = null;
  let agentBusy = false;
  let lastAgentOutput = "";

  if (process.env.ANTHROPIC_API_KEY) {
    rpc = startPiRpc({ model: config.agent?.model });

    rpc.onEvent((event) => {
      // Broadcast to SSE clients
      const data = JSON.stringify(event);
      for (const controller of sseClients) {
        try { controller.enqueue(`data: ${data}\n\n`); } catch { sseClients.delete(controller); }
      }

      // Track agent state
      if (event.type === "agent_start") {
        agentBusy = true;
        lastAgentOutput = "";
      } else if (event.type === "agent_end") {
        agentBusy = false;
        // Append the agent's response to the tree
        if (lastAgentOutput.trim()) {
          tree.append("assistant", lastAgentOutput.trim());
        }
      } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        lastAgentOutput += event.assistantMessageEvent.delta;
      }
    });
  }

  // ==========================================================================
  // Routes
  // ==========================================================================

  const reef = new Hono();
  const auth = bearerAuth();
  reef.use("*", async (c, next) => await auth(c, next));

  // POST /reef/submit — send a task to the agent
  reef.post("/submit", async (c) => {
    if (!rpc) {
      return c.json({ error: "Agent not running. Set ANTHROPIC_API_KEY." }, 503);
    }
    if (agentBusy) {
      return c.json({ error: "Agent is busy. Wait for current task to complete." }, 429);
    }

    const body = await c.req.json();
    const task = body.task;
    if (!task || typeof task !== "string") {
      return c.json({ error: "Missing 'task' string in body." }, 400);
    }

    // Append to tree and send to pi
    tree.append("user", task);
    rpc.send({ type: "prompt", message: task });

    return c.json({ status: "submitted", task }, 202);
  });

  // GET /reef/tree — conversation history
  reef.get("/tree", (c) => {
    return c.json({ main: tree.mainHistory() });
  });

  // GET /reef/state
  reef.get("/state", (c) => {
    return c.json({
      mode: rpc ? "agent" : "service-only",
      agentBusy,
      conversationLength: tree.main.length,
      services: Array.from(liveModules.keys()),
    });
  });

  // GET /reef/events — SSE
  reef.get("/events", (c) => {
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
        "Connection": "keep-alive",
        "Transfer-Encoding": "chunked",
      },
    });
  });

  // Mount reef before service dispatch
  const wrapper = new Hono();
  wrapper.route("/reef", reef);
  wrapper.route("/", serviceApp);

  return { app: wrapper, rpc, tree, liveModules, events, ctx, sseClients };
}

export async function startReef(config: ReefConfig = {}) {
  const { app, rpc, tree, liveModules, sseClients } = await createReef(config);
  const port = config.server?.port ?? parseInt(process.env.PORT ?? "3000", 10);

  const mode = rpc ? "agent" : "service-only";
  console.log(`  mode: ${mode}`);

  console.log("  services:");
  for (const mod of liveModules.values()) {
    if (mod.routes) console.log(`    /${mod.name} — ${mod.description || mod.name}`);
  }
  console.log(`    /reef — agent conversation + task submission`);

  const server = Bun.serve({ fetch: app.fetch, port, hostname: "::" });
  console.log(`\n  reef running on :${port}\n`);

  async function shutdown() {
    console.log("\n  shutting down...");
    if (rpc) await rpc.kill();
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

  return { app, server, rpc, tree, liveModules };
}
