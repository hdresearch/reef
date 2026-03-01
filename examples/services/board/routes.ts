/**
 * Board HTTP routes.
 *
 * Receives a store instance and a lazy event bus getter.
 * Emits board:task_created, board:task_updated, board:task_deleted.
 */

import { Hono } from "hono";
import type { ServiceEventBus } from "../src/core/events.js";
import type { AddArtifactInput, BoardStore, TaskFilters, TaskStatus } from "./store.js";
import { NotFoundError, ValidationError } from "./store.js";

export function createRoutes(store: BoardStore, getEvents: () => ServiceEventBus | null = () => null): Hono {
  const routes = new Hono();

  // Create a task
  routes.post("/tasks", async (c) => {
    try {
      const body = await c.req.json();
      const task = store.createTask(body);
      getEvents()?.fire("board:task_created", { task });
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
      getEvents()?.fire("board:task_updated", { task, changes: body });
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
    getEvents()?.fire("board:task_deleted", { taskId: c.req.param("id") });
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
      getEvents()?.fire("board:task_updated", { task, changes: { status: "in_review" } });
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

      const task = store.getTask(id);
      getEvents()?.fire("board:task_updated", { task, changes: { status: "done" } });
      return c.json(task);
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

      const task = store.getTask(id);
      getEvents()?.fire("board:task_updated", { task, changes: { status: "open" } });
      return c.json(task);
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

  // ─── UI Panel ───

  routes.get("/_panel", (c) => {
    return c.html(`
<style>
.panel-board { padding: 8px; }
.panel-board .status-group { margin-bottom: 12px; }
.panel-board .status-label {
  font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
  padding: 4px 8px; color: var(--text-dim, #666); display: flex; align-items: center; gap: 8px;
}
.panel-board .status-label .count {
  background: var(--bg-card, #1a1a1a); padding: 1px 6px; border-radius: 3px; font-size: 10px;
}
.panel-board .task-card {
  background: var(--bg-card, #1a1a1a); border: 1px solid var(--border, #2a2a2a);
  border-radius: 4px; padding: 10px 12px; margin: 4px 0; cursor: pointer;
  transition: border-color 0.15s;
}
.panel-board .task-card:hover { border-color: #444; }
.panel-board .task-card .title { color: var(--text-bright, #eee); font-weight: 500; margin-bottom: 4px; }
.panel-board .task-card .meta {
  font-size: 11px; color: var(--text-dim, #666); display: flex; gap: 12px; flex-wrap: wrap;
}
.panel-board .task-card .tag {
  background: #222; padding: 1px 6px; border-radius: 3px; font-size: 10px; color: var(--blue, #5af);
}
.panel-board .task-card .assignee { color: var(--purple, #a7f); }
.panel-board .task-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.panel-board .bump-btn {
  background: none; border: 1px solid var(--border, #2a2a2a); border-radius: 3px;
  color: var(--text-dim, #666); cursor: pointer; font-size: 11px; padding: 2px 6px;
  font-family: inherit; transition: all 0.15s;
}
.panel-board .bump-btn:hover { border-color: var(--accent, #4f9); color: var(--accent, #4f9); }
.panel-board .score { font-weight: 700; color: var(--yellow, #fd0); }
.panel-board .score.dim { color: var(--text-dim, #666); font-weight: 400; }
.panel-board .notes { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border, #2a2a2a); font-size: 11px; display: none; }
.panel-board .task-card.expanded .notes { display: block; }
.panel-board .note { padding: 2px 0; color: var(--text-dim, #666); }
.panel-board .note-author { color: var(--purple, #a7f); }
.panel-board .note-type { color: var(--orange, #f93); font-size: 10px; }
.panel-board .status-open { border-left: 3px solid var(--blue, #5af); }
.panel-board .status-in_progress { border-left: 3px solid var(--yellow, #fd0); }
.panel-board .status-in_review { border-left: 3px solid var(--orange, #f93); }
.panel-board .status-blocked { border-left: 3px solid var(--red, #f55); }
.panel-board .status-done { border-left: 3px solid var(--accent, #4f9); opacity: 0.6; }
.panel-board .empty { color: var(--text-dim, #666); font-style: italic; padding: 20px; text-align: center; }
</style>

<div class="panel-board" id="board-root">
  <div class="empty">Loading board…</div>
</div>

<script>
(function() {
  const root = document.getElementById('board-root');
  const API = typeof PANEL_API !== 'undefined' ? PANEL_API : '/ui/api';
  const ORDER = ['open', 'in_progress', 'in_review', 'blocked', 'done'];

  function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
  function ago(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return Math.floor(ms/1000) + 's ago';
    if (ms < 3600000) return Math.floor(ms/60000) + 'm ago';
    if (ms < 86400000) return Math.floor(ms/3600000) + 'h ago';
    return Math.floor(ms/86400000) + 'd ago';
  }

  async function load() {
    try {
      const res = await fetch(API + '/board/tasks');
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      render(data.tasks || []);
    } catch (e) {
      root.innerHTML = '<div class="empty">Board unavailable: ' + esc(e.message) + '</div>';
    }
  }

  function render(tasks) {
    const grouped = {};
    ORDER.forEach(s => grouped[s] = []);
    tasks.forEach(t => (grouped[t.status] || grouped.open).push(t));

    let html = '';
    for (const status of ORDER) {
      const items = grouped[status];
      if (!items.length) continue;
      html += '<div class="status-group"><div class="status-label">'
        + status.replace(/_/g, ' ') + ' <span class="count">' + items.length + '</span></div>';
      for (const t of items) {
        const tags = (t.tags||[]).map(tag => '<span class="tag">' + esc(tag) + '</span>').join('');
        const assignee = t.assignee ? '<span class="assignee">@' + esc(t.assignee) + '</span>' : '';
        const notes = (t.notes||[]).map(n =>
          '<div class="note"><span class="note-author">@' + esc(n.author) + '</span> <span class="note-type">' + esc(n.type) + '</span> ' + esc(n.content) + '</div>'
        ).join('');
        const score = t.score || 0;
        html += '<div class="task-card status-' + status + '" onclick="this.classList.toggle(\\'expanded\\')">'
          + '<div class="task-top"><div class="title">' + esc(t.title) + '</div>'
          + '<button class="bump-btn" onclick="event.stopPropagation();fetch(\\'' + API + '/board/tasks/' + t.id + '/bump\\',{method:\\'POST\\'}).then(()=>window._boardLoad())"><span class="score' + (score ? '' : ' dim') + '">' + score + '</span></button></div>'
          + '<div class="meta">' + assignee + tags + '<span>' + ago(t.createdAt) + '</span></div>'
          + (notes ? '<div class="notes">' + notes + '</div>' : '')
          + '</div>';
      }
      html += '</div>';
    }
    root.innerHTML = html || '<div class="empty">No tasks</div>';
  }

  window._boardLoad = load;
  load();
  setInterval(load, 10000);
})();
</script>
`);
  });

  return routes;
}
