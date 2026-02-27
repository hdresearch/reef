/**
 * Services manager tests.
 *
 * Moved from tests/server.test.ts — tests the /services management API.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { createServer } from "../../src/core/server.js";

const TEST_DIR = join(import.meta.dir, ".tmp-services-mgr");
const AUTH_TOKEN = "test-token-12345";
const originalToken = process.env.VERS_AUTH_TOKEN;

function writeService(
  name: string,
  opts: { response?: Record<string, unknown>; requiresAuth?: boolean } = {},
) {
  const dir = join(TEST_DIR, name);
  mkdirSync(dir, { recursive: true });
  const response = JSON.stringify(opts.response ?? { name, ok: true });
  const authLine = opts.requiresAuth === false ? "requiresAuth: false," : "";
  writeFileSync(
    join(dir, "index.ts"),
    `
import { Hono } from "hono";
const routes = new Hono();
routes.get("/", (c) => c.json(${response}));
export default { name: "${name}", routes, ${authLine} };
`,
  );
}

function removeService(name: string) {
  const dir = join(TEST_DIR, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
}

function req(
  app: { fetch: (req: Request) => Promise<Response> },
  path: string,
  opts: { method?: string; body?: unknown; auth?: string } = {},
) {
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

async function json(
  app: { fetch: (req: Request) => Promise<Response> },
  path: string,
  opts: Parameters<typeof req>[2] = {},
) {
  const res = await req(app, path, opts);
  return { status: res.status, data: await res.json() };
}

async function createWithManager() {
  const managerSrc = join(import.meta.dir, "index.ts");
  const managerDst = join(TEST_DIR, "services");
  mkdirSync(managerDst, { recursive: true });
  const indexContent = readFileSync(managerSrc, "utf-8");
  const fixed = indexContent.replace(
    '"../src/core/types.js"',
    `"${join(import.meta.dir, "..", "..", "src", "core", "types.js")}"`,
  );
  writeFileSync(join(managerDst, "index.ts"), fixed);
  return createServer({ servicesDir: TEST_DIR });
}

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

describe("services manager module", () => {
  test("GET /services lists modules", async () => {
    writeService("mgr-alpha", { requiresAuth: false });
    const { app } = await createWithManager();
    const { status, data } = await json(app, "/services", { auth: AUTH_TOKEN });
    expect(status).toBe(200);
    expect(data.modules.map((m: any) => m.name)).toContain("mgr-alpha");
    expect(data.modules.map((m: any) => m.name)).toContain("services");
  });

  test("POST /services/reload/:name reloads a module", async () => {
    writeService("mgr-reloadable", { requiresAuth: false, response: { v: 1 } });
    const { app } = await createWithManager();

    let { data } = await json(app, "/mgr-reloadable");
    expect(data.v).toBe(1);

    writeService("mgr-reloadable", { requiresAuth: false, response: { v: 2 } });
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
    const removed = reload.data.results.find((r: any) => r.name === "mgr-temporary");
    expect(removed?.action).toBe("removed");

    ({ status } = await json(app, "/mgr-temporary"));
    expect(status).toBe(404);
  });

  test("GET /services/manifest returns machine-readable manifest", async () => {
    writeService("mgr-manifest-test", { requiresAuth: false });
    const { app } = await createWithManager();

    const { status, data } = await json(app, "/services/manifest", { auth: AUTH_TOKEN });
    expect(status).toBe(200);

    // Has the right shape
    expect(data.services).toBeDefined();
    expect(data.routes).toBeDefined();
    expect(data.count).toBeGreaterThanOrEqual(2); // services manager + test service
    expect(Array.isArray(data.services)).toBe(true);
    expect(Array.isArray(data.routes)).toBe(true);

    // Services manager appears with its own routeDocs
    const mgr = data.services.find((s: any) => s.name === "services");
    expect(mgr).toBeDefined();
    expect(mgr.capabilities).toContain("routes");
    expect(mgr.routes).toBeDefined();
    expect(mgr.routes["GET /manifest"]).toBeDefined();

    // Test service appears
    const testSvc = data.services.find((s: any) => s.name === "mgr-manifest-test");
    expect(testSvc).toBeDefined();
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
