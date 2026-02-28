import { describe, test, expect, afterAll } from "bun:test";
import { createReef } from "./reef.js";

/**
 * Tests for the reef HTTP layer.
 *
 * These test service-only mode (no agent loop) and the reef API routes.
 * Real branch execution is tested in loop.test.ts with mock handles.
 */

const TOKEN = "test-token-reef";
process.env.VERS_AUTH_TOKEN = TOKEN;

const headers = {
  "Authorization": `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

const noAuth = { "Content-Type": "application/json" };

describe("reef — service-only mode", () => {
  let app: any;
  let cleanup: () => void;

  const setup = (async () => {
    const reef = await createReef({ server: { modules: [] } });
    app = reef.app;
    cleanup = () => {};
  })();
  afterAll(() => cleanup?.());

  async function json(path: string, opts?: { method?: string; body?: unknown; auth?: boolean }) {
    await setup;
    const h = opts?.auth === false ? noAuth : headers;
    const res = await app.fetch(
      new Request(`http://localhost${path}`, {
        method: opts?.method ?? "GET",
        headers: h,
        body: opts?.body ? JSON.stringify(opts.body) : undefined,
      }),
    );
    return { status: res.status, data: await res.json() };
  }

  test("GET /reef/state — service-only mode", async () => {
    const { status, data } = await json("/reef/state");
    expect(status).toBe(200);
    expect(data.mode).toBe("service-only");
    expect(data.services).toBeArray();
  });

  test("GET /reef/tree — empty in service-only", async () => {
    const { status, data } = await json("/reef/tree");
    expect(status).toBe(200);
    expect(data.main).toEqual([]);
  });

  test("GET /reef/branches — empty in service-only", async () => {
    const { status, data } = await json("/reef/branches");
    expect(status).toBe(200);
    expect(data.branches).toEqual([]);
  });

  test("POST /reef/submit — 503 without agent loop", async () => {
    const { status, data } = await json("/reef/submit", {
      method: "POST",
      body: { task: "build something" },
    });
    expect(status).toBe(503);
    expect(data.error).toContain("not configured");
  });

  test("POST /reef/submit — 400 without task", async () => {
    // Even in agent mode this would fail, but test the validation path
    const { status } = await json("/reef/submit", {
      method: "POST",
      body: {},
    });
    // In service-only mode, we get 503 before validation
    expect(status).toBe(503);
  });

  test("reef routes require auth", async () => {
    const { status } = await json("/reef/state", { auth: false });
    expect(status).toBe(401);
  });

  test("GET /health still works", async () => {
    await setup;
    const res = await app.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
  });

  test("GET /reef/events — SSE stream connects", async () => {
    await setup;
    const res = await app.fetch(
      new Request("http://localhost/reef/events", { headers }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // Read the first chunk (should be the connection comment)
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = typeof value === "string" ? value : new TextDecoder().decode(new Uint8Array(value));
    expect(text).toContain(": connected");
    reader.cancel();
  });
});

describe("reef — with mock agent loop", () => {
  // Test that the agent loop integrates properly with the HTTP layer
  // by creating a reef with agent config that will fail to actually
  // execute branches (no real VMs) but validates the API contract.

  let app: any;

  const setup = (async () => {
    const reef = await createReef({
      server: { modules: [] },
      agent: {
        commitId: "fake-commit-for-testing",
        anthropicApiKey: "fake-key",
        model: "test-model",
        systemPrompt: "You are a test agent.",
        maxConcurrent: 2,
      },
    });
    app = reef.app;
  })();

  test("GET /reef/state — agent mode", async () => {
    await setup;
    const res = await app.fetch(new Request("http://localhost/reef/state", { headers }));
    const data = await res.json();

    expect(data.mode).toBe("agent");
    expect(data.mainLength).toBe(1); // system prompt
    expect(data.activeBranches).toBe(0);
    expect(data.pendingMerges).toBe(0);
  });

  test("GET /reef/tree — has system prompt", async () => {
    await setup;
    const res = await app.fetch(new Request("http://localhost/reef/tree", { headers }));
    const data = await res.json();

    expect(data.main.length).toBe(1);
    expect(data.main[0].role).toBe("system");
    expect(data.main[0].content).toBe("You are a test agent.");
  });

  test("POST /reef/submit — creates a branch (will fail to execute)", async () => {
    await setup;
    const res = await app.fetch(new Request("http://localhost/reef/submit", {
      method: "POST",
      headers,
      body: JSON.stringify({ task: "Build a test service." }),
    }));
    const data = await res.json();

    // Branch gets created even though execution will fail (no real VM)
    expect(res.status).toBe(201);
    expect(data.branch).toBeString();
    expect(data.status).toBeString();
    expect(data.trigger).toBe("Build a test service.");
  });

  test("POST /reef/submit — validates task field", async () => {
    await setup;
    const res = await app.fetch(new Request("http://localhost/reef/submit", {
      method: "POST",
      headers,
      body: JSON.stringify({ notTask: 123 }),
    }));
    expect(res.status).toBe(400);
  });

  test("GET /reef/branches — shows submitted branch", async () => {
    await setup;
    const res = await app.fetch(new Request("http://localhost/reef/branches", { headers }));
    const data = await res.json();

    expect(data.branches.length).toBeGreaterThan(0);
    const b = data.branches.find((b: any) => b.trigger === "Build a test service.");
    expect(b).toBeDefined();
  });

  test("GET /reef/branches/:name — 404 for unknown", async () => {
    await setup;
    const res = await app.fetch(new Request("http://localhost/reef/branches/nope", { headers }));
    expect(res.status).toBe(404);
  });
});
