/**
 * Board service module — shared task tracking for agent fleets.
 */

import type { ServiceModule, FleetClient } from "../../core/types.js";
import { BoardStore } from "./store.js";
import { createRoutes } from "./routes.js";
import { registerTools } from "./tools.js";

const store = new BoardStore();

const board: ServiceModule = {
  name: "board",
  description: "Shared task tracking",
  routes: createRoutes(store),
  store,
  registerTools,

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
