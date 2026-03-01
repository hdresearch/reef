import { afterAll, describe, expect, test } from "bun:test";
import { createTestHarness, type TestHarness } from "../../../src/core/testing.js";
import usage from "./index.js";

let t: TestHarness;
const setup = (async () => {
  t = await createTestHarness({ services: [usage] });
})();
afterAll(() => t?.cleanup());

describe("usage", () => {
  test("records a session", async () => {
    await setup;
    const { status, data } = await t.json("/usage/sessions", {
      method: "POST",
      auth: true,
      body: {
        sessionId: "sess-001",
        agent: "worker-1",
        model: "claude-sonnet-4",
        tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, total: 1800 },
        cost: { input: 0.003, output: 0.0075, cacheRead: 0.0002, cacheWrite: 0.000375, total: 0.011075 },
        turns: 5,
        toolCalls: { bash: 3, read: 2 },
        startedAt: new Date(Date.now() - 60000).toISOString(),
        endedAt: new Date().toISOString(),
      },
    });
    expect(status).toBe(201);
    expect(data.sessionId).toBe("sess-001");
  });

  test("lists sessions", async () => {
    await setup;
    const { status, data } = await t.json<{ sessions: any[]; count: number }>("/usage/sessions", {
      auth: true,
    });
    expect(status).toBe(200);
    expect(data.sessions.length).toBeGreaterThanOrEqual(1);
  });

  test("filters sessions by agent", async () => {
    await setup;
    const { data } = await t.json<{ sessions: any[] }>("/usage/sessions?agent=worker-1", {
      auth: true,
    });
    for (const s of data.sessions) {
      expect(s.agent).toBe("worker-1");
    }
  });

  test("records a VM lifecycle event", async () => {
    await setup;
    const { status, data } = await t.json("/usage/vms", {
      method: "POST",
      auth: true,
      body: {
        vmId: "vm-usage-001",
        role: "worker",
        agent: "coordinator",
        createdAt: new Date().toISOString(),
      },
    });
    expect(status).toBe(201);
    expect(data.vmId).toBe("vm-usage-001");
  });

  test("lists VM records", async () => {
    await setup;
    const { status, data } = await t.json<{ vms: any[]; count: number }>("/usage/vms", {
      auth: true,
    });
    expect(status).toBe(200);
    expect(data.vms.length).toBeGreaterThanOrEqual(1);
  });

  test("returns usage summary", async () => {
    await setup;
    const { status, data } = await t.json<any>("/usage", { auth: true });
    expect(status).toBe(200);
    expect(data.totals).toBeDefined();
    expect(data.totals.cost).toBeDefined();
    expect(data.totals.tokens).toBeDefined();
  });

  test("requires auth", async () => {
    await setup;
    const { status } = await t.json("/usage");
    expect(status).toBe(401);
  });
});
