/**
 * Feed HTTP routes — event publishing, listing, SSE streaming.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { FeedStore, PublishInput, FeedEvent } from "./store.js";
import { VALID_EVENT_TYPES } from "./store.js";

export function createRoutes(store: FeedStore): Hono {
  const routes = new Hono();

  // Publish an event
  routes.post("/events", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const input = body as Record<string, unknown>;
    if (!input.agent || typeof input.agent !== "string") {
      return c.json({ error: "Missing or invalid 'agent' field" }, 400);
    }
    if (!input.type || !VALID_EVENT_TYPES.has(input.type as string)) {
      return c.json(
        { error: `Invalid 'type'. Must be one of: ${[...VALID_EVENT_TYPES].join(", ")}` },
        400,
      );
    }
    if (!input.summary || typeof input.summary !== "string") {
      return c.json({ error: "Missing or invalid 'summary' field" }, 400);
    }

    const event = store.publish({
      agent: input.agent as string,
      type: input.type as PublishInput["type"],
      summary: input.summary as string,
      detail: input.detail as string | undefined,
      metadata: input.metadata as Record<string, unknown> | undefined,
    });
    return c.json(event, 201);
  });

  // List events
  routes.get("/events", (c) => {
    const agent = c.req.query("agent");
    const type = c.req.query("type");
    const since = c.req.query("since");
    const limitStr = c.req.query("limit");
    const limit = limitStr ? parseInt(limitStr, 10) : 50;

    const events = store.list({ agent: agent || undefined, type: type || undefined, since: since || undefined, limit });
    return c.json(events);
  });

  // Get a single event
  routes.get("/events/:id", (c) => {
    const event = store.get(c.req.param("id"));
    if (!event) return c.json({ error: "Event not found" }, 404);
    return c.json(event);
  });

  // Clear all events
  routes.delete("/events", (c) => {
    store.clear();
    return c.json({ ok: true });
  });

  // Stats
  routes.get("/stats", (c) => c.json(store.stats()));

  // SSE stream
  routes.get("/stream", (c) => {
    const agent = c.req.query("agent") || undefined;
    const sinceId = c.req.query("since");

    return streamSSE(c, async (stream) => {
      // Replay missed events on reconnect
      if (sinceId) {
        const missed = store.eventsSince(sinceId, agent);
        for (const event of missed) {
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
      }

      const unsubscribe = store.subscribe((event: FeedEvent) => {
        if (agent && event.agent !== agent) return;
        stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {});
      });

      const heartbeat = setInterval(() => {
        stream.write(": heartbeat\n\n").catch(() => {});
      }, 15000);

      stream.onAbort(() => {
        unsubscribe();
        clearInterval(heartbeat);
      });

      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });

      unsubscribe();
      clearInterval(heartbeat);
    });
  });

  return routes;
}
