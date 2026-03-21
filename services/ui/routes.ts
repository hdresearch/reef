/**
 * UI routes — serves the dashboard, handles magic link auth, proxies API calls.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { consumeMagicLink, createMagicLink, createSession, getSessionInfo, validateSession } from "./auth.js";

const AUTH_TOKEN = process.env.VERS_AUTH_TOKEN || "test-token";

function getStaticDir(): string {
  return join(import.meta.dir, "static");
}

function getSessionId(c: any): string | undefined {
  const cookie = c.req.header("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  return match?.[1];
}

function hasBearerAuth(c: any): boolean {
  const auth = c.req.header("authorization") || "";
  return auth === `Bearer ${AUTH_TOKEN}`;
}

export function createRoutes(): Hono {
  const routes = new Hono();

  // --- Auth ---

  routes.post("/auth/magic-link", (c) => {
    if (!hasBearerAuth(c)) return c.json({ error: "Unauthorized" }, 401);

    const link = createMagicLink();
    const host = c.req.header("host") || "localhost:3000";
    const proto = c.req.header("x-forwarded-proto") || "https";
    const url = `${proto}://${host}/ui/login?token=${link.token}`;
    return c.json({ url, expiresAt: link.expiresAt });
  });

  // Login page / magic link consumer
  routes.get("/ui/login", (c) => {
    const token = c.req.query("token");

    if (token) {
      const valid = consumeMagicLink(token);
      if (valid) {
        const session = createSession();
        return c.html('<html><head><meta http-equiv="refresh" content="0;url=/ui/"></head></html>', 200, {
          "Set-Cookie": `session=${session.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        });
      }
      return c.html(
        `<html><body style="background:#0a0a0a;color:#f55;font-family:monospace;padding:2em">
          <h2>Invalid or expired link</h2>
          <p>Request a new magic link from the API.</p>
        </body></html>`,
        401,
      );
    }

    return c.html(`<html><body style="background:#0a0a0a;color:#888;font-family:monospace;padding:2em">
      <h2>reef</h2>
      <p>Access requires a magic link. Generate one via:</p>
      <pre style="color:#4f9">POST /auth/magic-link</pre>
    </body></html>`);
  });

  // Session info (for the UI to show expiry countdown)
  routes.get("/ui/session", (c) => {
    const sessionId = getSessionId(c);
    const info = getSessionInfo(sessionId);
    if (!info) return c.json({ authenticated: false }, 401);
    return c.json({ authenticated: true, ...info });
  });

  // --- Session-protected UI routes ---

  routes.use("/ui/*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path === "/ui/login" || path.startsWith("/ui/static/")) return next();
    if (!process.env.VERS_AUTH_TOKEN) return next();

    const sessionId = getSessionId(c);
    if (!validateSession(sessionId)) return c.redirect("/ui/login");
    return next();
  });

  // Dashboard
  routes.get("/ui/", (c) => {
    try {
      const html = readFileSync(join(getStaticDir(), "index.html"), "utf-8");
      return c.html(html);
    } catch {
      return c.text("Dashboard files not found", 500);
    }
  });

  // Static files
  routes.get("/ui/static/:file", (c) => {
    const file = c.req.param("file");
    if (file.includes("..") || file.includes("/")) return c.text("Not found", 404);

    try {
      const content = readFileSync(join(getStaticDir(), file), "utf-8");
      const ext = file.split(".").pop();
      const contentType = ext === "css" ? "text/css" : ext === "js" ? "application/javascript" : "text/plain";
      return c.body(content, 200, { "Content-Type": contentType });
    } catch {
      return c.text("Not found", 404);
    }
  });

  // --- API proxy (injects bearer token so browser never needs it) ---

  routes.all("/ui/api/*", async (c) => {
    const url = new URL(c.req.url);
    const apiPath = url.pathname.replace(/^\/ui\/api/, "");
    const queryString = url.search;

    const port = process.env.PORT || "3000";
    const internalUrl = `http://127.0.0.1:${port}${apiPath}${queryString}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    };
    const contentType = c.req.header("content-type");
    if (contentType) headers["Content-Type"] = contentType;

    const method = c.req.method;
    const body = method !== "GET" && method !== "HEAD" ? await c.req.text() : undefined;

    try {
      const resp = await fetch(internalUrl, { method, headers, body });

      // SSE passthrough
      if (resp.headers.get("content-type")?.includes("text/event-stream")) {
        return new Response(resp.body, {
          status: resp.status,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      const text = await resp.text();
      return c.body(text, resp.status as any, {
        "Content-Type": resp.headers.get("content-type") || "application/json",
      });
    } catch (e) {
      return c.json({ error: "Proxy error", details: String(e) }, 502);
    }
  });

  return routes;
}
