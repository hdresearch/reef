/**
 * Server tests — discovery, dynamic dispatch, hot-add, reload, and unload.
 *
 * Each test gets an isolated services directory with temporary modules.
 * No port binding — tests use app.fetch() directly.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../src/core/server.js";

// =============================================================================
// Helpers
// =============================================================================

const TEST_DIR = join(import.meta.dir, ".tmp-services");

/** Write a minimal service module to a directory */
function writeService(
  name: string,
  opts: {
    response?: Record<string, unknown>;
    requiresAuth?: boolean;
    dependencies?: string[];
    description?: string;
    mountAtRoot?: boolean;
  } = {},
) {
  const dir = join(TEST_DIR, name);
  mkdirSync(dir, { recursive: true });

  const response = JSON.stringify(opts.response ?? { name, ok: true });
  const authLine = opts.requiresAuth === false ? "requiresAuth: false," : "";
  const depsLine = opts.dependencies?.length
    ? `dependencies: ${JSON.stringify(opts.dependencies)},`
    : "";
  const descLine = opts.description
    ? `description: "${opts.description}",`
    : "";
  const mountLine = opts.mountAtRoot ? "mountAtRoot: true," : "";

  writeFileSync(
    join(dir, "index.ts"),
    `
import { Hono } from "hono";

const routes = new Hono();
routes.get("/", (c) => c.json(${response}));
routes.post("/echo", async (c) => {
  const body = await c.req.json();
  return c.json({ echoed: body });
});

export default {
  name: "${name}",
  ${descLine}
  routes,
  ${authLine}
  ${depsLine}
  ${mountLine}
};
`,
  );
}

/** Remove a service directory */
function removeService(name: string) {
  const dir = join(TEST_DIR, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
}

/** Make a Request to the app */
function req(
  app: { fetch: (req: Request) => Promise<Response> },
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    auth?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body) headers["Content-Type"] = "application/json";
  if (opts.auth) headers["Authorization"] = `Bearer ${opts.auth}`;

  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }),
  );
}

/** Shorthand to fetch JSON */
async function json(
  app: { fetch: (req: Request) => Promise<Response> },
  path: string,
  opts: Parameters<typeof req>[2] = {},
) {
  const res = await req(app, path, opts);
  return { status: res.status, data: await res.json() };
}

// =============================================================================
// Setup / Teardown
// =============================================================================

// Ensure auth is set for tests
const AUTH_TOKEN = "test-token-12345";
const originalToken = process.env.VERS_AUTH_TOKEN;

beforeEach(() => {
  process.env.VERS_AUTH_TOKEN = AUTH_TOKEN;
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  if (originalToken) {
    process.env.VERS_AUTH_TOKEN = originalToken;
  } else {
    delete process.env.VERS_AUTH_TOKEN;
  }
});

// =============================================================================
// Tests
// =============================================================================

describe("discovery", () => {
  test("discovers modules from services directory", async () => {
    writeService("alpha", { requiresAuth: false });
    writeService("beta", { requiresAuth: false });

    const { app } = await createServer({ servicesDir: TEST_DIR, hot: false });

    const { status, data } = await json(app, "/health");
    expect(status).toBe(200);
    expect(data.services).toContain("alpha");
    expect(data.services).toContain("beta");
  });

  test("handles empty services directory", async () => {
    const { app } = await createServer({ servicesDir: TEST_DIR, hot: false });

    const { status, data } = await json(app, "/health");
    expect(status).toBe(200);
    expect(data.services).toEqual([]);
  });

  test("skips directories without index.ts", async () => {
    writeService("good", { requiresAuth: false });
    mkdirSync(join(TEST_DIR, "empty-dir"), { recursive: true });

    const { app } = await createServer({ servicesDir: TEST_DIR, hot: false });

    const { data } = await json(app, "/health");
    expect(data.services).toContain("good");
    expect(data.services).not.toContain("empty-dir");
  });

  test("respects dependency ordering", async () => {
    writeService("base", { requiresAuth: false });
    writeService("dependent", {
      requiresAuth: false,
      dependencies: ["base"],
    });

    const { liveModules } = await createServer({
      servicesDir: TEST_DIR,
      hot: false,
    });

    const names = Array.from(liveModules.keys());
    expect(names.indexOf("base")).toBeLessThan(names.indexOf("dependent"));
  });
});

describe("dynamic dispatch", () => {
  test("routes requests to the correct module", async () => {
    writeService("foo", {
      requiresAuth: false,
      response: { service: "foo" },
    });
    writeService("bar", {
      requiresAuth: false,
      response: { service: "bar" },
    });

    const { app } = await createServer({ servicesDir: TEST_DIR, hot: false });

    const foo = await json(app, "/foo");
    expect(foo.data.service).toBe("foo");

    const bar = await json(app, "/bar");
    expect(bar.data.service).toBe("bar");
  });

  test("returns 404 for unknown services", async () => {
    const { app } = await createServer({ servicesDir: TEST_DIR, hot: false });

    const { status, data } = await json(app, "/nonexistent");
    expect(status).toBe(404);
  });

  test("dispatches sub-paths", async () => {
    writeService("api", { requiresAuth: false });

    const { app } = await createServer({ servicesDir: TEST_DIR, hot: false });

    const { status, data } = await json(app, "/api/echo", {
      method: "POST",
      body: { hello: "world" },
    });
    expect(status).toBe(200);
    expect(data.echoed).toEqual({ hello: "world" });
  });

  test("health endpoint is always accessible", async () => {
    writeService("health-imposter", { requiresAuth: false });

    const { app } = await createServer({ servicesDir: TEST_DIR, hot: false });

    const { status, data } = await json(app, "/health");
    expect(status).toBe(200);
    expect(data.status).toBe("ok");
    expect(data.uptime).toBeGreaterThan(0);
  });
});

describe("auth", () => {
  test("blocks unauthenticated requests to protected modules", async () => {
    writeService("guarded", { requiresAuth: true });

    const { app } = await createServer({ servicesDir: TEST_DIR, hot: false });

    const { status } = await json(app, "/guarded");
    expect(status).toBe(401);
  });

  test("allows authenticated requests to protected modules", async () => {
    writeService("private-api", { response: { secret: true } });

    const { app } = await createServer({ servicesDir: TEST_DIR, hot: false });

    const { status, data } = await json(app, "/private-api", { auth: AUTH_TOKEN });
    expect(status).toBe(200);
    expect(data.secret).toBe(true);
  });

  test("skips auth for modules with requiresAuth: false", async () => {
    writeService("public", {
      requiresAuth: false,
      response: { public: true },
    });

    const { app } = await createServer({ servicesDir: TEST_DIR, hot: false });

    const { status, data } = await json(app, "/public");
    expect(status).toBe(200);
    expect(data.public).toBe(true);
  });
});

describe("hot add", () => {
  test("auto-discovers new service directories", async () => {
    writeService("hot-initial", { requiresAuth: false });

    const { app, stopWatching } = await createServer({
      servicesDir: TEST_DIR,
      hot: true,  // explicitly opt in — hot is off by default
    });

    // Initial state
    let { data } = await json(app, "/health");
    expect(data.services).toContain("hot-initial");
    expect(data.services).not.toContain("hot-latecomer");

    // Drop a new service
    writeService("hot-latecomer", {
      requiresAuth: false,
      response: { late: true },
    });

    // Wait for watcher debounce
    await new Promise((r) => setTimeout(r, 1000));

    // Should be discoverable now
    const latecomer = await json(app, "/hot-latecomer");
    expect(latecomer.status).toBe(200);
    expect(latecomer.data.late).toBe(true);

    ({ data } = await json(app, "/health"));
    expect(data.services).toContain("hot-latecomer");

    stopWatching?.();
  });
});

describe("service context", () => {
  test("getModules returns all loaded modules", async () => {
    writeService("one", { requiresAuth: false });
    writeService("two", { requiresAuth: false });

    const { ctx } = await createServer({ servicesDir: TEST_DIR, hot: false });

    const modules = ctx.getModules();
    const names = modules.map((m) => m.name);
    expect(names).toContain("one");
    expect(names).toContain("two");
  });

  test("getModule returns a specific module", async () => {
    writeService("target", { requiresAuth: false, description: "the target" });

    const { ctx } = await createServer({ servicesDir: TEST_DIR, hot: false });

    const mod = ctx.getModule("target");
    expect(mod).toBeDefined();
    expect(mod!.name).toBe("target");
  });

  test("getModule returns undefined for unknown modules", async () => {
    const { ctx } = await createServer({ servicesDir: TEST_DIR, hot: false });
    expect(ctx.getModule("nope")).toBeUndefined();
  });

  test("loadModule adds a new module", async () => {
    const { app, ctx } = await createServer({
      servicesDir: TEST_DIR,
      hot: false,
    });

    // No modules yet
    expect(ctx.getModules().length).toBe(0);

    // Write one and load it
    writeService("dynamic", {
      requiresAuth: false,
      response: { dynamic: true },
    });
    const result = await ctx.loadModule("dynamic");

    expect(result.name).toBe("dynamic");
    expect(result.action).toBe("added");

    // Should be routable
    const { status, data } = await json(app, "/dynamic");
    expect(status).toBe(200);
    expect(data.dynamic).toBe(true);
  });

  test("loadModule updates an existing module", async () => {
    writeService("mutable", {
      requiresAuth: false,
      response: { version: 1 },
    });

    const { app, ctx } = await createServer({
      servicesDir: TEST_DIR,
      hot: false,
    });

    let { data } = await json(app, "/mutable");
    expect(data.version).toBe(1);

    // Rewrite and reload
    writeService("mutable", {
      requiresAuth: false,
      response: { version: 2 },
    });
    const result = await ctx.loadModule("mutable");

    expect(result.action).toBe("updated");

    ({ data } = await json(app, "/mutable"));
    expect(data.version).toBe(2);
  });

  test("unloadModule removes a module", async () => {
    writeService("removable", { requiresAuth: false });

    const { app, ctx } = await createServer({
      servicesDir: TEST_DIR,
      hot: false,
    });

    let { status } = await json(app, "/removable");
    expect(status).toBe(200);

    await ctx.unloadModule("removable");

    ({ status } = await json(app, "/removable"));
    expect(status).toBe(404);
  });

  test("loadModule rejects missing dependencies", async () => {
    writeService("orphan", {
      requiresAuth: false,
      dependencies: ["nonexistent"],
    });

    const { ctx } = await createServer({ servicesDir: TEST_DIR, hot: false });

    // Remove it from initial load (it would have been skipped due to missing dep)
    // Write it fresh and try to load
    writeService("orphan", {
      requiresAuth: false,
      dependencies: ["nonexistent"],
    });

    await expect(ctx.loadModule("orphan")).rejects.toThrow(
      'Missing dependency "nonexistent"',
    );
  });

  test("getStore accesses another module's store", async () => {
    // Write a module with a store
    const dir = join(TEST_DIR, "stateful");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "index.ts"),
      `
import { Hono } from "hono";

const myStore = { data: [1, 2, 3], flush() {}, close() {} };

export default {
  name: "stateful",
  routes: new Hono(),
  store: myStore,
  requiresAuth: false,
};
`,
    );

    const { ctx } = await createServer({ servicesDir: TEST_DIR, hot: false });

    const store = ctx.getStore<{ data: number[] }>("stateful");
    expect(store).toBeDefined();
    expect(store!.data).toEqual([1, 2, 3]);
  });
});

describe("services manager module", () => {
  /**
   * Tests for the services manager running as a regular service module.
   * We include it alongside test modules to verify it manages them correctly.
   */

  async function createWithManager() {
    // Copy the services manager into the test directory
    const managerSrc = join(import.meta.dir, "..", "services", "services");
    const managerDst = join(TEST_DIR, "services");
    mkdirSync(managerDst, { recursive: true });

    const { readFileSync } = await import("node:fs");
    const indexContent = readFileSync(join(managerSrc, "index.ts"), "utf-8");
    // Rewrite the import path to point to the actual source
    const fixed = indexContent.replace(
      '"../src/core/types.js"',
      `"${join(import.meta.dir, "..", "src", "core", "types.js")}"`,
    );
    writeFileSync(join(managerDst, "index.ts"), fixed);

    return createServer({ servicesDir: TEST_DIR, hot: false });
  }

  test("GET /services lists modules", async () => {
    writeService("alpha", { requiresAuth: false });

    const { app } = await createWithManager();

    const { status, data } = await json(app, "/services", {
      auth: AUTH_TOKEN,
    });
    expect(status).toBe(200);
    expect(data.modules.map((m: any) => m.name)).toContain("alpha");
    expect(data.modules.map((m: any) => m.name)).toContain("services");
  });

  test("POST /services/reload/:name reloads a module", async () => {
    writeService("reloadable", {
      requiresAuth: false,
      response: { v: 1 },
    });

    const { app } = await createWithManager();

    let { data } = await json(app, "/reloadable");
    expect(data.v).toBe(1);

    // Update and reload via the services manager
    writeService("reloadable", {
      requiresAuth: false,
      response: { v: 2 },
    });

    const reload = await json(app, "/services/reload/reloadable", {
      method: "POST",
      auth: AUTH_TOKEN,
    });
    expect(reload.data.action).toBe("updated");

    ({ data } = await json(app, "/reloadable"));
    expect(data.v).toBe(2);
  });

  test("DELETE /services/:name unloads a module", async () => {
    writeService("doomed", { requiresAuth: false });

    const { app } = await createWithManager();

    let { status } = await json(app, "/doomed");
    expect(status).toBe(200);

    const del = await json(app, "/services/doomed", {
      method: "DELETE",
      auth: AUTH_TOKEN,
    });
    expect(del.data.action).toBe("removed");

    ({ status } = await json(app, "/doomed"));
    expect(status).toBe(404);
  });

  test("DELETE /services/services is rejected", async () => {
    const { app } = await createWithManager();

    const { status, data } = await json(app, "/services/services", {
      method: "DELETE",
      auth: AUTH_TOKEN,
    });
    expect(status).toBe(400);
    expect(data.error).toContain("Cannot unload");
  });

  test("POST /services/reload re-scans everything", async () => {
    writeService("existing", { requiresAuth: false });

    const { app } = await createWithManager();

    // Add a new service on disk
    writeService("newcomer", { requiresAuth: false });

    const reload = await json(app, "/services/reload", {
      method: "POST",
      auth: AUTH_TOKEN,
    });

    const names = reload.data.results.map((r: any) => r.name);
    expect(names).toContain("newcomer");

    // Should now be routable
    const { status } = await json(app, "/newcomer");
    expect(status).toBe(200);
  });

  test("POST /services/reload removes deleted services", async () => {
    writeService("temporary", { requiresAuth: false });

    const { app } = await createWithManager();

    // Verify it's loaded
    let { status } = await json(app, "/temporary");
    expect(status).toBe(200);

    // Delete the directory
    removeService("temporary");

    // Reload
    const reload = await json(app, "/services/reload", {
      method: "POST",
      auth: AUTH_TOKEN,
    });

    const removed = reload.data.results.find(
      (r: any) => r.name === "temporary",
    );
    expect(removed?.action).toBe("removed");

    // Should be gone
    ({ status } = await json(app, "/temporary"));
    expect(status).toBe(404);
  });

  test("management endpoints require auth", async () => {
    const { app } = await createWithManager();

    const list = await req(app, "/services");
    expect(list.status).toBe(401);

    const reload = await req(app, "/services/reload", { method: "POST" });
    expect(reload.status).toBe(401);

    const del = await req(app, "/services/foo", { method: "DELETE" });
    expect(del.status).toBe(401);
  });
});
