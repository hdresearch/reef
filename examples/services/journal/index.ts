import type { ServiceModule } from "../src/core/types.js";
import { createRoutes } from "./routes.js";
import { JournalStore } from "./store.js";
import { registerTools } from "./tools.js";

const store = new JournalStore();

const journal: ServiceModule = {
  name: "journal",
  description: "Personal narrative log",
  routes: createRoutes(store),
  registerTools,
};

export default journal;
