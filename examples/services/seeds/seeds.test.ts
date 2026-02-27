/**
 * Seeds service tests — provenance tracking and conformance manifests.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../../../src/core/server.js";

const TEST_DIR = join(import.meta.dir, ".tmp-services-seeds");
const AUTH_TOKEN = "test-token-12345";
const originalToken = process.env.VERS_AUTH_TOKEN;

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

async function createWithSeeds() {
  const seedsSrc = join(import.meta.dir, "index.ts");
  const seedsDst = join(TEST_DIR, "seeds");
  mkdirSync(seedsDst, { recursive: true });
  const content = readFileSync(seedsSrc, "utf-8").replace(
    '"../src/core/types.js"',
    `"${join(import.meta.dir, "..", "..", "..", "src", "core", "types.js")}"`,
  );
  writeFileSync(join(seedsDst, "index.ts"), content);
  return createServer({ servicesDir: TEST_DIR });
}

const SAMPLE_SEED = {
  name: "coordination",
  contentHash: "sha256:abc123def456",
  versionLabel: "1.0",
  method: "germination",
  services: ["board", "feed", "log"],
  requiredCapabilities: ["hosting.web", "state.persist", "agent.spawn"],
  optionalCapabilities: ["state.snapshot", "state.branch"],
  sourceUrl: "https://example.com/coordination/SEED.md",
};

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
// Registration
// =============================================================================

describe("seed registration", () => {
  test("POST /seeds/register records a seed", async () => {
    const { app } = await createWithSeeds();

    const { status, data } = await json(app, "/seeds/register", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: SAMPLE_SEED,
    });

    expect(status).toBe(201);
    expect(data.action).toBe("registered");
    expect(data.seed.name).toBe("coordination");
    expect(data.seed.contentHash).toBe("sha256:abc123def456");
    expect(data.seed.conformance).toBe("UNTESTED");
    expect(data.seed.services).toEqual(["board", "feed", "log"]);
    expect(data.seed.installed).toBeDefined();
  });

  test("requires name and contentHash", async () => {
    const { app } = await createWithSeeds();

    const { status, data } = await json(app, "/seeds/register", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "missing-hash" },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("contentHash");
  });

  test("requires sha256: prefix on contentHash", async () => {
    const { app } = await createWithSeeds();

    const { status, data } = await json(app, "/seeds/register", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "bad-hash", contentHash: "abc123" },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("sha256:");
  });

  test("rejects duplicate content hash", async () => {
    const { app } = await createWithSeeds();

    await json(app, "/seeds/register", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: SAMPLE_SEED,
    });

    const { status, data } = await json(app, "/seeds/register", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: SAMPLE_SEED,
    });
    expect(status).toBe(409);
    expect(data.error).toContain("already registered");
  });

  test("requires auth", async () => {
    const { app } = await createWithSeeds();

    const { status } = await json(app, "/seeds/register", {
      method: "POST",
      body: SAMPLE_SEED,
    });
    expect(status).toBe(401);
  });

  test("persists across registry reloads", async () => {
    const { app } = await createWithSeeds();

    await json(app, "/seeds/register", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: SAMPLE_SEED,
    });

    // Registry file should exist
    const regPath = join(TEST_DIR, ".seeds.json");
    expect(existsSync(regPath)).toBe(true);
    const stored = JSON.parse(readFileSync(regPath, "utf-8"));
    expect(stored.seeds.length).toBe(1);
    expect(stored.seeds[0].contentHash).toBe("sha256:abc123def456");
  });
});

// =============================================================================
// Inventory & lookup
// =============================================================================

describe("seed inventory", () => {
  test("GET /seeds/inventory lists all seeds", async () => {
    const { app } = await createWithSeeds();

    await json(app, "/seeds/register", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: SAMPLE_SEED,
    });
    await json(app, "/seeds/register", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { ...SAMPLE_SEED, name: "chat", contentHash: "sha256:def789" },
    });

    const { status, data } = await json(app, "/seeds/inventory", { auth: AUTH_TOKEN });
    expect(status).toBe(200);
    expect(data.count).toBe(2);
    expect(data.seeds.map((s: any) => s.name)).toContain("coordination");
    expect(data.seeds.map((s: any) => s.name)).toContain("chat");
  });

  test("GET /seeds/:hash returns a specific seed", async () => {
    const { app } = await createWithSeeds();

    await json(app, "/seeds/register", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: SAMPLE_SEED,
    });

    const { status, data } = await json(app, "/seeds/sha256:abc123def456", { auth: AUTH_TOKEN });
    expect(status).toBe(200);
    expect(data.name).toBe("coordination");
    expect(data.services).toEqual(["board", "feed", "log"]);
  });

  test("returns 404 for unknown hash", async () => {
    const { app } = await createWithSeeds();

    const { status } = await json(app, "/seeds/sha256:nonexistent", { auth: AUTH_TOKEN });
    expect(status).toBe(404);
  });

  test("inventory requires auth", async () => {
    const { app } = await createWithSeeds();

    const { status } = await json(app, "/seeds/inventory");
    expect(status).toBe(401);
  });
});

// =============================================================================
// Update & delete
// =============================================================================

describe("seed updates", () => {
  test("PATCH /seeds/:hash updates conformance", async () => {
    const { app } = await createWithSeeds();

    await json(app, "/seeds/register", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: SAMPLE_SEED,
    });

    const { status, data } = await json(app, "/seeds/sha256:abc123def456", {
      method: "PATCH",
      auth: AUTH_TOKEN,
      body: {
        conformance: "FULL",
        testResults: { core: { passed: 8, failed: 0, skipped: 0 } },
        lastVerified: new Date().toISOString(),
      },
    });

    expect(status).toBe(200);
    expect(data.action).toBe("updated");
    expect(data.seed.conformance).toBe("FULL");
    expect(data.seed.testResults.core.passed).toBe(8);
    expect(data.seed.lastVerified).toBeDefined();
  });

  test("DELETE /seeds/:hash removes a record", async () => {
    const { app } = await createWithSeeds();

    await json(app, "/seeds/register", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: SAMPLE_SEED,
    });

    const del = await json(app, "/seeds/sha256:abc123def456", {
      method: "DELETE",
      auth: AUTH_TOKEN,
    });
    expect(del.data.action).toBe("removed");
    expect(del.data.seed.name).toBe("coordination");

    const { data } = await json(app, "/seeds/inventory", { auth: AUTH_TOKEN });
    expect(data.count).toBe(0);
  });
});

// =============================================================================
// Conformance manifest (public)
// =============================================================================

describe("conformance manifest", () => {
  test("GET /seeds/conformance is public (no auth)", async () => {
    const { app } = await createWithSeeds();

    const { status, data } = await json(app, "/seeds/conformance");
    expect(status).toBe(200);
    expect(data.v).toBe("seed-spec/0.5");
    expect(data.type).toBe("conformance.manifest");
    expect(data.seeds).toEqual([]);
    expect(data.count).toBe(0);
  });

  test("includes registered seeds with capability status", async () => {
    const { app } = await createWithSeeds();

    await json(app, "/seeds/register", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: SAMPLE_SEED,
    });

    const { data } = await json(app, "/seeds/conformance");
    expect(data.seeds.length).toBe(1);

    const entry = data.seeds[0];
    expect(entry.name).toBe("coordination");
    expect(entry.content_hash).toBe("sha256:abc123def456");
    expect(entry.conformanceLevel).toBe("UNTESTED");

    // hosting.web and state.persist are base capabilities — should be met
    expect(entry.capabilities.implemented).toContain("hosting.web");
    expect(entry.capabilities.implemented).toContain("state.persist");

    // agent.spawn is NOT provided by any loaded service in this test — should be missing
    expect(entry.capabilities.missing).toContain("agent.spawn");
  });
});

// =============================================================================
// Capability check
// =============================================================================

describe("capability check", () => {
  test("POST /seeds/check reports met/missing capabilities", async () => {
    const { app } = await createWithSeeds();

    const { status, data } = await json(app, "/seeds/check", {
      method: "POST",
      body: {
        capabilities: ["hosting.web", "state.persist", "agent.spawn", "state.branch"],
      },
    });

    expect(status).toBe(200);
    expect(data.met).toContain("hosting.web");
    expect(data.met).toContain("state.persist");
    expect(data.missing).toContain("agent.spawn");
    expect(data.missing).toContain("state.branch");
    expect(data.canGerminate).toBe(false);
  });

  test("canGerminate is true when all capabilities are met", async () => {
    const { app } = await createWithSeeds();

    const { data } = await json(app, "/seeds/check", {
      method: "POST",
      body: {
        capabilities: ["hosting.web", "state.persist", "event.trigger"],
      },
    });

    expect(data.canGerminate).toBe(true);
    expect(data.missing).toEqual([]);
  });

  test("check is public (no auth)", async () => {
    const { app } = await createWithSeeds();

    const { status } = await json(app, "/seeds/check", {
      method: "POST",
      body: { capabilities: ["hosting.web"] },
    });
    expect(status).toBe(200);
  });

  test("returns substrate capabilities", async () => {
    const { app } = await createWithSeeds();

    const { data } = await json(app, "/seeds/check", {
      method: "POST",
      body: { capabilities: ["hosting.web"] },
    });

    expect(data.substrate).toContain("hosting.web");
    expect(data.substrate).toContain("state.persist");
    expect(data.substrate).toContain("event.trigger");
    // seeds service contributes reef.seeds capabilities
    expect(data.substrate).toContain("reef.seeds");
  });
});
