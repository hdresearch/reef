/**
 * Board HTTP routes.
 *
 * Receives a store instance — doesn't create its own.
 */

import { Hono } from "hono";
import type {
  BoardStore,
  TaskFilters,
  TaskStatus,
  AddArtifactInput,
} from "./store.js";
import { NotFoundError, ValidationError } from "./store.js";

export function createRoutes(store: BoardStore): Hono {
  const routes = new Hono();

  // Create a task
  routes.post("/tasks", async (c) => {
    try {
      const body = await c.req.json();
      const task = store.createTask(body);
      return c.json(task, 201);
    } catch (e) {
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  // List tasks
  routes.get("/tasks", (c) => {
    const filters: TaskFilters = {};
    const status = c.req.query("status");
    const assignee = c.req.query("assignee");
    const tag = c.req.query("tag");

    if (status) filters.status = status as TaskStatus;
    if (assignee) filters.assignee = assignee;
    if (tag) filters.tag = tag;

    const tasks = store.listTasks(filters);
    return c.json({ tasks, count: tasks.length });
  });

  // Get a single task
  routes.get("/tasks/:id", (c) => {
    const task = store.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json(task);
  });

  // Update a task
  routes.patch("/tasks/:id", async (c) => {
    try {
      const body = await c.req.json();
      const task = store.updateTask(c.req.param("id"), body);
      return c.json(task);
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  // Delete a task
  routes.delete("/tasks/:id", (c) => {
    const deleted = store.deleteTask(c.req.param("id"));
    if (!deleted) return c.json({ error: "task not found" }, 404);
    return c.json({ deleted: true });
  });

  // Bump a task's score
  routes.post("/tasks/:id/bump", (c) => {
    try {
      const task = store.bumpTask(c.req.param("id"));
      return c.json(task);
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  // Add a note to a task
  routes.post("/tasks/:id/notes", async (c) => {
    try {
      const body = await c.req.json();
      const note = store.addNote(c.req.param("id"), body);
      return c.json(note, 201);
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  // Get notes for a task
  routes.get("/tasks/:id/notes", (c) => {
    try {
      const notes = store.getNotes(c.req.param("id"));
      return c.json({ notes, count: notes.length });
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  // Add artifacts to a task
  routes.post("/tasks/:id/artifacts", async (c) => {
    try {
      const body = await c.req.json();
      store.addArtifacts(c.req.param("id"), body.artifacts);
      const task = store.getTask(c.req.param("id"));
      return c.json(task, 201);
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  // Submit a task for review
  routes.post("/tasks/:id/review", async (c) => {
    try {
      const body = await c.req.json();
      const id = c.req.param("id");

      if (!body.summary?.trim()) {
        return c.json({ error: "summary is required" }, 400);
      }

      store.updateTask(id, { status: "in_review" });

      const author = body.reviewedBy?.trim() || "unknown";
      store.addNote(id, { author, content: body.summary.trim(), type: "update" });

      if (body.artifacts?.length) {
        const artifacts = body.artifacts.map((a: AddArtifactInput) => ({
          ...a,
          addedBy: a.addedBy || author,
        }));
        store.addArtifacts(id, artifacts);
      }

      const task = store.getTask(id);
      return c.json(task);
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  // Approve a reviewed task
  routes.post("/tasks/:id/approve", async (c) => {
    try {
      const body = await c.req.json();
      const id = c.req.param("id");
      const approvedBy = body.approvedBy?.trim() || "unknown";
      const comment = body.comment?.trim() || "";

      store.updateTask(id, { status: "done" });
      store.addNote(id, {
        author: approvedBy,
        content: comment ? `Approved by ${approvedBy}: ${comment}` : `Approved by ${approvedBy}`,
        type: "update",
      });

      return c.json(store.getTask(id));
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  // Reject a reviewed task
  routes.post("/tasks/:id/reject", async (c) => {
    try {
      const body = await c.req.json();
      const id = c.req.param("id");

      if (!body.reason?.trim()) return c.json({ error: "reason is required" }, 400);

      const rejectedBy = body.rejectedBy?.trim() || "unknown";
      store.updateTask(id, { status: "open" });
      store.addNote(id, {
        author: rejectedBy,
        content: `Rejected by ${rejectedBy}: ${body.reason.trim()}`,
        type: "update",
      });

      return c.json(store.getTask(id));
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  // List tasks in review
  routes.get("/review", (c) => {
    const tasks = store.listTasks({ status: "in_review" });
    tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return c.json({ tasks, count: tasks.length });
  });

  return routes;
}
