import { afterAll, describe, expect, test } from "bun:test";
import { createTestHarness, type TestHarness } from "../../../src/core/testing.js";
import log from "./index.js";

let t: TestHarness;
const setup = (async () => {
  t = await createTestHarness({ services: [log] });
})();
afterAll(() => t?.cleanup());

describe("log", () => {
  test("appends an entry", async () => {
    await setup;
    const { status, data } = await t.json("/log", {
      method: "POST",
      auth: true,
      body: { text: "Did some work", agent: "test-agent" },
    });
    expect(status).toBe(201);
    expect(data.text).toBe("Did some work");
    expect(data.agent).toBe("test-agent");
    expect(data.timestamp).toBeDefined();
  });

  test("lists entries", async () => {
    await setup;
    const { status, data } = await t.json<{ entries: any[]; count: number }>("/log", {
      auth: true,
    });
    expect(status).toBe(200);
    expect(data.entries.length).toBeGreaterThanOrEqual(1);
  });

  test("filters by last duration", async () => {
    await setup;
    const { status, data } = await t.json<{ entries: any[] }>("/log?last=1h", {
      auth: true,
    });
    expect(status).toBe(200);
    // All entries should be within the last hour
    const oneHourAgo = Date.now() - 3600000;
    for (const e of data.entries) {
      expect(new Date(e.timestamp).getTime()).toBeGreaterThan(oneHourAgo);
    }
  });

  test("returns raw text format", async () => {
    await setup;
    const res = await t.fetch("/log/raw", { auth: true });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Did some work");
  });

  test("requires text field", async () => {
    await setup;
    const { status } = await t.json("/log", {
      method: "POST",
      auth: true,
      body: { agent: "test" },
    });
    expect(status).toBe(400);
  });

  test("requires auth", async () => {
    await setup;
    const { status } = await t.json("/log");
    expect(status).toBe(401);
  });
});
