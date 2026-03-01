import type { ServiceModule } from "../src/core/types.js";
import { createRoutes } from "./routes.js";
import { ReportsStore } from "./store.js";

const store = new ReportsStore();

const reports: ServiceModule = {
  name: "reports",
  description: "Markdown reports",
  routes: createRoutes(store),
  store,
};

export default reports;
