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

  routes.get("/_panel", (c) => {
    const entries = store.query({ last: "15" });
    const rows = entries
      .map((e: any) => {
        const time = new Date(e.timestamp).toLocaleTimeString();
        const mood = e.mood ? ` <span style="color:#f90">${e.mood}</span>` : "";
        const preview = e.content.length > 120 ? `${e.content.slice(0, 120)}…` : e.content;
        return `<div style="padding:4px 0;border-bottom:1px solid #222"><span style="color:#666">${time}</span>${mood} ${preview}</div>`;
      })
      .join("");
    return c.html(`<div style="font-family:monospace;font-size:13px;color:#ccc;padding:12px">
      <h3 style="margin:0 0 8px;color:#4f9">Journal</h3>
      ${rows || '<div style="color:#666">No entries yet</div>'}
    </div>`);
  });

  return routes;
}
