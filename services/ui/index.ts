/**
 * UI service module — web dashboard with magic link auth and API proxy.
 *
 * Serves the reef activity feed + branch conversation UI at /ui/.
 * Proxies API calls through /ui/api/* to inject bearer auth.
 */

import type { ServiceModule } from "../../src/core/types.js";
import { createRoutes } from "./routes.js";

const ui: ServiceModule = {
  name: "ui",
  description: "Web dashboard — activity feed, branch conversations, service panels",
  routes: createRoutes(),
  mountAtRoot: true,
  requiresAuth: false,

  routeDocs: {
    "POST /auth/magic-link": {
      summary: "Generate a magic link for browser access",
      response: "{ url, expiresAt } — URL to open in browser, valid for 5 minutes",
    },
    "GET /ui/login": {
      summary: "Login page / magic link consumer",
      query: {
        token: { type: "string", description: "Magic link token" },
      },
      response: "Redirects to /ui/ on success, shows error on invalid/expired token",
    },
    "GET /ui/": {
      summary: "Dashboard — activity feed + branch conversations",
      response: "text/html",
    },
    "GET /ui/static/:file": {
      summary: "Static assets (JS, CSS)",
      params: {
        file: { type: "string", required: true, description: "Filename" },
      },
    },
    "ALL /ui/api/*": {
      summary: "API proxy — injects bearer auth so browser never needs the token",
      detail: "Forwards requests to the internal API with Authorization header. Supports SSE passthrough.",
    },
  },
};

export default ui;
