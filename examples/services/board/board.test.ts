import { afterAll, describe, expect, test } from "bun:test";
import { createTestHarness, type TestHarness } from "../../../src/core/testing.js";
import board from "./index.js";

let t: TestHarness;

// Use a single harness for all tests — board is stateful in-memory
const setup = (async () => {
  t = await createTestHarness({ services: [board] });
})();

afterAll(() => t?.cleanup());

describe("board", () => {
  test("creates a task", async () => {
    await setup;
    const { status, data } = await t.json("/board/tasks", {
      method: "POST",
      auth: true,
      body: { title: "Test task", createdBy: "test-agent" },
    });
    expect(status).toBe(201);
    expect(data.title).toBe("Test task");
    expect(data.id).toBeDefined();
    expect(data.status).toBe("open");
  });

  test("lists tasks", async () => {
    await setup;
    const { status, data } = await t.json<{ tasks: any[]; count: number }>("/board/tasks", {
      auth: true,
    });
    expect(status).toBe(200);
    expect(data.tasks.length).toBeGreaterThanOrEqual(1);
    expect(data.count).toBe(data.tasks.length);
  });

  test("filters by status", async () => {
    await setup;
    const { data } = await t.json<{ tasks: any[] }>("/board/tasks?status=open", {
      auth: true,
    });
    for (const task of data.tasks) {
      expect(task.status).toBe("open");
    }
  });

  test("gets a task by id", async () => {
    await setup;
    // Create one first
    const { data: created } = await t.json<any>("/board/tasks", {
      method: "POST",
      auth: true,
      body: { title: "Get by ID test", createdBy: "test" },
    });

    const { status, data } = await t.json(`/board/tasks/${created.id}`, {
      auth: true,
    });
    expect(status).toBe(200);
    expect(data.title).toBe("Get by ID test");
  });

  test("updates a task", async () => {
    await setup;
    const { data: created } = await t.json<any>("/board/tasks", {
      method: "POST",
      auth: true,
      body: { title: "Update me", createdBy: "test" },
    });

    const { status, data } = await t.json(`/board/tasks/${created.id}`, {
      method: "PATCH",
      auth: true,
      body: { status: "in_progress", assignee: "worker-1" },
    });
    expect(status).toBe(200);
    expect(data.status).toBe("in_progress");
    expect(data.assignee).toBe("worker-1");
  });

  test("adds a note", async () => {
    await setup;
    const { data: created } = await t.json<any>("/board/tasks", {
      method: "POST",
      auth: true,
      body: { title: "Note test", createdBy: "test" },
    });

    const { status, data } = await t.json(`/board/tasks/${created.id}/notes`, {
      method: "POST",
      auth: true,
      body: { author: "test", content: "Found something", type: "finding" },
    });
    expect(status).toBe(201);
    expect(data.content).toBe("Found something");
    expect(data.type).toBe("finding");
  });

  test("bumps a task score", async () => {
    await setup;
    const { data: created } = await t.json<any>("/board/tasks", {
      method: "POST",
      auth: true,
      body: { title: "Bump test", createdBy: "test" },
    });
    expect(created.score).toBe(0);

    const { data: bumped } = await t.json(`/board/tasks/${created.id}/bump`, {
      method: "POST",
      auth: true,
    });
    expect(bumped.score).toBe(1);
  });

  test("submits for review", async () => {
    await setup;
    const { data: created } = await t.json<any>("/board/tasks", {
      method: "POST",
      auth: true,
      body: { title: "Review test", createdBy: "test" },
    });

    const { status, data } = await t.json(`/board/tasks/${created.id}/review`, {
      method: "POST",
      auth: true,
      body: { summary: "Done with this", reviewedBy: "test" },
    });
    expect(status).toBe(200);
    expect(data.status).toBe("in_review");
  });

  test("approves a task", async () => {
    await setup;
    const { data: created } = await t.json<any>("/board/tasks", {
      method: "POST",
      auth: true,
      body: { title: "Approve test", createdBy: "test" },
    });
    await t.json(`/board/tasks/${created.id}/review`, {
      method: "POST",
      auth: true,
      body: { summary: "Ready", reviewedBy: "test" },
    });

    const { data } = await t.json(`/board/tasks/${created.id}/approve`, {
      method: "POST",
      auth: true,
      body: { approvedBy: "reviewer" },
    });
    expect(data.status).toBe("done");
  });

  test("rejects a task back to in_progress", async () => {
    await setup;
    const { data: created } = await t.json<any>("/board/tasks", {
      method: "POST",
      auth: true,
      body: { title: "Reject test", createdBy: "test" },
    });
    await t.json(`/board/tasks/${created.id}/review`, {
      method: "POST",
      auth: true,
      body: { summary: "Check this", reviewedBy: "test" },
    });

    const { data } = await t.json(`/board/tasks/${created.id}/reject`, {
      method: "POST",
      auth: true,
      body: { reason: "Needs more work", rejectedBy: "reviewer" },
    });
    expect(data.status).toBe("open");
  });

  test("deletes a task", async () => {
    await setup;
    const { data: created } = await t.json<any>("/board/tasks", {
      method: "POST",
      auth: true,
      body: { title: "Delete me", createdBy: "test" },
    });

    const { status } = await t.json(`/board/tasks/${created.id}`, {
      method: "DELETE",
      auth: true,
    });
    expect(status).toBe(200);

    const { status: getStatus } = await t.json(`/board/tasks/${created.id}`, {
      auth: true,
    });
    expect(getStatus).toBe(404);
  });

  test("returns 404 for missing task", async () => {
    await setup;
    const { status } = await t.json("/board/tasks/nonexistent", { auth: true });
    expect(status).toBe(404);
  });

  test("requires auth", async () => {
    await setup;
    const { status } = await t.json("/board/tasks");
    expect(status).toBe(401);
  });

  test("panel endpoint returns HTML", async () => {
    await setup;
    const res = await t.fetch("/board/_panel", { auth: true });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("panel-board");
    expect(html).toContain("<script>");
  });
});
