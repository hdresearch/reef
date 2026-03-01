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

  routes.get("/_panel", (c) => {
    const entries = store.query({ last: "20" });
    const rows = entries
      .map((e: any) => {
        const time = new Date(e.timestamp).toLocaleTimeString();
        const tags = e.tags?.length ? ` <span style="color:#888">[${e.tags.join(", ")}]</span>` : "";
        return `<div style="padding:4px 0;border-bottom:1px solid #222"><span style="color:#666">${time}</span> ${e.content}${tags}</div>`;
      })
      .join("");
    return c.html(`<div style="font-family:monospace;font-size:13px;color:#ccc;padding:12px">
      <h3 style="margin:0 0 8px;color:#4f9">Work Log</h3>
      ${rows || '<div style="color:#666">No entries yet</div>'}
    </div>`);
  });

  return routes;
}
