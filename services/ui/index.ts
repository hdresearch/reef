/**
 * UI service module — web dashboard with magic link auth, QR code mobile access,
 * persistent sessions, and API proxy.
 *
 * Serves the reef activity feed + branch conversation UI at /ui/.
 * Proxies API calls through /ui/api/* to inject bearer auth.
 *
 * The "mobile" tab shows a QR code that, when scanned, grants a persistent
 * 30-day session. QR codes auto-refresh before the magic link expires (5 min).
 */

import type { ServiceModule } from "../../src/core/types.js";
import { initAuth } from "./auth.js";
import { createRoutes } from "./routes.js";

const ui: ServiceModule = {
  name: "ui",
  description: "Web dashboard — activity feed, branch conversations, service panels, mobile QR access",
  routes: createRoutes(),
  mountAtRoot: true,
  requiresAuth: false,

  async init() {
    // Load persisted sessions from disk
    await initAuth();
  },

  routeDocs: {
    "POST /auth/magic-link": {
      summary: "Generate a magic link for browser access",
      response: "{ url, expiresAt } — URL to open in browser, valid for 5 minutes",
    },
    "POST /auth/qr-link": {
      summary: "Generate a magic link for QR code display (session-authenticated)",
      detail:
        "Called by the dashboard's mobile tab to create fresh magic links for QR codes. Returns the URL and expiry. The resulting session is persistent (30 days).",
      response: "{ url, token, expiresAt }",
    },
    "GET /ui/login": {
      summary: "Login page / magic link consumer",
      query: {
        token: { type: "string", description: "Magic link token" },
        mobile: { type: "string", description: "Set to '1' for persistent mobile session" },
      },
      response: "Redirects to /ui/ on success, shows error on invalid/expired token",
    },
    "GET /ui/": {
      summary: "Dashboard — activity feed + branch conversations + mobile QR tab",
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
      detail:
        "Forwards requests to the internal API with Authorization header. Supports SSE passthrough.",
    },
  },
};

export default ui;
