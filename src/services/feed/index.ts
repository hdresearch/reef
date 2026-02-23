/**
 * Feed service module — activity event stream for coordination and observability.
 */

import type { ServiceModule, FleetClient } from "../../core/types.js";
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
