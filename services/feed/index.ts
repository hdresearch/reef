/**
 * Feed service module — activity event stream for coordination and observability.
 *
 * Listens to server-side events from other modules and auto-publishes
 * them as feed events:
 *   board:task_created  → feed event "task_started"
 *   board:task_updated  → feed event "task_completed" (if status=done)
 *   board:task_deleted  → (ignored)
 */

import type { ServiceModule, ServiceContext, FleetClient } from "../src/core/types.js";
import { FeedStore } from "./store.js";
import { createRoutes } from "./routes.js";
import { registerTools } from "./tools.js";
import { registerBehaviors } from "./behaviors.js";

const store = new FeedStore();

const feed: ServiceModule = {
  name: "feed",
  description: "Activity event stream",
  routes: createRoutes(store),
  registerTools,
  registerBehaviors,

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
