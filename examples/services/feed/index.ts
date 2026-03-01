/**
 * Feed service module — activity event stream for coordination and observability.
 *
 * Listens to server-side events from other modules and auto-publishes
 * them as feed events:
 *   board:task_created  → feed event "task_started"
 *   board:task_updated  → feed event "task_completed" (if status=done)
 *   board:task_deleted  → (ignored)
 */

import type { FleetClient, ServiceContext, ServiceModule } from "../src/core/types.js";
import { registerBehaviors } from "./behaviors.js";
import { createRoutes } from "./routes.js";
import { FeedStore } from "./store.js";
import { registerTools } from "./tools.js";

const store = new FeedStore();

const feed: ServiceModule = {
  name: "feed",
  description: "Activity event stream",
  routes: createRoutes(store),
  registerTools,
  registerBehaviors,

  routeDocs: {
    "POST /events": {
      summary: "Publish an event to the feed",
      body: {
        agent: { type: "string", required: true, description: "Agent name that produced the event" },
        type: {
          type: "string",
          required: true,
          description:
            "task_started | task_completed | task_failed | blocker_found | question | finding | skill_proposed | file_changed | cost_update | agent_started | agent_stopped | token_update | custom",
        },
        summary: { type: "string", required: true, description: "Short human-readable summary" },
        detail: { type: "string", description: "Longer detail or structured JSON string" },
        metadata: { type: "object", description: "Arbitrary key-value metadata" },
      },
      response: "The created event with generated ID and timestamp",
    },
    "GET /events": {
      summary: "List recent events with optional filters",
      query: {
        agent: { type: "string", description: "Filter by agent name" },
        type: { type: "string", description: "Filter by event type" },
        since: { type: "string", description: "ULID or ISO timestamp — return events after this point" },
        limit: { type: "number", description: "Max events to return. Default: 50" },
      },
      response: "Array of feed events, most recent last",
    },
    "GET /events/:id": {
      summary: "Get a single event by ID",
      params: { id: { type: "string", required: true, description: "Event ID (ULID)" } },
    },
    "DELETE /events": {
      summary: "Clear all events",
      detail: "Destructive — removes all events from memory and disk. Use with caution.",
      response: "{ ok: true }",
    },
    "GET /stats": {
      summary: "Get feed statistics",
      response: "{ total, byAgent: { [name]: count }, byType: { [type]: count }, latestPerAgent: { [name]: Event } }",
    },
    "GET /stream": {
      summary: "Server-Sent Events stream of new events in real time",
      detail:
        "Connect with EventSource. Pass ?since=<ulid> to replay missed events on reconnect. Pass ?agent=<name> to filter by agent. Sends heartbeat comments every 15s.",
      query: {
        agent: { type: "string", description: "Filter to events from this agent only" },
        since: { type: "string", description: "ULID — replay events since this ID before streaming" },
      },
      response: "SSE stream. Each message data is a JSON-encoded FeedEvent.",
    },
  },

  init(ctx: ServiceContext) {
    ctx.events.on("board:task_created", (data: any) => {
      const task = data.task;
      store.publish({
        agent: task.createdBy || "unknown",
        type: "task_started",
        summary: `Task created: ${task.title}`,
        metadata: { taskId: task.id, status: task.status },
      });
    });

    ctx.events.on("board:task_updated", (data: any) => {
      const task = data.task;
      const changes = data.changes || {};

      if (changes.status === "done") {
        store.publish({
          agent: task.assignee || task.createdBy || "unknown",
          type: "task_completed",
          summary: `Task completed: ${task.title}`,
          metadata: { taskId: task.id },
        });
      } else if (changes.status === "blocked") {
        store.publish({
          agent: task.assignee || task.createdBy || "unknown",
          type: "blocker_found",
          summary: `Task blocked: ${task.title}`,
          metadata: { taskId: task.id },
        });
      }
    });
  },

  widget: {
    async getLines(client: FleetClient) {
      try {
        const stats = await client.api<{ total: number }>("GET", "/feed/stats");
        return [`Feed: ${stats.total} events`];
      } catch {
        return [];
      }
    },
  },
};

export default feed;
