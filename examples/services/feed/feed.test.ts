import { describe, test, expect, afterAll } from "bun:test";
import { createTestHarness, type TestHarness } from "../../../src/core/testing.js";
import feed from "./index.js";

let t: TestHarness;
const setup = (async () => {
  t = await createTestHarness({ services: [feed] });
})();
afterAll(() => t?.cleanup());

describe("feed", () => {
  test("publishes an event", async () => {
    await setup;
    const { status, data } = await t.json("/feed/events", {
      method: "POST",
      auth: true,
      body: { agent: "test-agent", type: "task_started", summary: "Working on it" },
    });
    expect(status).toBe(201);
    expect(data.agent).toBe("test-agent");
    expect(data.type).toBe("task_started");
    expect(data.id).toBeDefined();
    expect(data.timestamp).toBeDefined();
  });

  test("lists events", async () => {
    await setup;
    const { status, data } = await t.json<any[]>("/feed/events", {
      auth: true,
    });
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  test("filters by agent", async () => {
    await setup;
    await t.json("/feed/events", {
      method: "POST",
      auth: true,
      body: { agent: "filter-agent", type: "finding", summary: "Found it" },
    });

    const { data } = await t.json<any[]>("/feed/events?agent=filter-agent", {
      auth: true,
    });
    for (const e of data) {
      expect(e.agent).toBe("filter-agent");
    }
  });

  test("filters by type", async () => {
    await setup;
    const { data } = await t.json<any[]>("/feed/events?type=task_started", {
      auth: true,
    });
    for (const e of data) {
      expect(e.type).toBe("task_started");
    }
  });

  test("gets event by id", async () => {
    await setup;
    const { data: created } = await t.json<any>("/feed/events", {
      method: "POST",
      auth: true,
      body: { agent: "test", type: "custom", summary: "Get by ID" },
    });

    const { status, data } = await t.json(`/feed/events/${created.id}`, { auth: true });
    expect(status).toBe(200);
    expect(data.summary).toBe("Get by ID");
  });

  test("returns stats", async () => {
    await setup;
    const { status, data } = await t.json<any>("/feed/stats", { auth: true });
    expect(status).toBe(200);
    expect(data.total).toBeGreaterThanOrEqual(1);
  });

  test("limits results", async () => {
    await setup;
    const { data } = await t.json<any[]>("/feed/events?limit=1", { auth: true });
    expect(data.length).toBeLessThanOrEqual(1);
  });

  test("requires auth", async () => {
    await setup;
    const { status } = await t.json("/feed/events");
    expect(status).toBe(401);
  });

  test("panel endpoint returns HTML", async () => {
    await setup;
    const res = await t.fetch("/feed/_panel", { auth: true });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("panel-feed");
  });
});
