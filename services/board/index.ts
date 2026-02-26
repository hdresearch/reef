/**
 * Board service module — shared task tracking for agent fleets.
 *
 * Emits server-side events:
 *   board:task_created  — { task }
 *   board:task_updated  — { task, changes }
 *   board:task_deleted  — { taskId }
 */

import type { ServiceModule, ServiceContext, FleetClient } from "../src/core/types.js";
import type { ServiceEventBus } from "../src/core/events.js";
import { BoardStore } from "./store.js";
import { createRoutes } from "./routes.js";
import { registerTools } from "./tools.js";

const store = new BoardStore();

// Late-bound reference — filled by init(), used by routes
let events: ServiceEventBus | null = null;
export function getEvents(): ServiceEventBus | null { return events; }

const board: ServiceModule = {
  name: "board",
  description: "Shared task tracking",
  routes: createRoutes(store, () => events),
  store,
  registerTools,

  init(ctx: ServiceContext) {
    events = ctx.events;
  },

  widget: {
    async getLines(client: FleetClient) {
      try {
        const res = await client.api<{ tasks: { status: string }[]; count: number }>(
          "GET",
          "/board/tasks",
        );
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
