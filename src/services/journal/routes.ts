import { Hono } from "hono";
import type { JournalStore } from "./store.js";
import { ValidationError } from "./store.js";

export function createRoutes(store: JournalStore): Hono {
  const routes = new Hono();

  routes.post("/", async (c) => {
    try {
      const body = await c.req.json();
      const entry = store.append(body);
      return c.json(entry, 201);
    } catch (e) {
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  routes.get("/", (c) => {
    const entries = store.query({
      since: c.req.query("since") || undefined,
      until: c.req.query("until") || undefined,
      last: c.req.query("last") || undefined,
      author: c.req.query("author") || undefined,
      tag: c.req.query("tag") || undefined,
    });
    if (c.req.query("raw") === "true") {
      return c.text(store.formatRaw(entries));
    }
    return c.json({ entries, count: entries.length });
  });

  routes.get("/raw", (c) => {
    const entries = store.query({
      since: c.req.query("since") || undefined,
      until: c.req.query("until") || undefined,
      last: c.req.query("last") || undefined,
      author: c.req.query("author") || undefined,
      tag: c.req.query("tag") || undefined,
    });
    return c.text(store.formatRaw(entries));
  });

  return routes;
}
