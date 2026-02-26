/**
 * Server tests — discovery, dynamic dispatch, reload, unload, and install.
 *
 * Each test gets an isolated services directory with temporary modules.
 * No port binding — tests use app.fetch() directly.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createServer } from "../src/core/server.js";
import { parseSource } from "../services/installer/index.js";

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

    const { app } = await createServer({ servicesDir: TEST_DIR });

    const { status, data } = await json(app, "/health");
    expect(status).toBe(200);
    expect(data.services).toContain("alpha");
    expect(data.services).toContain("beta");
  });

  test("handles empty services directory", async () => {
    const { app } = await createServer({ servicesDir: TEST_DIR });

    const { status, data } = await json(app, "/health");
    expect(status).toBe(200);
    expect(data.services).toEqual([]);
  });

  test("skips directories without index.ts", async () => {
    writeService("good", { requiresAuth: false });
    mkdirSync(join(TEST_DIR, "empty-dir"), { recursive: true });

    const { app } = await createServer({ servicesDir: TEST_DIR });

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

    const { liveModules } = await createServer({ servicesDir: TEST_DIR });

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

    const { app } = await createServer({ servicesDir: TEST_DIR });

    const foo = await json(app, "/foo");
    expect(foo.data.service).toBe("foo");

    const bar = await json(app, "/bar");
    expect(bar.data.service).toBe("bar");
  });

  test("returns 404 for unknown services", async () => {
    const { app } = await createServer({ servicesDir: TEST_DIR });

    const { status } = await json(app, "/nonexistent");
    expect(status).toBe(404);
  });

  test("dispatches sub-paths", async () => {
    writeService("api", { requiresAuth: false });

    const { app } = await createServer({ servicesDir: TEST_DIR });

    const { status, data } = await json(app, "/api/echo", {
      method: "POST",
      body: { hello: "world" },
    });
    expect(status).toBe(200);
    expect(data.echoed).toEqual({ hello: "world" });
  });

  test("health endpoint is always accessible", async () => {
    writeService("health-imposter", { requiresAuth: false });

    const { app } = await createServer({ servicesDir: TEST_DIR });

    const { status, data } = await json(app, "/health");
    expect(status).toBe(200);
    expect(data.status).toBe("ok");
    expect(data.uptime).toBeGreaterThan(0);
  });
});

describe("auth", () => {
  test("blocks unauthenticated requests to protected modules", async () => {
    writeService("guarded", { requiresAuth: true });

    const { app } = await createServer({ servicesDir: TEST_DIR });

    const { status } = await json(app, "/guarded");
    expect(status).toBe(401);
  });

  test("allows authenticated requests to protected modules", async () => {
    writeService("private-api", { response: { secret: true } });

    const { app } = await createServer({ servicesDir: TEST_DIR });

    const { status, data } = await json(app, "/private-api", {
      auth: AUTH_TOKEN,
    });
    expect(status).toBe(200);
    expect(data.secret).toBe(true);
  });

  test("skips auth for modules with requiresAuth: false", async () => {
    writeService("public-mod", {
      requiresAuth: false,
      response: { public: true },
    });

    const { app } = await createServer({ servicesDir: TEST_DIR });

    const { status, data } = await json(app, "/public-mod");
    expect(status).toBe(200);
    expect(data.public).toBe(true);
  });
});

describe("error handling", () => {
  test("bad module at startup doesn't take down other services", async () => {
    writeService("good-svc", { requiresAuth: false, response: { good: true } });

    // Write a module whose init() throws
    const badDir = join(TEST_DIR, "bad-init");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(
      join(badDir, "index.ts"),
      `
import { Hono } from "hono";
export default {
  name: "bad-init",
  routes: new Hono(),
  requiresAuth: false,
  init() { throw new Error("kaboom"); },
};
`,
    );

    const { app } = await createServer({ servicesDir: TEST_DIR });

    // Good service still works
    const { status, data } = await json(app, "/good-svc");
    expect(status).toBe(200);
    expect(data.good).toBe(true);

    // Bad service was removed from the registry
    const health = await json(app, "/health");
    expect(health.data.services).toContain("good-svc");
    expect(health.data.services).not.toContain("bad-init");

    // Bad service returns 404, not 500
    const bad = await json(app, "/bad-init");
    expect(bad.status).toBe(404);
  });

  test("module that throws at import time is skipped", async () => {
    writeService("survivor", { requiresAuth: false });

    const badDir = join(TEST_DIR, "bad-import");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(
      join(badDir, "index.ts"),
      `throw new Error("module-level explosion");`,
    );

    const { app } = await createServer({ servicesDir: TEST_DIR });

    const { status } = await json(app, "/survivor");
    expect(status).toBe(200);

    const health = await json(app, "/health");
    expect(health.data.services).not.toContain("bad-import");
  });

  test("module route handler that throws returns 500", async () => {
    const badDir = join(TEST_DIR, "throws-at-runtime");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(
      join(badDir, "index.ts"),
      `
import { Hono } from "hono";
const routes = new Hono();
routes.get("/", (c) => { throw new Error("runtime kaboom"); });
export default {
  name: "throws-at-runtime",
  routes,
  requiresAuth: false,
};
`,
    );

    const { app } = await createServer({ servicesDir: TEST_DIR });

    const { status, data } = await json(app, "/throws-at-runtime");
    expect(status).toBe(500);
    expect(data.error).toBe("internal service error");
  });

  test("loadModule rolls back on init() failure", async () => {
    const { app, ctx } = await createServer({ servicesDir: TEST_DIR });

    const badDir = join(TEST_DIR, "bad-runtime-init");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(
      join(badDir, "index.ts"),
      `
import { Hono } from "hono";
export default {
  name: "bad-runtime-init",
  routes: new Hono(),
  requiresAuth: false,
  init() { throw new Error("init failed"); },
};
`,
    );

    await expect(ctx.loadModule("bad-runtime-init")).rejects.toThrow(
      "init() failed",
    );

    // Should not be in the registry
    expect(ctx.getModule("bad-runtime-init")).toBeUndefined();

    // Should 404
    const { status } = await json(app, "/bad-runtime-init");
    expect(status).toBe(404);
  });
});

describe("service context", () => {
  test("getModules returns all loaded modules", async () => {
    writeService("ctx-one", { requiresAuth: false });
    writeService("ctx-two", { requiresAuth: false });

    const { ctx } = await createServer({ servicesDir: TEST_DIR });

    const modules = ctx.getModules();
    const names = modules.map((m) => m.name);
    expect(names).toContain("ctx-one");
    expect(names).toContain("ctx-two");
  });

  test("getModule returns a specific module", async () => {
    writeService("ctx-target", { requiresAuth: false, description: "the target" });

    const { ctx } = await createServer({ servicesDir: TEST_DIR });

    const mod = ctx.getModule("ctx-target");
    expect(mod).toBeDefined();
    expect(mod!.name).toBe("ctx-target");
  });

  test("getModule returns undefined for unknown modules", async () => {
    const { ctx } = await createServer({ servicesDir: TEST_DIR });
    expect(ctx.getModule("nope")).toBeUndefined();
  });

  test("loadModule adds a new module", async () => {
    const { app, ctx } = await createServer({ servicesDir: TEST_DIR });

    expect(ctx.getModules().length).toBe(0);

    writeService("ctx-dynamic", {
      requiresAuth: false,
      response: { dynamic: true },
    });
    const result = await ctx.loadModule("ctx-dynamic");

    expect(result.name).toBe("ctx-dynamic");
    expect(result.action).toBe("added");

    const { status, data } = await json(app, "/ctx-dynamic");
    expect(status).toBe(200);
    expect(data.dynamic).toBe(true);
  });

  test("loadModule updates an existing module", async () => {
    writeService("ctx-mutable", {
      requiresAuth: false,
      response: { version: 1 },
    });

    const { app, ctx } = await createServer({ servicesDir: TEST_DIR });

    let { data } = await json(app, "/ctx-mutable");
    expect(data.version).toBe(1);

    writeService("ctx-mutable", {
      requiresAuth: false,
      response: { version: 2 },
    });
    const result = await ctx.loadModule("ctx-mutable");

    expect(result.action).toBe("updated");

    ({ data } = await json(app, "/ctx-mutable"));
    expect(data.version).toBe(2);
  });

  test("unloadModule removes a module", async () => {
    writeService("ctx-removable", { requiresAuth: false });

    const { app, ctx } = await createServer({ servicesDir: TEST_DIR });

    let { status } = await json(app, "/ctx-removable");
    expect(status).toBe(200);

    await ctx.unloadModule("ctx-removable");

    ({ status } = await json(app, "/ctx-removable"));
    expect(status).toBe(404);
  });

  test("loadModule rejects missing dependencies", async () => {
    writeService("ctx-orphan", {
      requiresAuth: false,
      dependencies: ["nonexistent"],
    });

    const { ctx } = await createServer({ servicesDir: TEST_DIR });

    await expect(ctx.loadModule("ctx-orphan")).rejects.toThrow(
      'Missing dependency "nonexistent"',
    );
  });

  test("getStore accesses another module's store", async () => {
    const dir = join(TEST_DIR, "ctx-stateful");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "index.ts"),
      `
import { Hono } from "hono";

const myStore = { data: [1, 2, 3], flush() {}, close() {} };

export default {
  name: "ctx-stateful",
  routes: new Hono(),
  store: myStore,
  requiresAuth: false,
};
`,
    );

    const { ctx } = await createServer({ servicesDir: TEST_DIR });

    const store = ctx.getStore<{ data: number[] }>("ctx-stateful");
    expect(store).toBeDefined();
    expect(store!.data).toEqual([1, 2, 3]);
  });
});

describe("services manager module", () => {
  async function createWithManager() {
    const managerSrc = join(import.meta.dir, "..", "services", "services");
    const managerDst = join(TEST_DIR, "services");
    mkdirSync(managerDst, { recursive: true });

    const indexContent = readFileSync(join(managerSrc, "index.ts"), "utf-8");
    const fixed = indexContent.replace(
      '"../src/core/types.js"',
      `"${join(import.meta.dir, "..", "src", "core", "types.js")}"`,
    );
    writeFileSync(join(managerDst, "index.ts"), fixed);

    return createServer({ servicesDir: TEST_DIR });
  }

  test("GET /services lists modules", async () => {
    writeService("mgr-alpha", { requiresAuth: false });

    const { app } = await createWithManager();

    const { status, data } = await json(app, "/services", {
      auth: AUTH_TOKEN,
    });
    expect(status).toBe(200);
    expect(data.modules.map((m: any) => m.name)).toContain("mgr-alpha");
    expect(data.modules.map((m: any) => m.name)).toContain("services");
  });

  test("POST /services/reload/:name reloads a module", async () => {
    writeService("mgr-reloadable", {
      requiresAuth: false,
      response: { v: 1 },
    });

    const { app } = await createWithManager();

    let { data } = await json(app, "/mgr-reloadable");
    expect(data.v).toBe(1);

    writeService("mgr-reloadable", {
      requiresAuth: false,
      response: { v: 2 },
    });

    const reload = await json(app, "/services/reload/mgr-reloadable", {
      method: "POST",
      auth: AUTH_TOKEN,
    });
    expect(reload.data.action).toBe("updated");

    ({ data } = await json(app, "/mgr-reloadable"));
    expect(data.v).toBe(2);
  });

  test("DELETE /services/:name unloads a module", async () => {
    writeService("mgr-doomed", { requiresAuth: false });

    const { app } = await createWithManager();

    let { status } = await json(app, "/mgr-doomed");
    expect(status).toBe(200);

    const del = await json(app, "/services/mgr-doomed", {
      method: "DELETE",
      auth: AUTH_TOKEN,
    });
    expect(del.data.action).toBe("removed");

    ({ status } = await json(app, "/mgr-doomed"));
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
    writeService("mgr-existing", { requiresAuth: false });

    const { app } = await createWithManager();

    writeService("mgr-newcomer", { requiresAuth: false });

    const reload = await json(app, "/services/reload", {
      method: "POST",
      auth: AUTH_TOKEN,
    });

    const names = reload.data.results.map((r: any) => r.name);
    expect(names).toContain("mgr-newcomer");

    const { status } = await json(app, "/mgr-newcomer");
    expect(status).toBe(200);
  });

  test("POST /services/reload removes deleted services", async () => {
    writeService("mgr-temporary", { requiresAuth: false });

    const { app } = await createWithManager();

    let { status } = await json(app, "/mgr-temporary");
    expect(status).toBe(200);

    removeService("mgr-temporary");

    const reload = await json(app, "/services/reload", {
      method: "POST",
      auth: AUTH_TOKEN,
    });

    const removed = reload.data.results.find(
      (r: any) => r.name === "mgr-temporary",
    );
    expect(removed?.action).toBe("removed");

    ({ status } = await json(app, "/mgr-temporary"));
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

describe("installer module", () => {
  const EXTERNAL_DIR = join(import.meta.dir, ".tmp-external");

  /** Create an external service directory (simulating a repo or local package) */
  function writeExternal(name: string, response: Record<string, unknown> = { external: true }) {
    const dir = join(EXTERNAL_DIR, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "index.ts"),
      `
import { Hono } from "hono";

const routes = new Hono();
routes.get("/", (c) => c.json(${JSON.stringify(response)}));

export default {
  name: "${name}",
  description: "External ${name}",
  routes,
  requiresAuth: false,
};
`,
    );
  }

  async function createWithInstaller() {
    // Copy the installer module into the test services dir
    const installerSrc = join(import.meta.dir, "..", "services", "installer");
    const installerDst = join(TEST_DIR, "installer");
    mkdirSync(installerDst, { recursive: true });

    const indexContent = readFileSync(join(installerSrc, "index.ts"), "utf-8");
    const fixed = indexContent.replace(
      '"../src/core/types.js"',
      `"${join(import.meta.dir, "..", "src", "core", "types.js")}"`,
    );
    writeFileSync(join(installerDst, "index.ts"), fixed);

    return createServer({ servicesDir: TEST_DIR });
  }

  beforeEach(() => {
    rmSync(EXTERNAL_DIR, { recursive: true, force: true });
    mkdirSync(EXTERNAL_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(EXTERNAL_DIR, { recursive: true, force: true });
  });

  test("POST /installer/install from local path", async () => {
    writeExternal("my-plugin", { plugin: true, v: 1 });

    const { app } = await createWithInstaller();

    // Install
    const install = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "my-plugin") },
    });
    expect(install.status).toBe(201);
    expect(install.data.action).toBe("installed");
    expect(install.data.type).toBe("local");
    expect(install.data.name).toBe("my-plugin");

    // It's live immediately
    const { status, data } = await json(app, "/my-plugin");
    expect(status).toBe(200);
    expect(data.plugin).toBe(true);
  });

  test("local install creates a symlink", async () => {
    writeExternal("symlink-test");

    const { app } = await createWithInstaller();

    await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "symlink-test") },
    });

    const linkPath = join(TEST_DIR, "symlink-test");
    expect(existsSync(linkPath)).toBe(true);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
  });

  test("GET /installer/installed lists installed packages", async () => {
    writeExternal("pkg-a");
    writeExternal("pkg-b");

    const { app } = await createWithInstaller();

    await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "pkg-a") },
    });
    await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "pkg-b") },
    });

    const { data } = await json(app, "/installer/installed", {
      auth: AUTH_TOKEN,
    });
    expect(data.count).toBe(2);
    expect(data.installed.map((e: any) => e.dirName)).toContain("pkg-a");
    expect(data.installed.map((e: any) => e.dirName)).toContain("pkg-b");
    expect(data.installed[0].type).toBe("local");
    expect(data.installed[0].installedAt).toBeDefined();
  });

  test("duplicate install is rejected", async () => {
    writeExternal("dupe-test");

    const { app } = await createWithInstaller();

    const first = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "dupe-test") },
    });
    expect(first.status).toBe(201);

    const second = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "dupe-test") },
    });
    expect(second.status).toBe(409);
    expect(second.data.error).toContain("already installed");
  });

  test("install rejects directories without index.ts", async () => {
    const emptyDir = join(EXTERNAL_DIR, "no-index");
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(join(emptyDir, "README.md"), "not a service");

    const { app } = await createWithInstaller();

    const { status, data } = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: emptyDir },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("No index.ts");

    // Directory should be cleaned up
    expect(existsSync(join(TEST_DIR, "no-index"))).toBe(false);
  });

  test("install rejects nonexistent paths", async () => {
    const { app } = await createWithInstaller();

    const { status, data } = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: "/nonexistent/path/to/service" },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("not found");
  });

  test("install requires source field", async () => {
    const { app } = await createWithInstaller();

    const { status, data } = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: {},
    });
    expect(status).toBe(400);
    expect(data.error).toContain("required");
  });

  test("POST /installer/remove unloads and deletes", async () => {
    writeExternal("removable-pkg", { removable: true });

    const { app } = await createWithInstaller();

    // Install
    await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "removable-pkg") },
    });

    // Verify it's live
    let { status } = await json(app, "/removable-pkg");
    expect(status).toBe(200);

    // Remove
    const remove = await json(app, "/installer/remove", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "removable-pkg" },
    });
    expect(remove.data.action).toBe("removed");

    // Gone from routing
    ({ status } = await json(app, "/removable-pkg"));
    expect(status).toBe(404);

    // Gone from disk
    expect(existsSync(join(TEST_DIR, "removable-pkg"))).toBe(false);

    // Gone from registry
    const { data } = await json(app, "/installer/installed", {
      auth: AUTH_TOKEN,
    });
    expect(data.installed.map((e: any) => e.dirName)).not.toContain(
      "removable-pkg",
    );
  });

  test("remove rejects unknown packages", async () => {
    const { app } = await createWithInstaller();

    const { status, data } = await json(app, "/installer/remove", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "never-installed" },
    });
    expect(status).toBe(404);
    expect(data.error).toContain("not installed");
  });

  test("installed service shows in health check", async () => {
    writeExternal("health-visible");

    const { app } = await createWithInstaller();

    await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "health-visible") },
    });

    const { data } = await json(app, "/health");
    expect(data.services).toContain("health-visible");
  });

  test("install and remove round-trip leaves clean state", async () => {
    writeExternal("round-trip");

    const { app } = await createWithInstaller();

    // Install
    await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "round-trip") },
    });

    // Remove
    await json(app, "/installer/remove", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "round-trip" },
    });

    // Can install again
    const reinstall = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "round-trip") },
    });
    expect(reinstall.status).toBe(201);
    expect(reinstall.data.action).toBe("installed");
  });

  test("install from local git repo (clone, not symlink)", async () => {
    // Create a bare git repo with a service module in it
    const bareRepo = join(EXTERNAL_DIR, "my-git-service.git");
    const workTree = join(EXTERNAL_DIR, "my-git-service-work");

    execSync(`git init --bare ${bareRepo}`);
    mkdirSync(workTree, { recursive: true });

    writeFileSync(
      join(workTree, "index.ts"),
      `
import { Hono } from "hono";

const routes = new Hono();
routes.get("/", (c) => c.json({ from: "git", v: 1 }));

export default {
  name: "my-git-service",
  description: "Installed from git",
  routes,
  requiresAuth: false,
};
`,
    );

    execSync("git init && git add -A && git commit -m 'init'", {
      cwd: workTree,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
    });
    // Push to master (the bare repo's default branch)
    execSync(`git push ${bareRepo} HEAD:master`, { cwd: workTree });

    const { app } = await createWithInstaller();

    // Install from the bare repo (a real git clone)
    const install = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: bareRepo },
    });
    expect(install.status).toBe(201);
    expect(install.data.type).toBe("git");
    expect(install.data.name).toBe("my-git-service");

    // It should be a real directory, not a symlink
    const clonedDir = join(TEST_DIR, "my-git-service");
    expect(existsSync(clonedDir)).toBe(true);
    expect(lstatSync(clonedDir).isSymbolicLink()).toBe(false);
    expect(existsSync(join(clonedDir, ".git"))).toBe(true);

    // It's live
    const { status, data } = await json(app, "/my-git-service");
    expect(status).toBe(200);
    expect(data.from).toBe("git");
  });

  test("update pulls latest from git repo", async () => {
    // Create bare repo + working tree
    const bareRepo = join(EXTERNAL_DIR, "updatable-svc.git");
    const workTree = join(EXTERNAL_DIR, "updatable-svc-work");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@test.com",
    };

    execSync(`git init --bare ${bareRepo}`);
    mkdirSync(workTree, { recursive: true });

    writeFileSync(
      join(workTree, "index.ts"),
      `
import { Hono } from "hono";
const routes = new Hono();
routes.get("/", (c) => c.json({ version: 1 }));
export default { name: "updatable-svc", routes, requiresAuth: false };
`,
    );
    execSync("git init && git add -A && git commit -m 'v1'", {
      cwd: workTree, env: gitEnv,
    });
    execSync(`git push ${bareRepo} HEAD:master`, { cwd: workTree });

    const { app } = await createWithInstaller();

    // Install v1
    await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: bareRepo },
    });

    let res = await json(app, "/updatable-svc");
    expect(res.data.version).toBe(1);

    // Push v2 to the bare repo
    writeFileSync(
      join(workTree, "index.ts"),
      `
import { Hono } from "hono";
const routes = new Hono();
routes.get("/", (c) => c.json({ version: 2 }));
export default { name: "updatable-svc", routes, requiresAuth: false };
`,
    );
    execSync("git add -A && git commit -m 'v2'", {
      cwd: workTree, env: gitEnv,
    });
    execSync(`git push ${bareRepo} HEAD:master`, { cwd: workTree });

    // Update via the installer
    const update = await json(app, "/installer/update", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "updatable-svc" },
    });
    expect(update.data.action).toBe("updated");

    // Module should serve the new version
    res = await json(app, "/updatable-svc");
    expect(res.data.version).toBe(2);
  });

  test("update rejects local-linked services", async () => {
    writeExternal("local-only");

    const { app } = await createWithInstaller();

    await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "local-only") },
    });

    const { status, data } = await json(app, "/installer/update", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "local-only" },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("local link");
  });
});

describe("fleet-to-fleet install", () => {
  const SOURCE_DIR = join(import.meta.dir, ".tmp-source-services");
  const DEST_DIR = join(import.meta.dir, ".tmp-dest-services");
  let sourceServer: ReturnType<typeof Bun.serve> | undefined;

  /** Write the services manager + a test service into the source dir */
  function setupSourceServer() {
    mkdirSync(SOURCE_DIR, { recursive: true });

    // Copy the services manager module (needed for /services/export/:name)
    const managerSrc = join(import.meta.dir, "..", "services", "services");
    const managerDst = join(SOURCE_DIR, "services");
    mkdirSync(managerDst, { recursive: true });
    const managerContent = readFileSync(join(managerSrc, "index.ts"), "utf-8")
      .replace('"../src/core/types.js"', `"${join(import.meta.dir, "..", "src", "core", "types.js")}"`);
    writeFileSync(join(managerDst, "index.ts"), managerContent);

    // Write a service to export
    const svcDir = join(SOURCE_DIR, "exportable");
    mkdirSync(svcDir, { recursive: true });
    writeFileSync(join(svcDir, "index.ts"), `
import { Hono } from "hono";
const routes = new Hono();
routes.get("/", (c) => c.json({ pulled: true, origin: "source" }));
export default {
  name: "exportable",
  description: "A service that can be exported",
  routes,
  requiresAuth: false,
};
`);
    // Add an extra file to make sure multi-file services transfer
    writeFileSync(join(svcDir, "helpers.ts"), `export const VERSION = 1;`);
  }

  async function setupDestServer() {
    mkdirSync(DEST_DIR, { recursive: true });

    // Copy the installer module
    const installerSrc = join(import.meta.dir, "..", "services", "installer");
    const installerDst = join(DEST_DIR, "installer");
    mkdirSync(installerDst, { recursive: true });
    const installerContent = readFileSync(join(installerSrc, "index.ts"), "utf-8")
      .replace('"../src/core/types.js"', `"${join(import.meta.dir, "..", "src", "core", "types.js")}"`);
    writeFileSync(join(installerDst, "index.ts"), installerContent);

    return createServer({ servicesDir: DEST_DIR });
  }

  beforeEach(() => {
    rmSync(SOURCE_DIR, { recursive: true, force: true });
    rmSync(DEST_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    sourceServer?.stop();
    sourceServer = undefined;
    rmSync(SOURCE_DIR, { recursive: true, force: true });
    rmSync(DEST_DIR, { recursive: true, force: true });
  });

  test("install a service from another instance", async () => {
    setupSourceServer();

    // Start source server on a real port
    const source = await createServer({ servicesDir: SOURCE_DIR });
    sourceServer = Bun.serve({
      fetch: source.app.fetch,
      port: 0, // random available port
    });
    const sourceUrl = `http://localhost:${sourceServer.port}`;

    // Verify source has the export endpoint
    const exportCheck = await fetch(`${sourceUrl}/services/export/exportable`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(exportCheck.status).toBe(200);
    expect(exportCheck.headers.get("Content-Type")).toBe("application/gzip");

    // Set up destination server
    const { app } = await setupDestServer();

    // Install from the source
    const install = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { from: sourceUrl, name: "exportable", token: AUTH_TOKEN },
    });
    expect(install.status).toBe(201);
    expect(install.data.type).toBe("fleet");
    expect(install.data.from).toBe(sourceUrl);
    expect(install.data.name).toBe("exportable");

    // Service is live on the destination
    const { status, data } = await json(app, "/exportable");
    expect(status).toBe(200);
    expect(data.pulled).toBe(true);
    expect(data.origin).toBe("source");

    // Multi-file transfer worked
    expect(existsSync(join(DEST_DIR, "exportable", "helpers.ts"))).toBe(true);

    // Shows up in the installed list as fleet type
    const installed = await json(app, "/installer/installed", { auth: AUTH_TOKEN });
    const entry = installed.data.installed.find((e: any) => e.dirName === "exportable");
    expect(entry.type).toBe("fleet");
    expect(entry.source).toBe(`${sourceUrl}#exportable`);
  });

  test("from requires name", async () => {
    const { app } = await setupDestServer();

    const { status, data } = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { from: "http://localhost:9999" },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("name");
  });

  test("fails gracefully when remote is unreachable", async () => {
    const { app } = await setupDestServer();

    const { status, data } = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { from: "http://localhost:19999", name: "nope" },
    });
    expect(status).toBe(400);
    expect(data.error).toBeDefined();
  });

  test("fails gracefully when remote service doesn't exist", async () => {
    setupSourceServer();

    const source = await createServer({ servicesDir: SOURCE_DIR });
    sourceServer = Bun.serve({
      fetch: source.app.fetch,
      port: 0,
    });
    const sourceUrl = `http://localhost:${sourceServer.port}`;

    const { app } = await setupDestServer();

    const { status, data } = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { from: sourceUrl, name: "nonexistent", token: AUTH_TOKEN },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("404");
  });

  test("update re-pulls from the same remote", async () => {
    setupSourceServer();

    const source = await createServer({ servicesDir: SOURCE_DIR });
    sourceServer = Bun.serve({
      fetch: source.app.fetch,
      port: 0,
    });
    const sourceUrl = `http://localhost:${sourceServer.port}`;

    const { app } = await setupDestServer();

    // Install
    await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { from: sourceUrl, name: "exportable", token: AUTH_TOKEN },
    });

    // Update (needs token for the remote)
    const update = await json(app, "/installer/update", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "exportable", token: AUTH_TOKEN },
    });
    expect(update.data.action).toBe("updated");
  });
});

describe("source parsing", () => {

  test("GitHub shorthand: user/repo", () => {
    const parsed = parseSource("acme/cool-service");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("https://github.com/acme/cool-service");
    expect(parsed.dirName).toBe("cool-service");
    expect(parsed.ref).toBeUndefined();
  });

  test("GitHub shorthand with ref: user/repo@v1.0", () => {
    const parsed = parseSource("acme/cool-service@v1.0");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("https://github.com/acme/cool-service");
    expect(parsed.ref).toBe("v1.0");
    expect(parsed.dirName).toBe("cool-service");
  });

  test("HTTPS URL: https://github.com/user/repo", () => {
    const parsed = parseSource("https://github.com/acme/my-service");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("https://github.com/acme/my-service");
    expect(parsed.dirName).toBe("my-service");
  });

  test("HTTPS URL with .git suffix", () => {
    const parsed = parseSource("https://github.com/acme/my-service.git");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("https://github.com/acme/my-service.git");
    expect(parsed.dirName).toBe("my-service");
  });

  test("HTTPS URL with ref", () => {
    const parsed = parseSource("https://github.com/acme/my-service@main");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("https://github.com/acme/my-service");
    expect(parsed.ref).toBe("main");
  });

  test("SSH URL: git@github.com:user/repo", () => {
    const parsed = parseSource("git@github.com:acme/my-service");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("git@github.com:acme/my-service");
    expect(parsed.dirName).toBe("my-service");
  });

  test("SSH URL with ref", () => {
    const parsed = parseSource("git@github.com:acme/my-service@v2.0");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("git@github.com:acme/my-service");
    expect(parsed.ref).toBe("v2.0");
  });

  test("bare host: github.com/user/repo", () => {
    const parsed = parseSource("github.com/acme/my-service");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("https://github.com/acme/my-service");
    expect(parsed.dirName).toBe("my-service");
  });

  test("bare host with ref", () => {
    const parsed = parseSource("github.com/acme/my-service@feat-branch");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("https://github.com/acme/my-service");
    expect(parsed.ref).toBe("feat-branch");
  });

  test("non-GitHub host: gitlab.com/user/repo", () => {
    const parsed = parseSource("gitlab.com/team/service");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("https://gitlab.com/team/service");
    expect(parsed.dirName).toBe("service");
  });

  test("rejects unparseable input", () => {
    expect(() => parseSource("just-a-word")).toThrow("Cannot parse source");
  });
});
