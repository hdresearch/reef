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

  // ─── UI Panel ───

  routes.get("/_panel", (c) => {
    return c.html(`
<style>
.panel-feed { height: 100%; overflow-y: auto; }
.panel-feed .event {
  padding: 8px 16px; border-bottom: 1px solid var(--border, #2a2a2a);
  font-size: 12px; animation: feedFadeIn 0.2s;
}
@keyframes feedFadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; } }
.panel-feed .ev-header { display: flex; gap: 8px; align-items: center; margin-bottom: 2px; }
.panel-feed .ev-agent { color: var(--purple, #a7f); font-weight: 500; }
.panel-feed .ev-type {
  font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 600;
  background: #333; color: var(--text, #ccc);
}
.panel-feed .ev-time { color: var(--text-dim, #666); font-size: 10px; margin-left: auto; }
.panel-feed .ev-summary { color: var(--text, #ccc); }
.panel-feed .empty { color: var(--text-dim, #666); font-style: italic; padding: 20px; text-align: center; }
.panel-feed .live-dot {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent, #4f9); margin-right: 6px; animation: feedPulse 2s infinite;
}
@keyframes feedPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
.panel-feed .feed-header {
  padding: 8px 16px; border-bottom: 1px solid var(--border, #2a2a2a);
  font-size: 11px; color: var(--text-dim, #666); background: var(--bg-panel, #111);
  position: sticky; top: 0; z-index: 1;
}
</style>

<div class="panel-feed" id="feed-root">
  <div class="feed-header"><span class="live-dot"></span>Live feed</div>
  <div id="feed-events"><div class="empty">Loading…</div></div>
</div>

<script>
(function() {
  const container = document.getElementById('feed-events');
  const API = typeof PANEL_API !== 'undefined' ? PANEL_API : '/ui/api';

  function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
  function ago(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return Math.floor(ms/1000) + 's ago';
    if (ms < 3600000) return Math.floor(ms/60000) + 'm ago';
    return Math.floor(ms/3600000) + 'h ago';
  }

  function renderEvent(evt) {
    const el = document.createElement('div');
    el.className = 'event';
    el.innerHTML = '<div class="ev-header">'
      + '<span class="ev-agent">' + esc(evt.agent) + '</span>'
      + '<span class="ev-type">' + esc(evt.type) + '</span>'
      + '<span class="ev-time">' + (evt.timestamp ? ago(evt.timestamp) : '') + '</span>'
      + '</div><div class="ev-summary">' + esc(evt.summary) + '</div>';
    return el;
  }

  async function loadInitial() {
    try {
      const res = await fetch(API + '/feed/events?limit=100');
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      const events = Array.isArray(data) ? data : (data.events || []);
      events.reverse();
      container.innerHTML = '';
      events.forEach(e => container.appendChild(renderEvent(e)));
      if (!events.length) container.innerHTML = '<div class="empty">No events yet</div>';
    } catch (e) {
      container.innerHTML = '<div class="empty">Feed unavailable: ' + esc(e.message) + '</div>';
    }
  }

  // SSE for live updates
  function startSSE() {
    fetch(API + '/feed/stream').then(res => {
      if (!res.ok) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      (async function read() {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const evt = JSON.parse(line.slice(6));
                const empty = container.querySelector('.empty');
                if (empty) empty.remove();
                container.prepend(renderEvent(evt));
              } catch {}
            }
          }
        }
      })().catch(() => setTimeout(startSSE, 5000));
    }).catch(() => setTimeout(startSSE, 5000));
  }

  loadInitial();
  startSSE();
})();
</script>
`);
  });

  return routes;
}
