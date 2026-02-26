/**
 * Server — loads ServiceModules, mounts their routes, handles shutdown.
 *
 * This is the server-side plugin loader. Each service module contributes
 * routes that get mounted at /{name}/*. Auth is applied per-module.
 */

import { Hono } from "hono";
import { bearerAuth } from "./auth.js";
import { discoverServiceModules } from "./discover.js";
import { ServiceEventBus } from "./events.js";
import type { ServiceModule, ServiceContext } from "./types.js";

export const DEFAULT_SERVICES_DIR = "./services";

export interface ServerOptions {
  modules?: ServiceModule[];
  servicesDir?: string;
  port?: number;
}

export async function createServer(options: ServerOptions) {
  const modules = options.modules ?? await discoverServiceModules(
    options.servicesDir ?? process.env.SERVICES_DIR ?? DEFAULT_SERVICES_DIR,
  );
  const app = new Hono();
  const events = new ServiceEventBus();

  // Build store map for cross-module access
  const stores = new Map<string, unknown>();
  for (const mod of modules) {
    if (mod.store) stores.set(mod.name, mod.store);
  }

  const ctx: ServiceContext = {
    events,
    getStore<T = unknown>(name: string): T | undefined {
      return stores.get(name) as T | undefined;
    },
  };

  // Health check — always unauthenticated
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      uptime: process.uptime(),
      services: modules.filter((m) => m.routes).map((m) => m.name),
    }),
  );

  // Mount each module's routes
  for (const mod of modules) {
    if (!mod.routes) continue;

    if (mod.mountAtRoot) {
      app.route("/", mod.routes);
    } else {
      if (mod.requiresAuth !== false) {
        app.use(`/${mod.name}/*`, bearerAuth());
      }
      app.route(`/${mod.name}`, mod.routes);
    }
  }

  // Initialize modules — all routes mounted, safe to cross-reference
  for (const mod of modules) {
    mod.init?.(ctx);
  }

  return { app, modules, events, ctx };
}

/**
 * Start the server and wire up graceful shutdown.
 */
export async function startServer(options: ServerOptions = {}) {
  const { app, modules } = await createServer(options);
  const port = options.port ?? parseInt(process.env.PORT || "3000", 10);

  if (!process.env.VERS_AUTH_TOKEN) {
    console.warn(
      "  VERS_AUTH_TOKEN is not set — all endpoints are unauthenticated.",
    );
  }

  console.log("  services:");
  for (const mod of modules) {
    if (mod.routes) {
      console.log(`    /${mod.name} — ${mod.description || mod.name}`);
    }
  }

  const server = Bun.serve({
    fetch: app.fetch,
    port,
    hostname: "::",
  });

  console.log(`\n  fleet-services running on :${port}\n`);

  // Graceful shutdown
  async function shutdown() {
    console.log("\n  shutting down...");
    for (const mod of modules) {
      if (mod.store?.flush) {
        mod.store.flush();
      }
      if (mod.store?.close) {
        await mod.store.close();
      }
    }
    server.stop();
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return { app, server, modules };
}
