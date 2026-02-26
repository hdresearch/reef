/**
 * Board tools — registered on the pi extension so the LLM can manage tasks.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { FleetClient } from "../src/core/types.js";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

const STATUS_ENUM = StringEnum(
  ["open", "in_progress", "in_review", "blocked", "done"] as const,
  { description: "Task status" },
);

const ARTIFACT_TYPE_ENUM = StringEnum(
  ["branch", "report", "deploy", "diff", "file", "url"] as const,
  { description: "Artifact type" },
);

export function registerTools(pi: ExtensionAPI, client: FleetClient) {
  pi.registerTool({
    name: "board_create_task",
    label: "Board: Create Task",
    description:
      "Create a new task on the shared coordination board. Returns the created task with its ID.",
    parameters: Type.Object({
      title: Type.String({ description: "Task title" }),
      description: Type.Optional(Type.String({ description: "Detailed task description" })),
      assignee: Type.Optional(Type.String({ description: "Agent or user to assign to" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const task = await client.api("POST", "/board/tasks", {
          ...params,
          createdBy: client.agentName,
        });
        return client.ok(JSON.stringify(task, null, 2), { task });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "board_list_tasks",
    label: "Board: List Tasks",
    description:
      "List tasks on the shared board. Optionally filter by status, assignee, or tag.",
    parameters: Type.Object({
      status: Type.Optional(STATUS_ENUM),
      assignee: Type.Optional(Type.String({ description: "Filter by assignee" })),
      tag: Type.Optional(Type.String({ description: "Filter by tag" })),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const qs = new URLSearchParams();
        if (params.status) qs.set("status", params.status);
        if (params.assignee) qs.set("assignee", params.assignee);
        if (params.tag) qs.set("tag", params.tag);
        const query = qs.toString();
        const result = await client.api("GET", `/board/tasks${query ? `?${query}` : ""}`);
        return client.ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "board_update_task",
    label: "Board: Update Task",
    description:
      "Update a task — change status, reassign, rename, or update tags.",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to update" }),
      status: Type.Optional(STATUS_ENUM),
      assignee: Type.Optional(Type.String({ description: "New assignee" })),
      title: Type.Optional(Type.String({ description: "New title" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "New tags" })),
    }),
    async execute(_toolCallId, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const { id, ...updates } = params;
        const task = await client.api("PATCH", `/board/tasks/${encodeURIComponent(id)}`, updates);
        return client.ok(JSON.stringify(task, null, 2), { task });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "board_add_note",
    label: "Board: Add Note",
    description:
      "Add a note to a task — findings, blockers, questions, or status updates.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to add the note to" }),
      content: Type.String({ description: "Note content" }),
      type: StringEnum(["finding", "blocker", "question", "update"] as const, {
        description: "Note type",
      }),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const { taskId, ...body } = params;
        const note = await client.api(
          "POST",
          `/board/tasks/${encodeURIComponent(taskId)}/notes`,
          { ...body, author: client.agentName },
        );
        return client.ok(JSON.stringify(note, null, 2), { note });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "board_submit_for_review",
    label: "Board: Submit for Review",
    description:
      "Submit a task for review — sets status to in_review, adds a summary note, and optionally attaches artifacts.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to submit for review" }),
      summary: Type.String({ description: "Review summary describing what was done" }),
      artifacts: Type.Optional(
        Type.Array(
          Type.Object({
            type: ARTIFACT_TYPE_ENUM,
            url: Type.String({ description: "URL or path to the artifact" }),
            label: Type.String({ description: "Human-readable label" }),
          }),
          { description: "Artifacts to attach" },
        ),
      ),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const body: Record<string, unknown> = {
          summary: params.summary,
          reviewedBy: client.agentName,
        };
        if (params.artifacts) body.artifacts = params.artifacts;
        const task = await client.api(
          "POST",
          `/board/tasks/${encodeURIComponent(params.taskId)}/review`,
          body,
        );
        return client.ok(JSON.stringify(task, null, 2), { task });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "board_add_artifact",
    label: "Board: Add Artifact",
    description:
      "Add artifact link(s) to any task — branches, reports, deploys, diffs, files, or URLs.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID" }),
      artifacts: Type.Array(
        Type.Object({
          type: ARTIFACT_TYPE_ENUM,
          url: Type.String({ description: "URL or path" }),
          label: Type.String({ description: "Human-readable label" }),
        }),
        { description: "Artifacts to attach" },
      ),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const task = await client.api(
          "POST",
          `/board/tasks/${encodeURIComponent(params.taskId)}/artifacts`,
          { artifacts: params.artifacts.map((a) => ({ ...a, addedBy: client.agentName })) },
        );
        return client.ok(JSON.stringify(task, null, 2), { task });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "board_bump",
    label: "Board: Bump Task",
    description: "Bump a task's score by 1. Use to signal priority or upvote.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to bump" }),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const task = await client.api(
          "POST",
          `/board/tasks/${encodeURIComponent(params.taskId)}/bump`,
        );
        return client.ok(JSON.stringify(task, null, 2), { task });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });
}
