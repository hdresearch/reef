import type { ServiceModule } from "../../core/types.js";
import { LogStore } from "./store.js";
import { createRoutes } from "./routes.js";
import { registerTools } from "./tools.js";

const store = new LogStore();

const log: ServiceModule = {
  name: "log",
  description: "Append-only work log",
  routes: createRoutes(store),
  registerTools,
};

export default log;
