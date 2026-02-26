import type { ServiceModule } from "../src/core/types.js";
import { CommitStore } from "./store.js";
import { createRoutes } from "./routes.js";

const store = new CommitStore();

const commits: ServiceModule = {
  name: "commits",
  description: "VM snapshot ledger",
  routes: createRoutes(store),
  store: { close: () => { store.close(); return Promise.resolve(); } },
};

export default commits;
