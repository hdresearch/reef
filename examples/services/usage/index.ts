import type { ServiceModule } from "../src/core/types.js";
import { UsageStore } from "./store.js";
import { createRoutes } from "./routes.js";
import { registerTools } from "./tools.js";
import { registerBehaviors } from "./behaviors.js";

const store = new UsageStore();

const usage: ServiceModule = {
  name: "usage",
  description: "Cost & token tracking",
  routes: createRoutes(store),
  store: { close: () => { store.close(); return Promise.resolve(); } },
  registerTools,
  registerBehaviors,
  dependencies: ["feed"], // publishes agent_stopped to feed
};

export default usage;
