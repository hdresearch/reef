/**
 * Server — minimal dispatch infrastructure.
 *
 * The server's only job is:
 *   1. Discover and load service modules at startup
 *   2. Dispatch requests to the right module
 *   3. Health check
 *   4. Watch for new service directories (adds only)
 *   5. Graceful shutdown
 *
 * Everything else — including managing modules at runtime — is handled
 * by service modules themselves (see services/services/).
 */

import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { Hono } from "hono";
import { bearerAuth } from "./auth.js";
import {
  discoverServiceModules,
  loadServiceModule,
  watchForNewServices,
} from "./discover.js";
import { ServiceEventBus } from "./events.js";
import type { ServiceModule, ServiceContext } from "./types.js";

export const DEFAULT_SERVICES_DIR = "./services";

export interface ServerOptions {
  modules?: ServiceModule[];
  servicesDir?: string;
  port?: number;
  /** Watch for new service directories at runtime. Default: false */
  hot?: boolean;
}

export async function createServer(options: ServerOptions) {
  const servicesDir = options.servicesDir ?? process.env.SERVICES_DIR ?? DEFAULT_SERVICES_DIR;
  const resolvedServicesDir = resolve(servicesDir);
  const initialModules = options.modules ?? await discoverServiceModules(servicesDir);
  const app = new Hono();
  const events = new ServiceEventBus();

  // ==========================================================================
  // Live module registry
  // ==========================================================================

  const liveModules = new Map<string, ServiceModule>();
  const stores = new Map<string, unknown>();
  const dirForModule = new Map<string, string>();

  function registerModule(mod: ServiceModule, dirName?: string): void {
    liveModules.set(mod.name, mod);
    if (mod.store) stores.set(mod.name, mod.store);
    if (dirName) dirForModule.set(mod.name, dirName);
  }

  async function unregisterModule(name: string): Promise<void> {
    const mod = liveModules.get(name);
    if (!mod) return;

    if (mod.store?.flush) mod.store.flush();
    if (mod.store?.close) await mod.store.close();

    liveModules.delete(name);
    stores.delete(name);
    dirForModule.delete(name);
  }

  async function loadFromDir(
    dirName: string,
  ): Promise<{ name: string; action: "added" | "updated" }> {
    const dirPath = join(resolvedServicesDir, dirName);
    const serviceModule = await loadServiceModule(dirPath);

    for (const dep of serviceModule.dependencies ?? []) {
      if (!liveModules.has(dep)) {
        throw new Error(`Missing dependency "${dep}"`);
      }
    }

    const existed = liveModules.has(serviceModule.name);

    if (existed) {
      const old = liveModules.get(serviceModule.name)!;
      if (old.store?.flush) old.store.flush();
      if (old.store?.close) await old.store.close();
    }

    registerModule(serviceModule, dirName);
    serviceModule.init?.(ctx);

    return { name: serviceModule.name, action: existed ? "updated" : "added" };
  }

  // ==========================================================================
  // Service context — passed to all modules, including the services manager
  // ==========================================================================

  const ctx: ServiceContext = {
    events,
    servicesDir: resolvedServicesDir,

    getStore<T = unknown>(name: string): T | undefined {
      return stores.get(name) as T | undefined;
    },

    getModules(): ServiceModule[] {
      return Array.from(liveModules.values());
    },

    getModule(name: string): ServiceModule | undefined {
      return liveModules.get(name);
    },

    loadModule(dirName: string) {
      return loadFromDir(dirName);
    },

    async unloadModule(name: string) {
      await unregisterModule(name);
    },
  };

  // ==========================================================================
  // Routes — health check + dynamic dispatch
  // ==========================================================================

  const auth = bearerAuth();

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      uptime: process.uptime(),
      services: Array.from(liveModules.values())
        .filter((m) => m.routes)
        .map((m) => m.name),
    }),
  );

  // Dynamic dispatch: look up module by name on each request
  async function dispatch(c: any) {
    const serviceName = c.req.param("service");

    // Don't dispatch to health — it has its own static route
    if (serviceName === "health") return c.notFound();

    const mod = liveModules.get(serviceName);
    if (!mod?.routes || mod.mountAtRoot) {
      return c.json({ error: "not found" }, 404);
    }

    if (mod.requiresAuth !== false) {
      const authResponse = await auth(c, async () => {});
      if (authResponse instanceof Response) return authResponse;
      if (c.res.status === 401) return c.res;
    }

    const url = new URL(c.req.url);
    const prefix = `/${serviceName}`;
    url.pathname = url.pathname.slice(prefix.length) || "/";
    const rewritten = new Request(url.toString(), c.req.raw);

    return mod.routes.fetch(rewritten);
  }

  // Root-mounted modules (UI, webhooks) — registered BEFORE the catch-all
  // dispatch so their explicit routes take priority.
  for (const mod of initialModules) {
    if (mod.mountAtRoot && mod.routes) {
      app.route("/", mod.routes);
    }
  }

  // Catch-all dynamic dispatch — after root-mounted and static routes
  app.all("/:service{[^/]+}", dispatch);
  app.all("/:service{[^/]+}/*", dispatch);

  // ==========================================================================
  // Initialize all modules
  // ==========================================================================

  for (const mod of initialModules) {
    registerModule(mod, mod.name);
  }

  for (const mod of initialModules) {
    mod.init?.(ctx);
  }

  // ==========================================================================
  // Watcher — auto-detect new directories (adds only)
  // ==========================================================================

  let stopWatching: (() => void) | undefined;
  if (options.hot === true) {
    stopWatching = watchForNewServices({
      servicesDir,
      liveModules,
      onNewDir: async (dirName) => {
        try {
          const result = await loadFromDir(dirName);
          console.log(`  [hot] /${result.name} — ${result.name}`);
        } catch (err) {
          console.error(
            `  [hot] Failed to load services/${dirName}: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    });
  }

  return { app, liveModules, events, ctx, stopWatching };
}

/**
 * Start the server and wire up graceful shutdown.
 */
export async function startServer(options: ServerOptions = {}) {
  const { app, liveModules, stopWatching } = await createServer(options);
  const port = options.port ?? parseInt(process.env.PORT || "3000", 10);

  if (!process.env.VERS_AUTH_TOKEN) {
    console.warn(
      "  VERS_AUTH_TOKEN is not set — all endpoints are unauthenticated.",
    );
  }

  console.log("  services:");
  for (const mod of liveModules.values()) {
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

  async function shutdown() {
    console.log("\n  shutting down...");
    stopWatching?.();
    for (const mod of liveModules.values()) {
      if (mod.store?.flush) mod.store.flush();
      if (mod.store?.close) await mod.store.close();
    }
    server.stop();
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return { app, server, liveModules };
}
