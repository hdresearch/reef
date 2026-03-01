import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createTestHarness, type TestHarness } from "../../src/core/testing.js";
import docs from "./index.js";

// A dummy service with routeDocs for the docs service to discover
const dummy = {
  name: "dummy",
  description: "A test service",
  routes: new Hono().get("/items", (c) => c.json([])),
  requiresAuth: false,
  routeDocs: {
    "GET /items": {
      description: "List items",
      params: { limit: { description: "Max results", default: "50" } },
      response: "{ items: Item[] }",
    },
    "POST /items": {
      description: "Create an item",
      body: "{ name: string }",
      response: "{ id, name, createdAt }",
    },
  },
};

let t: TestHarness;
const setup = (async () => {
  t = await createTestHarness({ services: [dummy, docs] });
})();
afterAll(() => t?.cleanup());

describe("docs", () => {
  test("returns JSON docs for all services", async () => {
    await setup;
    const { status, data } = await t.json<any>("/docs");
    expect(status).toBe(200);
    expect(data.services).toBeDefined();
    // Should include the dummy service
    const dummyDocs = data.services.find((s: any) => s.name === "dummy");
    expect(dummyDocs).toBeDefined();
    expect(dummyDocs.routes).toBeDefined();
  });

  test("returns docs for a single service", async () => {
    await setup;
    const { status, data } = await t.json<any>("/docs/dummy");
    expect(status).toBe(200);
    expect(data.name).toBe("dummy");
    expect(data.routes).toBeDefined();
  });

  test("returns 404 for unknown service", async () => {
    await setup;
    const { status } = await t.json("/docs/nonexistent");
    expect(status).toBe(404);
  });

  test("returns HTML UI", async () => {
    await setup;
    const res = await t.fetch("/docs/ui");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("dummy");
  });

  test("does not require auth", async () => {
    await setup;
    // No auth header — should still work
    const { status } = await t.json("/docs");
    expect(status).toBe(200);
  });
});
