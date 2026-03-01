import { afterAll, describe, expect, test } from "bun:test";
import { createTestHarness, type TestHarness } from "../../../src/core/testing.js";
import journal from "./index.js";

let t: TestHarness;
const setup = (async () => {
  t = await createTestHarness({ services: [journal] });
})();
afterAll(() => t?.cleanup());

describe("journal", () => {
  test("writes an entry", async () => {
    await setup;
    const { status, data } = await t.json("/journal", {
      method: "POST",
      auth: true,
      body: { text: "Feeling good about progress", author: "agent-1", mood: "optimistic" },
    });
    expect(status).toBe(201);
    expect(data.text).toBe("Feeling good about progress");
    expect(data.mood).toBe("optimistic");
    expect(data.timestamp).toBeDefined();
  });

  test("lists entries", async () => {
    await setup;
    const { status, data } = await t.json<{ entries: any[]; count: number }>("/journal", {
      auth: true,
    });
    expect(status).toBe(200);
    expect(data.entries.length).toBeGreaterThanOrEqual(1);
  });

  test("returns raw text format", async () => {
    await setup;
    const res = await t.fetch("/journal/raw", { auth: true });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Feeling good about progress");
  });

  test("requires text field", async () => {
    await setup;
    const { status } = await t.json("/journal", {
      method: "POST",
      auth: true,
      body: { author: "test" },
    });
    expect(status).toBe(400);
  });

  test("requires auth", async () => {
    await setup;
    const { status } = await t.json("/journal");
    expect(status).toBe(401);
  });
});
