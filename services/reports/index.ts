import type { ServiceModule } from "../src/core/types.js";
import { ReportsStore } from "./store.js";
import { createRoutes } from "./routes.js";

const store = new ReportsStore();

const reports: ServiceModule = {
  name: "reports",
  description: "Markdown reports",
  routes: createRoutes(store),
  store,
};

export default reports;
