/**
 * Services manager tests.
 *
 * Moved from tests/server.test.ts — tests the /services management API.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../../src/core/server.js";

const TEST_DIR = join(import.meta.dir, ".tmp-services-mgr");
const AUTH_TOKEN = "test-token-12345";
const originalToken = process.env.VERS_AUTH_TOKEN;

function writeService(name: string, opts: { response?: Record<string, unknown>; requiresAuth?: boolean } = {}) {
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
  if (opts.auth) headers.Authorization = `Bearer ${opts.auth}`;
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
    expect(data.substrate).toBeDefined();
    expect(data.count).toBeGreaterThanOrEqual(2); // services manager + test service
    expect(Array.isArray(data.services)).toBe(true);
    expect(Array.isArray(data.routes)).toBe(true);

    // Substrate capabilities — base set always present
    const caps = data.substrate.capabilities;
    expect(caps).toContain("hosting.web");
    expect(caps).toContain("state.persist");
    expect(caps).toContain("event.trigger");

    // Reef-specific capabilities from the services manager itself
    expect(caps).toContain("reef.reload");
    expect(caps).toContain("reef.export");
    expect(caps).toContain("reef.manifest");

    // Services manager appears with its own routeDocs
    const mgr = data.services.find((s: any) => s.name === "services");
    expect(mgr).toBeDefined();
    expect(mgr.features).toContain("routes");
    expect(mgr.routes).toBeDefined();
    expect(mgr.routes["GET /manifest"]).toBeDefined();

    // Test service appears
    const testSvc = data.services.find((s: any) => s.name === "mgr-manifest-test");
    expect(testSvc).toBeDefined();
  });

  test("manifest includes service-contributed capabilities", async () => {
    // Write a service that declares seed capabilities
    const dir = join(TEST_DIR, "mgr-cap-provider");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "index.ts"),
      `
import { Hono } from "hono";
const routes = new Hono();
routes.get("/", (c) => c.json({ ok: true }));
export default {
  name: "mgr-cap-provider",
  routes,
  requiresAuth: false,
  capabilities: ["agent.spawn", "agent.lifecycle"],
};
`,
    );

    const { app } = await createWithManager();

    const { data } = await json(app, "/services/manifest", { auth: AUTH_TOKEN });

    // Service-contributed capabilities appear in substrate
    expect(data.substrate.capabilities).toContain("agent.spawn");
    expect(data.substrate.capabilities).toContain("agent.lifecycle");

    // And in the service's own entry
    const svc = data.services.find((s: any) => s.name === "mgr-cap-provider");
    expect(svc.provides).toEqual(["agent.spawn", "agent.lifecycle"]);
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

  // ===========================================================================
  // Capability check
  // ===========================================================================

  test("POST /services/check reports met/missing capabilities", async () => {
    const { app } = await createWithManager();

    const { status, data } = await json(app, "/services/check", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { capabilities: ["hosting.web", "state.persist", "agent.spawn", "state.branch"] },
    });

    expect(status).toBe(200);
    expect(data.met).toContain("hosting.web");
    expect(data.met).toContain("state.persist");
    expect(data.missing).toContain("agent.spawn");
    expect(data.missing).toContain("state.branch");
    expect(data.canGerminate).toBe(false);
  });

  test("canGerminate is true when all capabilities met", async () => {
    const { app } = await createWithManager();

    const { data } = await json(app, "/services/check", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { capabilities: ["hosting.web", "state.persist", "event.trigger"] },
    });

    expect(data.canGerminate).toBe(true);
    expect(data.missing).toEqual([]);
  });

  // ===========================================================================
  // Seed registration & conformance
  // ===========================================================================

  test("POST /services/seeds/register records seed metadata", async () => {
    const { app } = await createWithManager();

    const { status, data } = await json(app, "/services/seeds/register", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: {
        contentHash: "sha256:abc123",
        name: "coordination",
        versionLabel: "1.0",
        method: "germination",
        requiredCapabilities: ["hosting.web", "agent.spawn"],
      },
    });

    expect(status).toBe(201);
    expect(data.action).toBe("registered");
    expect(data.seed.name).toBe("coordination");
    expect(data.seed.conformance).toBe("UNTESTED");
  });

  test("seed registration rejects duplicates", async () => {
    const { app } = await createWithManager();

    await json(app, "/services/seeds/register", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { contentHash: "sha256:dup123", name: "dupe-seed" },
    });

    const { status } = await json(app, "/services/seeds/register", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { contentHash: "sha256:dup123", name: "dupe-seed" },
    });
    expect(status).toBe(409);
  });

  test("seed registration requires sha256: prefix", async () => {
    const { app } = await createWithManager();

    const { status, data } = await json(app, "/services/seeds/register", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { contentHash: "abc123", name: "bad-hash" },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("sha256:");
  });

  test("PATCH /services/seeds/:hash updates conformance", async () => {
    const { app } = await createWithManager();

    await json(app, "/services/seeds/register", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { contentHash: "sha256:patch123", name: "patchable" },
    });

    const { status, data } = await json(app, "/services/seeds/sha256:patch123", {
      method: "PATCH",
      auth: AUTH_TOKEN,
      body: {
        conformance: "FULL",
        testResults: { core: { passed: 8, failed: 0, skipped: 0 } },
        lastVerified: "2026-02-26T00:00:00Z",
      },
    });

    expect(status).toBe(200);
    expect(data.seed.conformance).toBe("FULL");
    expect(data.seed.testResults.core.passed).toBe(8);
  });

  test("GET /services/conformance returns conformance manifest", async () => {
    const { app } = await createWithManager();

    // Register a seed
    await json(app, "/services/seeds/register", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: {
        contentHash: "sha256:conf123",
        name: "test-seed",
        versionLabel: "1.0",
        requiredCapabilities: ["hosting.web", "agent.spawn"],
      },
    });

    // Write a fake installer registry with a service tagged to this seed
    writeFileSync(
      join(TEST_DIR, ".installer.json"),
      JSON.stringify({
        installed: [
          {
            dirName: "board",
            source: "local",
            type: "local",
            installedAt: new Date().toISOString(),
            seed: "sha256:conf123",
          },
          {
            dirName: "feed",
            source: "local",
            type: "local",
            installedAt: new Date().toISOString(),
            seed: "sha256:conf123",
          },
          { dirName: "unrelated", source: "local", type: "local", installedAt: new Date().toISOString() },
        ],
      }),
    );

    const { status, data } = await json(app, "/services/conformance", { auth: AUTH_TOKEN });
    expect(status).toBe(200);
    expect(data.v).toBe("seed-spec/0.5");
    expect(data.type).toBe("conformance.manifest");
    expect(data.count).toBe(1);

    const seed = data.seeds[0];
    expect(seed.name).toBe("test-seed");
    expect(seed.content_hash).toBe("sha256:conf123");
    expect(seed.services).toContain("board");
    expect(seed.services).toContain("feed");
    expect(seed.services).not.toContain("unrelated");
    expect(seed.capabilities.implemented).toContain("hosting.web");
    expect(seed.capabilities.missing).toContain("agent.spawn");
  });

  // ===========================================================================
  // Deploy
  // ===========================================================================

  test("POST /services/deploy validates, loads, and verifies", async () => {
    writeService("deploy-good");
    const { app } = await createWithManager();

    const { status, data } = await json(app, "/services/deploy", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "deploy-good" },
    });

    expect(status).toBe(200);
    expect(data.deployed).toBe(true);
    expect(data.steps.length).toBeGreaterThanOrEqual(3); // validate, test (skipped), load, verify
    expect(data.steps.find((s: any) => s.step === "validate").status).toBe("passed");
    expect(data.steps.find((s: any) => s.step === "test").status).toBe("skipped");
    expect(data.steps.find((s: any) => s.step === "load").status).toBe("passed");
    expect(data.steps.find((s: any) => s.step === "verify").status).toBe("passed");
  });

  test("deploy fails on missing directory", async () => {
    const { app } = await createWithManager();

    const { status, data } = await json(app, "/services/deploy", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "nonexistent" },
    });

    expect(status).toBe(400);
    expect(data.deployed).toBe(false);
    expect(data.steps[0].step).toBe("validate");
    expect(data.steps[0].status).toBe("failed");
  });

  test("deploy fails on missing index.ts", async () => {
    mkdirSync(join(TEST_DIR, "no-index"), { recursive: true });
    writeFileSync(join(TEST_DIR, "no-index", "README.md"), "nothing useful");
    const { app } = await createWithManager();

    const { status, data } = await json(app, "/services/deploy", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "no-index" },
    });

    expect(status).toBe(400);
    expect(data.deployed).toBe(false);
    expect(data.steps[0].status).toBe("failed");
    expect(data.steps[0].detail).toContain("index.ts");
  });

  test("deploy fails on invalid module export", async () => {
    const dir = join(TEST_DIR, "bad-export");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.ts"), `export default { noName: true };`);
    const { app } = await createWithManager();

    const { status, data } = await json(app, "/services/deploy", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "bad-export" },
    });

    expect(status).toBe(400);
    expect(data.deployed).toBe(false);
    expect(data.steps[0].step).toBe("validate");
    expect(data.steps[0].status).toBe("failed");
    expect(data.steps[0].detail).toContain("name");
  });

  test("deploy requires name", async () => {
    const { app } = await createWithManager();

    const { status, data } = await json(app, "/services/deploy", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: {},
    });

    expect(status).toBe(400);
    expect(data.error).toContain("name");
  });

  test("deploy with passing tests succeeds", async () => {
    // Write a service with a passing test
    const dir = join(TEST_DIR, "deploy-tested");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "index.ts"),
      `
import { Hono } from "hono";
const routes = new Hono();
routes.get("/", (c) => c.json({ ok: true }));
export default { name: "deploy-tested", routes };
`,
    );
    writeFileSync(
      join(dir, "deploy-tested.test.ts"),
      `
import { test, expect } from "bun:test";
test("basic math", () => { expect(1 + 1).toBe(2); });
`,
    );

    const { app } = await createWithManager();

    const { status, data } = await json(app, "/services/deploy", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "deploy-tested" },
    });

    expect(status).toBe(200);
    expect(data.deployed).toBe(true);
    const testStep = data.steps.find((s: any) => s.step === "test");
    expect(testStep.status).toBe("passed");
    expect(testStep.detail).toContain("1 passed");
  });

  test("deploy with failing tests stops before loading", async () => {
    const dir = join(TEST_DIR, "deploy-fail-test");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "index.ts"),
      `
import { Hono } from "hono";
const routes = new Hono();
routes.get("/", (c) => c.json({ ok: true }));
export default { name: "deploy-fail-test", routes };
`,
    );
    writeFileSync(
      join(dir, "deploy-fail-test.test.ts"),
      `
import { test, expect } from "bun:test";
test("this fails", () => { expect(1).toBe(2); });
`,
    );

    const { app } = await createWithManager();

    const { status, data } = await json(app, "/services/deploy", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "deploy-fail-test" },
    });

    expect(status).toBe(400);
    expect(data.deployed).toBe(false);
    const testStep = data.steps.find((s: any) => s.step === "test");
    expect(testStep.status).toBe("failed");
    // Should not have a load step
    expect(data.steps.find((s: any) => s.step === "load")).toBeUndefined();
  });
});
