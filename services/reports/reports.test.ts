import { afterAll, describe, expect, test } from "bun:test";
import { createTestHarness, type TestHarness } from "../../src/core/testing.js";
import reports from "./index.js";

let t: TestHarness;
const setup = (async () => {
  t = await createTestHarness({ services: [reports] });
})();
afterAll(() => t?.cleanup());

describe("reports", () => {
  test("creates a report", async () => {
    await setup;
    const { status, data } = await t.json("/reports", {
      method: "POST",
      auth: true,
      body: {
        title: "Sprint 1 Summary",
        content: "# Sprint 1\n\nDone a lot of work.",
        author: "coordinator",
        tags: ["sprint", "summary"],
      },
    });
    expect(status).toBe(201);
    expect(data.title).toBe("Sprint 1 Summary");
    expect(data.content).toContain("Sprint 1");
    expect(data.id).toBeDefined();
  });

  test("lists reports", async () => {
    await setup;
    const { status, data } = await t.json<{ reports: any[]; count: number }>("/reports", {
      auth: true,
    });
    expect(status).toBe(200);
    expect(data.reports.length).toBeGreaterThanOrEqual(1);
  });

  test("gets a report by id", async () => {
    await setup;
    const { data: created } = await t.json<any>("/reports", {
      method: "POST",
      auth: true,
      body: { title: "Get by ID", content: "test content", author: "test" },
    });

    const { status, data } = await t.json(`/reports/${created.id}`, { auth: true });
    expect(status).toBe(200);
    expect(data.title).toBe("Get by ID");
  });

  test("deletes a report", async () => {
    await setup;
    const { data: created } = await t.json<any>("/reports", {
      method: "POST",
      auth: true,
      body: { title: "Delete me", content: "bye", author: "test" },
    });

    const { status } = await t.json(`/reports/${created.id}`, {
      method: "DELETE",
      auth: true,
    });
    expect(status).toBe(200);

    const { status: getStatus } = await t.json(`/reports/${created.id}`, { auth: true });
    expect(getStatus).toBe(404);
  });

  test("requires auth", async () => {
    await setup;
    const { status } = await t.json("/reports");
    expect(status).toBe(401);
  });
});
