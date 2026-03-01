/**
 * Board service module — shared task tracking for agent fleets.
 *
 * Emits server-side events:
 *   board:task_created  — { task }
 *   board:task_updated  — { task, changes }
 *   board:task_deleted  — { taskId }
 */

import type { ServiceEventBus } from "../src/core/events.js";
import type { FleetClient, ServiceContext, ServiceModule } from "../src/core/types.js";
import { createRoutes } from "./routes.js";
import { BoardStore } from "./store.js";
import { registerTools } from "./tools.js";

const store = new BoardStore();

// Late-bound reference — filled by init(), used by routes
let events: ServiceEventBus | null = null;
export function getEvents(): ServiceEventBus | null {
  return events;
}

const board: ServiceModule = {
  name: "board",
  description: "Shared task tracking",
  routes: createRoutes(store, () => events),
  store,
  registerTools,

  init(ctx: ServiceContext) {
    events = ctx.events;
  },

  routeDocs: {
    "POST /tasks": {
      summary: "Create a new task",
      body: {
        title: { type: "string", required: true, description: "Task title" },
        description: { type: "string", description: "Detailed description" },
        status: {
          type: "string",
          description: "Initial status: open | in_progress | in_review | blocked | done. Default: open",
        },
        assignee: { type: "string", description: "Agent or user to assign to" },
        tags: { type: "string[]", description: "Tags for categorization" },
        dependencies: { type: "string[]", description: "IDs of tasks this depends on" },
        createdBy: { type: "string", required: true, description: "Who created this task" },
      },
      response: "The created task with generated ID, timestamps, empty notes/artifacts, and score 0",
    },
    "GET /tasks": {
      summary: "List tasks with optional filters",
      query: {
        status: { type: "string", description: "Filter by status: open | in_progress | in_review | blocked | done" },
        assignee: { type: "string", description: "Filter by assignee" },
        tag: { type: "string", description: "Filter by tag" },
      },
      response: "{ tasks: Task[], count: number }",
    },
    "GET /tasks/:id": {
      summary: "Get a single task by ID",
      params: { id: { type: "string", required: true, description: "Task ID (ULID)" } },
      response: "The full task object including notes and artifacts",
    },
    "PATCH /tasks/:id": {
      summary: "Update a task",
      params: { id: { type: "string", required: true, description: "Task ID" } },
      body: {
        title: { type: "string", description: "New title" },
        description: { type: "string", description: "New description" },
        status: { type: "string", description: "New status" },
        assignee: { type: "string | null", description: "New assignee, or null to unassign" },
        tags: { type: "string[]", description: "Replace tags" },
      },
      response: "The updated task object",
    },
    "DELETE /tasks/:id": {
      summary: "Delete a task",
      params: { id: { type: "string", required: true, description: "Task ID" } },
      response: "{ ok: true }",
    },
    "POST /tasks/:id/bump": {
      summary: "Bump a task's priority score by 1",
      detail: "Use to signal importance or upvote. Score is displayed in the dashboard.",
      params: { id: { type: "string", required: true, description: "Task ID" } },
      response: "The updated task with incremented score",
    },
    "POST /tasks/:id/notes": {
      summary: "Add a note to a task",
      params: { id: { type: "string", required: true, description: "Task ID" } },
      body: {
        author: { type: "string", required: true, description: "Who wrote the note" },
        content: { type: "string", required: true, description: "Note content" },
        type: { type: "string", required: true, description: "finding | blocker | question | update" },
      },
      response: "The created note with generated ID and timestamp",
    },
    "GET /tasks/:id/notes": {
      summary: "Get all notes for a task",
      params: { id: { type: "string", required: true, description: "Task ID" } },
      response: "{ notes: Note[] }",
    },
    "POST /tasks/:id/artifacts": {
      summary: "Attach artifacts to a task",
      params: { id: { type: "string", required: true, description: "Task ID" } },
      body: {
        artifacts: {
          type: "Artifact[]",
          required: true,
          description: "Array of { type, url, label, addedBy? }. Type: branch | report | deploy | diff | file | url",
        },
      },
      response: "The updated task with new artifacts appended",
    },
    "POST /tasks/:id/review": {
      summary: "Submit a task for review",
      detail: "Sets status to in_review, adds a summary note, and optionally attaches artifacts.",
      params: { id: { type: "string", required: true, description: "Task ID" } },
      body: {
        summary: { type: "string", required: true, description: "Review summary describing what was done" },
        reviewedBy: { type: "string", required: true, description: "Who is submitting for review" },
        artifacts: { type: "Artifact[]", description: "Artifacts to attach" },
      },
      response: "The updated task in in_review status",
    },
    "POST /tasks/:id/approve": {
      summary: "Approve a task in review",
      params: { id: { type: "string", required: true, description: "Task ID" } },
      response: "The task moved to done status",
    },
    "POST /tasks/:id/reject": {
      summary: "Reject a task in review, sending it back to in_progress",
      params: { id: { type: "string", required: true, description: "Task ID" } },
      body: {
        reason: { type: "string", description: "Reason for rejection" },
      },
      response: "The task moved back to in_progress status",
    },
    "GET /review": {
      summary: "List all tasks currently in review",
      response: "{ tasks: Task[], count: number }",
    },
  },

  widget: {
    async getLines(client: FleetClient) {
      try {
        const res = await client.api<{ tasks: { status: string }[]; count: number }>("GET", "/board/tasks");
        const open = res.tasks.filter((t) => t.status === "open").length;
        const inProgress = res.tasks.filter((t) => t.status === "in_progress").length;
        const blocked = res.tasks.filter((t) => t.status === "blocked").length;
        return [`Board: ${open} open, ${inProgress} in-progress, ${blocked} blocked`];
      } catch {
        return [];
      }
    },
  },
};

export default board;
