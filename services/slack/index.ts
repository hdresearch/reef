/**
 * Slack service — outbound messaging and channel management.
 *
 * Uses a user-provided Slack Bot Token to send messages, list channels,
 * and verify connectivity. No webhooks — outbound only.
 *
 * Token resolution:
 *   1. SLACK_BOT_TOKEN env var
 *   2. vers-config store override
 *   3. Not configured (tools return setup instructions)
 *
 * Tools (3):
 *   reef_slack_send      — Post a message to a channel or thread
 *   reef_slack_channels  — List channels the bot can see
 *   reef_slack_configure — Set the bot token
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Hono } from "hono";
import type { FleetClient, RouteDocs, ServiceContext, ServiceModule } from "../../src/core/types.js";
import { splitMessage, stripInternalTags, submitToReef, waitForTaskResult } from "../shared/messaging.js";

const VERS_CONFIG_PATH = join(process.cwd(), "data", "vers-config.json");

function loadVersConfigOverride(key: string): string | null {
  try {
    if (!existsSync(VERS_CONFIG_PATH)) return null;
    const overrides = JSON.parse(readFileSync(VERS_CONFIG_PATH, "utf-8"));
    return typeof overrides[key] === "string" ? overrides[key] : null;
  } catch {
    return null;
  }
}

function resolveToken(): string | null {
  // 1. Environment variable (set at provision time)
  if (process.env.SLACK_BOT_TOKEN) return process.env.SLACK_BOT_TOKEN;
  // 2. vers-config store override (set at runtime via reef_slack_configure)
  return loadVersConfigOverride("SLACK_BOT_TOKEN");
}

function slackHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json; charset=utf-8",
  };
}

const SLACK_API = "https://slack.com/api";

interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

async function slackRequest(method: string, token: string, body?: Record<string, unknown>): Promise<SlackResponse> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: slackHeaders(token),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Slack API ${method} failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as SlackResponse;
  if (!data.ok) throw new Error(`Slack API ${method}: ${data.error || "unknown error"}`);
  return data;
}

const routes = new Hono();

routes.post("/send", async (c) => {
  const token = resolveToken();
  if (!token) return c.json({ error: "SLACK_BOT_TOKEN not configured" }, 503);
  try {
    const body = await c.req.json();
    const { channel, text, thread_ts } = body as { channel: string; text: string; thread_ts?: string };
    if (!channel || !text) return c.json({ error: "channel and text are required" }, 400);
    const payload: Record<string, unknown> = { channel, text };
    if (thread_ts) payload.thread_ts = thread_ts;
    const result = await slackRequest("chat.postMessage", token, payload);
    return c.json({ ok: true, channel: result.channel, ts: result.ts, message: result.message });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

routes.get("/channels", async (c) => {
  const token = resolveToken();
  if (!token) return c.json({ error: "SLACK_BOT_TOKEN not configured" }, 503);
  try {
    const result = await slackRequest("conversations.list", token, {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
    });
    const channels = (result.channels as any[]) || [];
    return c.json({
      channels: channels.map((ch: any) => ({
        id: ch.id,
        name: ch.name,
        topic: ch.topic?.value || "",
        purpose: ch.purpose?.value || "",
        is_private: ch.is_private,
        num_members: ch.num_members,
      })),
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

routes.get("/status", async (c) => {
  const token = resolveToken();
  if (!token) return c.json({ configured: false, error: "SLACK_BOT_TOKEN not set" });
  try {
    const result = await slackRequest("auth.test", token);
    return c.json({
      configured: true,
      team: result.team,
      user: result.user,
      bot_id: result.bot_id,
      team_id: result.team_id,
    });
  } catch (e: any) {
    return c.json({ configured: true, error: e.message });
  }
});

routes.get("/_panel", async (c) => {
  const token = resolveToken();
  const configured = !!token;
  let statusHtml = `<span style="color:${configured ? "#4f9" : "#f44"}">${configured ? "configured" : "not set"}</span>`;
  if (configured) {
    try {
      const result = await slackRequest("auth.test", token!);
      statusHtml += ` — ${esc(String(result.team))} / ${esc(String(result.user))}`;
    } catch (e: any) {
      statusHtml += ` — <span style="color:#f44">${esc(e.message)}</span>`;
    }
  }
  return c.html(
    `<div style="font-family:monospace;font-size:13px;color:#ccc">` +
      `<div style="margin-bottom:8px;color:#888">Slack Integration</div>` +
      `<div style="margin-bottom:4px">Bot Token: ${statusHtml}</div>` +
      `<div style="color:#666;font-size:11px;margin-top:8px">Set via: SLACK_BOT_TOKEN env var or PUT /vers-config/SLACK_BOT_TOKEN</div>` +
      `</div>`,
  );
});

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// =============================================================================
// Socket Mode — WebSocket connection for receiving messages
// =============================================================================

function resolveAppToken(): string | null {
  return process.env.SLACK_APP_TOKEN || loadVersConfigOverride("SLACK_APP_TOKEN");
}

interface SocketState {
  ws: WebSocket | null;
  botUserId: string | null;
  reconnectAttempts: number;
  shutdownRequested: boolean;
}

const socket: SocketState = {
  ws: null,
  botUserId: null,
  reconnectAttempts: 0,
  shutdownRequested: false,
};

let slackServiceBus: ServiceContext["events"] | null = null;

async function sendSlackReply(channel: string, text: string, threadTs?: string) {
  const token = resolveToken();
  if (!token) return;

  const cleaned = stripInternalTags(text);
  const chunks = splitMessage(cleaned, 3900); // Slack allows up to 40k, but keep reasonable

  try {
    for (const chunk of chunks) {
      const payload: Record<string, unknown> = { channel, text: chunk };
      if (threadTs) payload.thread_ts = threadTs;
      await slackRequest("chat.postMessage", token, payload);
    }
    console.log(`  [slack] Reply sent to ${channel} (${chunks.length} message(s))`);
  } catch (e: any) {
    console.error("  [slack] Failed to send reply:", e.message);
  }
}

async function connectSocketMode() {
  const appToken = resolveAppToken();
  if (!appToken || socket.shutdownRequested) return;

  console.log("  [slack] Connecting to Socket Mode...");

  // Get a WebSocket URL from Slack
  const res = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: { Authorization: `Bearer ${appToken}`, "Content-Type": "application/x-www-form-urlencoded" },
  });

  if (!res.ok) {
    console.error("  [slack] Failed to open Socket Mode connection:", res.status);
    scheduleReconnect();
    return;
  }

  const data = (await res.json()) as any;
  if (!data.ok || !data.url) {
    console.error("  [slack] Socket Mode connection failed:", data.error || "no URL returned");
    scheduleReconnect();
    return;
  }

  const ws = new WebSocket(data.url);
  socket.ws = ws;

  ws.onopen = () => {
    socket.reconnectAttempts = 0;
    console.log("  [slack] Socket Mode connected");
  };

  ws.onmessage = (event) => {
    let payload: any;
    try {
      payload = JSON.parse(String(event.data));
    } catch {
      return;
    }

    // Acknowledge all envelopes immediately (Slack requires this)
    if (payload.envelope_id) {
      ws.send(JSON.stringify({ envelope_id: payload.envelope_id }));
    }

    if (payload.type === "hello") {
      // Resolve bot user ID
      const token = resolveToken();
      if (token) {
        slackRequest("auth.test", token)
          .then((r) => {
            socket.botUserId = r.user_id as string;
            console.log(`  [slack] Socket Mode ready as ${r.user} (${r.user_id})`);
          })
          .catch(() => {});
      }
      return;
    }

    if (payload.type === "events_api") {
      const evt = payload.payload?.event || payload.event;
      if (evt) {
        handleSlackEvent(evt);
      }
    }
  };

  ws.onclose = () => {
    socket.ws = null;
    if (!socket.shutdownRequested) scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose handles reconnection
  };
}

function scheduleReconnect() {
  const delay = Math.min(1000 * 2 ** socket.reconnectAttempts, 30000);
  socket.reconnectAttempts++;
  console.log(`  [slack] Reconnecting in ${delay}ms...`);
  setTimeout(() => connectSocketMode(), delay);
}

function handleSlackEvent(event: any) {
  // Handle both message.im (DMs) and app_mention (@mentions in channels)
  const isMessage = event.type === "message" && !event.subtype;
  const isAppMention = event.type === "app_mention";

  if (!isMessage && !isAppMention) return;

  // Ignore bot messages
  if (event.bot_id) return;

  // Strip bot mention
  let text = event.text || "";
  if (socket.botUserId) {
    text = text.replace(new RegExp(`<@${socket.botUserId}>`, "g"), "").trim();
  }
  if (!text) text = "hello";

  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;
  console.log(`  [slack] Message from ${event.user} in ${channel}: ${text.slice(0, 80)}`);

  // Add reaction to acknowledge
  const token = resolveToken();
  if (token) {
    slackRequest("reactions.add", token, { channel, timestamp: event.ts, name: "eyes" }).catch(() => {});
  }

  // Deterministic conversation ID per Slack channel
  const conversationId = `slack-${channel}`;

  // Tell notifications service this is external
  if (slackServiceBus) slackServiceBus.fire("notification:external-task", { taskId: conversationId });

  submitToReef(text, conversationId)
    .then(() => waitForTaskResult(conversationId))
    .then(async (result) => {
      // Swap eyes → white_check_mark
      if (token) {
        slackRequest("reactions.remove", token, { channel, timestamp: event.ts, name: "eyes" }).catch(() => {});
        slackRequest("reactions.add", token, { channel, timestamp: event.ts, name: "white_check_mark" }).catch(
          () => {},
        );
      }
      await sendSlackReply(channel, result, threadTs);
    })
    .catch(async (err) => {
      console.error("  [slack] Error handling message:", err.message);
      if (token) {
        slackRequest("reactions.remove", token, { channel, timestamp: event.ts, name: "eyes" }).catch(() => {});
        slackRequest("reactions.add", token, { channel, timestamp: event.ts, name: "x" }).catch(() => {});
      }
      await sendSlackReply(channel, "Sorry, I encountered an error processing your message.", threadTs).catch(() => {});
    });
}

function disconnectSocketMode() {
  socket.shutdownRequested = true;
  if (socket.ws) {
    socket.ws.close(1000, "shutting down");
    socket.ws = null;
  }
}

const SLACK_RULES =
  "\n\nIMPORTANT — Slack operational rules:" +
  "\n- Don't spam channels — batch updates into single messages when possible" +
  "\n- Use threads (thread_ts) for multi-message conversations and follow-ups" +
  "\n- Prefer channels over DMs unless the user explicitly asks for a DM" +
  "\n- Keep messages concise and actionable";

function registerTools(pi: ExtensionAPI, client: FleetClient) {
  pi.registerTool({
    name: "reef_slack_send",
    label: "Slack: Send Message",
    description: `Send a message to a Slack channel or thread.${SLACK_RULES}`,
    parameters: Type.Object({
      channel: Type.String({ description: "Channel name (e.g. 'general') or ID (e.g. 'C1234567890')" }),
      text: Type.String({ description: "Message text (supports Slack markdown/mrkdwn)" }),
      thread_ts: Type.Optional(Type.String({ description: "Thread timestamp to reply in a thread" })),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api<{ ok: boolean; ts?: string; channel?: string }>("POST", "/slack/send", params);
        return client.ok(`Message sent to #${params.channel} (ts: ${result.ts})`);
      } catch (e: any) {
        if (e.message.includes("not configured")) {
          return client.err(
            "Slack not configured. Ask the user for a Slack Bot Token, then use reef_slack_configure to set it.",
          );
        }
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "reef_slack_channels",
    label: "Slack: List Channels",
    description: "List Slack channels the bot can access.",
    parameters: Type.Object({}),
    async execute() {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api<{ channels: any[] }>("GET", "/slack/channels");
        if (!result.channels?.length) return client.ok("No channels found.");
        const lines = result.channels.map((ch: any) => `#${ch.name} (ID: ${ch.id})${ch.topic ? ` — ${ch.topic}` : ""}`);
        return client.ok(lines.join("\n"));
      } catch (e: any) {
        if (e.message.includes("not configured")) {
          return client.err(
            "Slack not configured. Ask the user for a Slack Bot Token, then use reef_slack_configure to set it.",
          );
        }
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "reef_slack_configure",
    label: "Slack: Configure",
    description:
      "Set the Slack Bot Token. The user must create a Slack app at api.slack.com/apps, " +
      "add bot scopes (chat:write, channels:read, channels:history), install to workspace, " +
      "and provide the Bot User OAuth Token (xoxb-...).",
    parameters: Type.Object({
      token: Type.String({ description: "Slack Bot User OAuth Token (starts with xoxb-)" }),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        await client.api("PUT", "/vers-config/SLACK_BOT_TOKEN", { value: params.token });
        return client.ok(
          "Slack bot token saved. It will take effect on next reef restart, or set SLACK_BOT_TOKEN in the environment.",
        );
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });
}

const routeDocs: Record<string, RouteDocs> = {
  "POST /send": {
    summary: "Send a message to a Slack channel or thread",
    body: {
      channel: { type: "string", required: true, description: "Channel name or ID" },
      text: { type: "string", required: true, description: "Message text" },
      thread_ts: { type: "string", description: "Thread timestamp for replies" },
    },
    response: "{ ok, channel, ts, message }",
  },
  "GET /channels": {
    summary: "List channels the bot can access",
    response: "{ channels: [{ id, name, topic, purpose, is_private, num_members }] }",
  },
  "GET /status": {
    summary: "Check Slack integration status and bot identity",
    response: "{ configured, team, user, bot_id, team_id }",
  },
  "GET /_panel": {
    summary: "HTML debug view of Slack integration status",
    response: "text/html",
  },
};

// =============================================================================
// Notification forwarding — receives from notifications service
// =============================================================================

function resolveNotificationChannel(): string | null {
  if (process.env.SLACK_NOTIFICATION_CHANNEL) return process.env.SLACK_NOTIFICATION_CHANNEL;
  return loadVersConfigOverride("SLACK_NOTIFICATION_CHANNEL");
}

function formatNotificationForSlack(n: any): string {
  return `*${n.title}* — ${n.body}`;
}

async function sendSlackNotification(channel: string, text: string) {
  const token = resolveToken();
  if (!token) return;
  try {
    await slackRequest("chat.postMessage", token, { channel, text });
  } catch (e: any) {
    console.error("  [slack] Failed to forward notification:", e.message);
  }
}

// =============================================================================
// Module
// =============================================================================

const slack: ServiceModule = {
  name: "slack",
  description: "Slack messaging — send messages and manage channels via bot token",
  routes,
  routeDocs,
  registerTools,

  init(ctx: ServiceContext) {
    slackServiceBus = ctx.events;

    // Connect to Socket Mode if app token is available
    const appToken = resolveAppToken();
    if (appToken) {
      console.log("  [slack] App token found, connecting to Socket Mode...");
      connectSocketMode().catch((err: any) => console.error("  [slack] Socket Mode connection failed:", err.message));
    } else {
      console.log(
        "  [slack] No SLACK_APP_TOKEN set, Socket Mode disabled. Set token to enable bidirectional messaging.",
      );
    }

    // Subscribe to notification:push from the notifications service
    ctx.events.on("notification:push", (data: any) => {
      const channelId = resolveNotificationChannel();
      if (!channelId) return;

      const notifications: any[] = data?.notifications || [];
      if (notifications.length === 0) return;

      const formatted = notifications.map(formatNotificationForSlack).join("\n\n");
      sendSlackNotification(channelId, formatted);
    });

    const notifChannel = resolveNotificationChannel();
    if (notifChannel) {
      console.log(`  [slack] Notification forwarding to channel ${notifChannel}`);
    }
  },

  store: {
    async close() {
      disconnectSocketMode();
    },
  },

  dependencies: ["vers-config"],
  capabilities: ["slack.send", "slack.channels", "slack.socket-mode"],
};

export default slack;
