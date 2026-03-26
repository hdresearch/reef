/**
 * Notifications service — centralized event filtering and push.
 *
 * Subscribes to reef's ServiceEventBus, applies a heuristic to decide
 * what's worth notifying, and emits `notification:push` events for
 * transport services (Discord, Slack, etc.) to forward to users.
 *
 * This service does not know about Discord, Slack, or any specific
 * transport — it emits channel-agnostic notification objects.
 *
 * Routes:
 *   GET  /notifications/config      — current settings
 *   PUT  /notifications/config      — update settings
 *   GET  /notifications/history     — recent notifications
 *   POST /notifications/test        — send a test notification
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Hono } from "hono";
import type { FleetClient, RouteDocs, ServiceContext, ServiceModule } from "../../src/core/types.js";

// =============================================================================
// Types
// =============================================================================

interface Notification {
  id: string;
  level: "info" | "success" | "warning" | "error";
  title: string;
  body: string;
  source: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Config
// =============================================================================

const VERS_CONFIG_PATH = join(process.cwd(), "data", "vers-config.json");

let configCache: { data: Record<string, string>; ts: number } | null = null;
const CONFIG_TTL = 30_000;

function loadConfigOverride(key: string): string | null {
  const now = Date.now();
  if (configCache && now - configCache.ts < CONFIG_TTL) {
    return configCache.data[key] ?? null;
  }
  try {
    if (!existsSync(VERS_CONFIG_PATH)) {
      configCache = { data: {}, ts: now };
      return null;
    }
    const data = JSON.parse(readFileSync(VERS_CONFIG_PATH, "utf-8"));
    configCache = { data, ts: now };
    return typeof data[key] === "string" ? data[key] : null;
  } catch {
    return null;
  }
}

function isMuted(): boolean {
  const muted = process.env.NOTIFICATION_MUTE || loadConfigOverride("NOTIFICATION_MUTE");
  return muted === "true";
}

function minDurationMs(): number {
  const val = process.env.NOTIFICATION_MIN_DURATION_MS || loadConfigOverride("NOTIFICATION_MIN_DURATION_MS");
  const parsed = val ? parseInt(val, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : 30_000;
}

// =============================================================================
// Notification history (ring buffer)
// =============================================================================

const MAX_HISTORY = 50;
const history: Notification[] = [];

function addToHistory(notification: Notification) {
  history.push(notification);
  if (history.length > MAX_HISTORY) history.shift();
}

// =============================================================================
// Heuristic — what's worth notifying
// =============================================================================

// Track task IDs that came from external channels (Discord, Slack) to avoid self-notification
const externalTaskIds = new Set<string>();

function registerExternalTask(taskId: string) {
  externalTaskIds.add(taskId);
}

function shouldNotifyTask(data: any): boolean {
  const taskId = data?.taskId;

  // Skip tasks submitted from external channels (user already saw the reply)
  if (taskId && externalTaskIds.has(taskId)) {
    externalTaskIds.delete(taskId);
    return false;
  }

  // Always notify errors
  if (data?.type === "task_error") return true;

  // Notify if files were changed (something was built)
  const filesChanged = data?.filesChanged;
  if (Array.isArray(filesChanged) && filesChanged.length > 0) return true;

  // Notify if task took longer than threshold
  const duration = data?.durationMs;
  if (typeof duration === "number" && duration >= minDurationMs()) return true;

  return false;
}

// =============================================================================
// Batching — collect notifications for 5s, then flush
// =============================================================================

const buffer: Notification[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let eventBus: ServiceContext["events"] | null = null;

function queueNotification(notification: Notification) {
  if (isMuted()) return;

  addToHistory(notification);
  buffer.push(notification);

  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushBuffer, 5000);
}

function flushBuffer() {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0);
  flushTimer = null;

  if (eventBus) {
    eventBus.fire("notification:push", { notifications: batch });
  }
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

// =============================================================================
// Event subscriptions
// =============================================================================

function subscribeToEvents(ctx: ServiceContext) {
  eventBus = ctx.events;

  // Task completions
  ctx.events.on("reef:event", (data: any) => {
    const type = data?.type || data?.eventType;

    if (type === "task_done" || type === "task_error") {
      if (!shouldNotifyTask(data)) return;

      const trigger = data.trigger || data.prompt || data.taskId || "";
      const duration = data.durationMs ? ` (${formatDuration(data.durationMs)})` : "";

      if (type === "task_error") {
        const err = data.error || "unknown error";
        queueNotification({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          level: "error",
          title: `Task failed${duration}`,
          body: `"${trigger.slice(0, 80)}"\nError: ${err.slice(0, 200)}`,
          source: "reef",
          timestamp: Date.now(),
          metadata: { taskId: data.taskId, error: err, durationMs: data.durationMs },
        });
      } else {
        const summary = (data.summary || data.output || "").slice(0, 300);
        queueNotification({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          level: "success",
          title: `Task completed${duration}`,
          body: `"${trigger.slice(0, 80)}"\n${summary}`,
          source: "reef",
          timestamp: Date.now(),
          metadata: { taskId: data.taskId, durationMs: data.durationMs },
        });
      }
    }

    if (type === "service_installed") {
      queueNotification({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        level: "info",
        title: "Service installed",
        body: data.name || "unknown",
        source: "installer",
        timestamp: Date.now(),
      });
    }
    if (type === "service_removed") {
      queueNotification({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        level: "warning",
        title: "Service removed",
        body: data.name || "unknown",
        source: "installer",
        timestamp: Date.now(),
      });
    }
  });

  // Lieutenant lifecycle
  ctx.events.on("lieutenant:created", (data: any) => {
    if (data?.reconnected) return;
    queueNotification({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      level: "info",
      title: "Lieutenant spawned",
      body: `${data?.name || "unknown"} (VM: ${data?.vmId || "?"})`,
      source: "lieutenant",
      timestamp: Date.now(),
      metadata: { vmId: data?.vmId, name: data?.name },
    });
  });
  ctx.events.on("lieutenant:completed", (data: any) => {
    const duration = data?.duration ? ` (${formatDuration(data.duration)})` : "";
    queueNotification({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      level: "success",
      title: "Lieutenant completed",
      body: `${data?.name || "unknown"}${duration}`,
      source: "lieutenant",
      timestamp: Date.now(),
      metadata: { vmId: data?.vmId, name: data?.name },
    });
  });
  ctx.events.on("lieutenant:destroyed", (data: any) => {
    queueNotification({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      level: "warning",
      title: "Lieutenant destroyed",
      body: data?.name || "unknown",
      source: "lieutenant",
      timestamp: Date.now(),
      metadata: { vmId: data?.vmId, name: data?.name },
    });
  });

  // Swarm events
  const SWARM_TTL = 30 * 60 * 1000;
  const swarmTracker = new Map<string, { total: number; done: number; failed: number; createdAt: number }>();

  ctx.events.on("swarm:agent_spawned", (data: any) => {
    const key = data?.swarmId || "default";
    const tracker = swarmTracker.get(key) || { total: 0, done: 0, failed: 0, createdAt: Date.now() };
    tracker.total++;
    swarmTracker.set(key, tracker);
    // Sweep stale entries
    const now = Date.now();
    for (const [k, v] of swarmTracker) {
      if (now - v.createdAt > SWARM_TTL) swarmTracker.delete(k);
    }
  });
  ctx.events.on("swarm:agent_completed", (data: any) => {
    const key = data?.swarmId || "default";
    const tracker = swarmTracker.get(key);
    if (!tracker) return;
    tracker.done++;
    if (tracker.done + tracker.failed >= tracker.total) {
      queueNotification({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        level: tracker.failed > 0 ? "warning" : "success",
        title: "Swarm finished",
        body: `${tracker.done}/${tracker.total} workers done${tracker.failed > 0 ? `, ${tracker.failed} failed` : ""}`,
        source: "swarm",
        timestamp: Date.now(),
      });
      swarmTracker.delete(key);
    }
  });
  ctx.events.on("swarm:agent_error", (data: any) => {
    const key = data?.swarmId || "default";
    const tracker = swarmTracker.get(key);
    if (tracker) tracker.failed++;
    queueNotification({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      level: "error",
      title: "Swarm worker error",
      body: `${data?.label || data?.vmId || "unknown"}: ${(data?.error || "unknown error").slice(0, 200)}`,
      source: "swarm",
      timestamp: Date.now(),
      metadata: { vmId: data?.vmId, label: data?.label },
    });
  });

  // Allow external channels to register their task IDs
  ctx.events.on("notification:external-task", (data: any) => {
    if (data?.taskId) registerExternalTask(data.taskId);
  });

  console.log("  [notifications] Event subscriptions active");
}

// =============================================================================
// Routes
// =============================================================================

const routes = new Hono();

routes.get("/config", (c) => {
  return c.json({
    muted: isMuted(),
    minDurationMs: minDurationMs(),
  });
});

routes.put("/config", async (c) => {
  const body = await c.req.json();
  const baseUrl = process.env.VERS_INFRA_URL || "http://localhost:3000";
  const token = process.env.VERS_AUTH_TOKEN || "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  if (typeof body.muted === "boolean") {
    await fetch(`${baseUrl}/vers-config/NOTIFICATION_MUTE`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ value: body.muted ? "true" : "false" }),
    });
    configCache = null;
  }
  if (typeof body.minDurationMs === "number") {
    await fetch(`${baseUrl}/vers-config/NOTIFICATION_MIN_DURATION_MS`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ value: String(body.minDurationMs) }),
    });
    configCache = null;
  }

  return c.json({ muted: isMuted(), minDurationMs: minDurationMs() });
});

routes.get("/history", (c) => {
  return c.json({ notifications: [...history].reverse() });
});

routes.post("/test", (c) => {
  const notification: Notification = {
    id: `test-${Date.now()}`,
    level: "info",
    title: "Test notification",
    body: "This is a test notification from the reef notifications service.",
    source: "notifications",
    timestamp: Date.now(),
  };

  addToHistory(notification);

  if (eventBus) {
    eventBus.fire("notification:push", { notifications: [notification] });
  }

  return c.json({ sent: true, notification });
});

// =============================================================================
// Tools
// =============================================================================

function registerTools(pi: ExtensionAPI, client: FleetClient) {
  pi.registerTool({
    name: "reef_notify_test",
    label: "Notifications: Send Test",
    description: "Send a test notification to all subscribed channels (Discord, Slack, etc.)",
    parameters: Type.Object({}),
    async execute() {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api<{ sent: boolean }>("POST", "/notifications/test");
        return client.ok(result.sent ? "Test notification sent to all channels." : "No notification sent.");
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "reef_notify_mute",
    label: "Notifications: Mute All",
    description: "Mute all notifications across all channels (Discord, Slack, etc.)",
    parameters: Type.Object({}),
    async execute() {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        await client.api("PUT", "/notifications/config", { muted: true });
        return client.ok("All notifications muted.");
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "reef_notify_unmute",
    label: "Notifications: Unmute All",
    description: "Resume all notifications across all channels.",
    parameters: Type.Object({}),
    async execute() {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        await client.api("PUT", "/notifications/config", { muted: false });
        return client.ok("All notifications resumed.");
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "reef_notify_history",
    label: "Notifications: Recent History",
    description: "Show recent notifications (last 50).",
    parameters: Type.Object({}),
    async execute() {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api<{ notifications: Notification[] }>("GET", "/notifications/history");
        if (!result.notifications?.length) return client.ok("No recent notifications.");
        const lines = result.notifications.map((n) => `[${n.level}] ${n.title} — ${n.body.slice(0, 80)}`);
        return client.ok(lines.join("\n"));
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });
}

// =============================================================================
// Module
// =============================================================================

const routeDocs: Record<string, RouteDocs> = {
  "GET /config": {
    summary: "Get notification settings",
    response: "{ muted, minDurationMs }",
  },
  "PUT /config": {
    summary: "Update notification settings",
    body: {
      muted: { type: "boolean", description: "Mute/unmute all notifications" },
      minDurationMs: { type: "number", description: "Minimum task duration to notify (ms)" },
    },
    response: "{ muted, minDurationMs }",
  },
  "GET /history": {
    summary: "Recent notifications (last 50)",
    response: "{ notifications: [{ id, level, title, body, source, timestamp, metadata }] }",
  },
  "POST /test": {
    summary: "Send a test notification to all subscribers",
    response: "{ sent, notification }",
  },
};

const notifications: ServiceModule = {
  name: "notifications",
  description: "Centralized event notifications — filters reef events and pushes to subscribed channels",
  routes,
  routeDocs,
  registerTools,

  init(ctx: ServiceContext) {
    subscribeToEvents(ctx);
  },

  store: {
    async close() {
      // Flush pending notifications before shutdown
      if (buffer.length > 0) {
        if (flushTimer) clearTimeout(flushTimer);
        flushBuffer();
      }
    },
  },

  dependencies: ["vers-config"],
  capabilities: ["notifications.push", "notifications.history"],
};

export default notifications;
