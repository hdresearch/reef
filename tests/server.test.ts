/**
 * Core server tests — discovery, dynamic dispatch, auth, error handling, service context.
 *
 * Each test gets an isolated services directory with temporary modules.
 * No port binding — tests use app.fetch() directly.
 *
 * Service-specific tests (services manager, installer) live alongside
 * their services in services/services/ and services/installer/.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
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

  test("discovers symlinked service directories", async () => {
    writeService("alpha", { requiresAuth: false });
    symlinkSync(join(TEST_DIR, "alpha"), join(TEST_DIR, "alpha-link"), "dir");

    const { app } = await createServer({ servicesDir: TEST_DIR });

    const { status, data } = await json(app, "/health");
    expect(status).toBe(200);
    expect(data.services).toContain("alpha");
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

    const { status, data } = await json(app, "/good-svc");
    expect(status).toBe(200);
    expect(data.good).toBe(true);

    const health = await json(app, "/health");
    expect(health.data.services).toContain("good-svc");
    expect(health.data.services).not.toContain("bad-init");

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

    expect(ctx.getModule("bad-runtime-init")).toBeUndefined();

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
