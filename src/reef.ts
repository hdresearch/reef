/**
 * Reef — an agent with a server, not a server with an agent.
 *
 * This is the unified entry point. It starts:
 *   1. The conversation tree + agent loop (the brain)
 *   2. The service module system (the organs)
 *   3. A Hono server that exposes both (the nervous system)
 *
 * HTTP requests can trigger branch execution. Services provide capabilities.
 * The agent loop is the core — everything else feeds into it.
 *
 * Routes:
 *   POST /reef/submit        — submit a task, forks a branch
 *   GET  /reef/tree           — main's conversation history
 *   GET  /reef/branches       — all branches and their status
 *   GET  /reef/branches/:name — specific branch detail
 *   GET  /reef/state          — overall loop state
 *   GET  /reef/events         — SSE stream of agent events
 *
 * Plus all existing service module routes (/{service}/...).
 */

import { Hono } from "hono";
import { createServer, type ServerOptions } from "./core/server.js";
import { AgentLoop, type AgentLoopConfig, type AgentEvent } from "./loop.js";
import { bearerAuth } from "./core/auth.js";

// =============================================================================
// Types
// =============================================================================

export interface ReefConfig {
  /** Agent loop config — if omitted, reef runs in service-only mode. */
  agent?: {
    commitId: string;
    anthropicApiKey: string;
    model?: string;
    systemPrompt?: string;
    maxConcurrent?: number;
    branchTimeoutMs?: number;
    vers?: { apiKey?: string; baseUrl?: string };
  };

  /** Server options (services dir, port, etc.) */
  server?: ServerOptions;
}

// =============================================================================
// Reef
// =============================================================================

export async function createReef(config: ReefConfig = {}) {
  // Start the service module system
  const { app: serviceApp, liveModules, events, ctx } = await createServer(config.server ?? {});

  // Agent loop (optional — reef can run without it for pure service mode)
  let loop: AgentLoop | null = null;
  const sseClients = new Set<ReadableStreamDefaultController>();

  if (config.agent) {
    const workspaceDir = config.server?.servicesDir ?? process.env.SERVICES_DIR ?? "./services";

    loop = new AgentLoop({
      ...config.agent,
      workspaceDir,
      onEvent: (event) => {
        // Broadcast to SSE clients
        const data = JSON.stringify(event);
        for (const controller of sseClients) {
          try {
            controller.enqueue(`data: ${data}\n\n`);
          } catch {
            sseClients.delete(controller);
          }
        }
      },
    });
    loop.start();
  }

  // ==========================================================================
  // Agent routes (mounted on the service app)
  // ==========================================================================

  const reef = new Hono();
  const auth = bearerAuth();

  // All reef routes require auth
  reef.use("*", async (c, next) => {
    const result = await auth(c, next);
    return result;
  });

  // POST /reef/submit — submit a task, fork a branch
  reef.post("/submit", async (c) => {
    if (!loop) {
      return c.json({ error: "Agent loop not configured. Set VERS_COMMIT_ID and ANTHROPIC_API_KEY." }, 503);
    }

    const body = await c.req.json();
    const task = body.task;
    const name = body.name;

    if (!task || typeof task !== "string") {
      return c.json({ error: "Missing 'task' string in body." }, 400);
    }

    try {
      const branchName = loop.submit(task, { name });
      const branch = loop.tree.getBranch(branchName);
      return c.json({
        branch: branchName,
        status: branch.status,
        trigger: branch.trigger,
        forkPoint: branch.forkPoint,
      }, 201);
    } catch (e: any) {
      return c.json({ error: e.message }, 429); // likely max concurrent
    }
  });

  // GET /reef/tree — main's conversation history
  reef.get("/tree", (c) => {
    if (!loop) return c.json({ main: [] });
    return c.json({ main: loop.history() });
  });

  // GET /reef/branches — all branches
  reef.get("/branches", (c) => {
    if (!loop) return c.json({ branches: [] });
    const branches = loop.tree.listBranches().map((b) => ({
      name: b.name,
      status: b.status,
      trigger: b.trigger,
      forkPoint: b.forkPoint,
      vmId: b.vmId,
      createdAt: b.createdAt,
      startedAt: b.startedAt,
      completedAt: b.completedAt,
      artifacts: b.artifacts,
    }));
    return c.json({ branches });
  });

  // GET /reef/branches/:name — specific branch
  reef.get("/branches/:name", (c) => {
    if (!loop) return c.json({ error: "Agent loop not configured." }, 503);
    try {
      const branch = loop.tree.getBranch(c.req.param("name"));
      return c.json({
        name: branch.name,
        status: branch.status,
        trigger: branch.trigger,
        forkPoint: branch.forkPoint,
        vmId: branch.vmId,
        nodes: branch.nodes,
        artifacts: branch.artifacts,
        createdAt: branch.createdAt,
        startedAt: branch.startedAt,
        completedAt: branch.completedAt,
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 404);
    }
  });

  // GET /reef/state — overall loop state
  reef.get("/state", (c) => {
    if (!loop) {
      return c.json({
        mode: "service-only",
        services: Array.from(liveModules.keys()),
      });
    }
    return c.json({
      mode: "agent",
      ...loop.state(),
      services: Array.from(liveModules.keys()),
    });
  });

  // GET /reef/events — SSE stream
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

  // Mount reef routes BEFORE service dispatch (which uses catch-all /:service/*)
  // We need to insert our routes directly into the app before the catch-all.
  // Since createServer already registered the catch-all, we create a wrapper.
  const wrapper = new Hono();

  // Reef routes first
  wrapper.route("/reef", reef);

  // Then everything from the service app (health, root-mounted modules, dispatch)
  wrapper.route("/", serviceApp);

  return { app: wrapper, loop, liveModules, events, ctx, sseClients };
}

// =============================================================================
// Start — the new entry point
// =============================================================================

export async function startReef(config: ReefConfig = {}) {
  // Auto-configure from environment
  if (!config.agent && process.env.VERS_COMMIT_ID && process.env.ANTHROPIC_API_KEY) {
    config.agent = {
      commitId: process.env.VERS_COMMIT_ID,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.PI_MODEL,
      systemPrompt: process.env.REEF_SYSTEM_PROMPT ?? "You are a reef agent. You build, test, and deploy services.",
      maxConcurrent: parseInt(process.env.REEF_MAX_CONCURRENT ?? "5", 10),
      vers: {
        apiKey: process.env.VERS_API_KEY,
        baseUrl: process.env.VERS_BASE_URL,
      },
    };
  }

  const { app, loop, liveModules, sseClients } = await createReef(config);
  const port = config.server?.port ?? parseInt(process.env.PORT ?? "3000", 10);

  const mode = loop ? "agent" : "service-only";
  console.log(`  mode: ${mode}`);

  if (loop) {
    console.log(`  commit: ${config.agent!.commitId}`);
    console.log(`  model: ${config.agent!.model ?? "claude-sonnet-4-20250514"}`);
    console.log(`  max concurrent: ${config.agent!.maxConcurrent ?? 5}`);
  }

  console.log("  services:");
  for (const mod of liveModules.values()) {
    if (mod.routes) {
      console.log(`    /${mod.name} — ${mod.description || mod.name}`);
    }
  }
  console.log(`    /reef — conversation tree + branch management`);

  const server = Bun.serve({
    fetch: app.fetch,
    port,
    hostname: "::",
  });

  console.log(`\n  reef running on :${port}\n`);

  async function shutdown() {
    console.log("\n  shutting down...");
    if (loop) loop.stop();
    for (const controller of sseClients) {
      try { controller.close(); } catch {}
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

  return { app, server, loop, liveModules };
}
