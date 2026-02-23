import { Hono } from "hono";
import type { LogStore } from "./store.js";
import { ValidationError } from "./store.js";

export function createRoutes(store: LogStore): Hono {
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
    const since = c.req.query("since");
    const until = c.req.query("until");
    const last = c.req.query("last");
    const entries = store.query({
      since: since || undefined,
      until: until || undefined,
      last: last || undefined,
    });
    return c.json({ entries, count: entries.length });
  });

  routes.get("/raw", (c) => {
    const since = c.req.query("since");
    const until = c.req.query("until");
    const last = c.req.query("last");
    const entries = store.query({
      since: since || undefined,
      until: until || undefined,
      last: last || undefined,
    });
    return c.text(store.formatRaw(entries));
  });

  return routes;
}
