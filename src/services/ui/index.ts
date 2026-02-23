/**
 * UI service module — web dashboard with magic link auth and API proxy.
 */

import type { ServiceModule } from "../../core/types.js";
import { createRoutes } from "./routes.js";

const ui: ServiceModule = {
  name: "ui",
  description: "Web dashboard",
  routes: createRoutes(),
  mountAtRoot: true, // Serves at /ui/*, /auth/* — handles its own session auth
  requiresAuth: false,
};

export default ui;
