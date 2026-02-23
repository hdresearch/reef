/**
 * Bearer token auth middleware for Hono.
 *
 * If VERS_AUTH_TOKEN is set, requires Authorization: Bearer <token>.
 * If not set, all requests pass through (dev mode).
 */

import type { MiddlewareHandler } from "hono";

export function bearerAuth(): MiddlewareHandler {
  return async (c, next) => {
    const token = process.env.VERS_AUTH_TOKEN;

    if (!token) return next();

    const authHeader = c.req.header("Authorization");
    if (!authHeader) {
      return c.json({ error: "Unauthorized — missing Authorization header" }, 401);
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match || match[1] !== token) {
      return c.json({ error: "Unauthorized — invalid token" }, 401);
    }

    return next();
  };
}
