/**
 * Discord service — bidirectional messaging via bot token + Gateway.
 *
 * Outbound: send messages, list channels/guilds, verify connectivity.
 * Inbound: Gateway WebSocket receives messages, submits them to reef,
 *          and posts the response back to the Discord channel.
 *
 * Token resolution:
 *   1. DISCORD_BOT_TOKEN env var (set at provision time)
 *   2. vers-config store override (set at runtime)
 *   3. Not configured (tools return setup instructions, Gateway stays off)
 *
 * Tools (3):
 *   reef_discord_send      — Post a message to a channel
 *   reef_discord_channels  — List channels in a guild
 *   reef_discord_configure — Set the bot token
 *
 * Gateway:
 *   Connects on init() if token is available. Listens for MESSAGE_CREATE
 *   events where the bot is mentioned or DM'd. Submits to reef and replies.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Hono } from "hono";
import type { FleetClient, RouteDocs, ServiceContext, ServiceModule } from "../../src/core/types.js";
import { escapeHtml, invalidateConfigCache, resolveConfig } from "../shared/config.js";
import {
  reefAuthHeaders,
  reefBaseUrl,
  submitToReef as sharedSubmitToReef,
  waitForTaskResult as sharedWaitForResult,
  splitMessage,
  stripInternalTags,
} from "../shared/messaging.js";

// TODO: Replace with the official Vers Discord bot application ID
const DEFAULT_DISCORD_APP_ID = "YOUR_APP_ID_HERE";

function resolveAppId(): string {
  return resolveConfig("DISCORD_APP_ID") || DEFAULT_DISCORD_APP_ID;
}

function getInviteUrl(): string {
  const appId = resolveAppId();
  // permissions=2048 = Send Messages; 1024 = Read Message History; 68608 = combined useful set
  return `https://discord.com/api/oauth2/authorize?client_id=${appId}&permissions=68608&scope=bot`;
}

function resolveToken(): string | null {
  return resolveConfig("DISCORD_BOT_TOKEN");
}

function discordHeaders(token: string): Record<string, string> {
  return { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
}

const DISCORD_API = "https://discord.com/api/v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

// Discord Gateway intents
const INTENT_GUILDS = 1 << 0;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_DIRECT_MESSAGES = 1 << 12;
const INTENT_MESSAGE_CONTENT = 1 << 15;
const GATEWAY_INTENTS = INTENT_GUILDS | INTENT_GUILD_MESSAGES | INTENT_DIRECT_MESSAGES | INTENT_MESSAGE_CONTENT;

async function discordRequest(
  method: string,
  path: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<any> {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: discordHeaders(token),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// =============================================================================
// Gateway — WebSocket connection to Discord for receiving messages
// =============================================================================

interface GatewayState {
  ws: WebSocket | null;
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  heartbeatAcked: boolean;
  sequence: number | null;
  sessionId: string | null;
  resumeUrl: string | null;
  botUserId: string | null;
  reconnectAttempts: number;
  shutdownRequested: boolean;
}

const gateway: GatewayState = {
  ws: null,
  heartbeatInterval: null,
  heartbeatAcked: true,
  sequence: null,
  sessionId: null,
  resumeUrl: null,
  botUserId: null,
  reconnectAttempts: 0,
  shutdownRequested: false,
};

// Reference to event bus for notifying the notifications service about external tasks
let serviceBus: ServiceContext["events"] | null = null;

async function submitAndWait(prompt: string, channelId: string): Promise<string> {
  // Deterministic conversation ID per Discord channel — all messages in the
  // same channel continue the same reef conversation, preserving context.
  const conversationId = `discord-${channelId}`;

  await sharedSubmitToReef(prompt, conversationId);
  console.log(`  [discord] Task submitted: ${conversationId} (channel: ${channelId})`);

  // Tell the notifications service this task came from Discord (skip self-notification)
  if (serviceBus) serviceBus.fire("notification:external-task", { taskId: conversationId });

  const result = await sharedWaitForResult(conversationId);
  console.log("  [discord] Task result:", result.slice(0, 100));
  return result;
}

async function sendDiscordReply(channelId: string, content: string): Promise<void> {
  const token = resolveToken();
  if (!token) return;

  content = stripInternalTags(content);
  const chunks = splitMessage(content);

  try {
    for (const chunk of chunks) {
      await discordRequest("POST", `/channels/${channelId}/messages`, token, { content: chunk });
    }
    console.log(`  [discord] Reply sent to channel ${channelId} (${chunks.length} message(s))`);
  } catch (e: any) {
    console.error("  [discord] Failed to send reply:", e.message);
  }
}

function sendHeartbeat() {
  if (gateway.ws && gateway.ws.readyState === WebSocket.OPEN) {
    gateway.ws.send(JSON.stringify({ op: 1, d: gateway.sequence }));
  }
}

function startHeartbeat(intervalMs: number) {
  if (gateway.heartbeatInterval) clearInterval(gateway.heartbeatInterval);
  gateway.heartbeatAcked = true;

  // Discord requires first heartbeat after jitter
  const jitter = Math.random() * intervalMs;
  setTimeout(() => {
    sendHeartbeat();
    gateway.heartbeatAcked = false;

    gateway.heartbeatInterval = setInterval(() => {
      if (!gateway.heartbeatAcked) {
        console.log("  [discord] Gateway heartbeat not acked, reconnecting...");
        gateway.ws?.close(4000, "heartbeat timeout");
        return;
      }
      gateway.heartbeatAcked = false;
      sendHeartbeat();
    }, intervalMs);
  }, jitter);
}

function connectGateway() {
  const token = resolveToken();
  if (!token || gateway.shutdownRequested) return;

  const url = gateway.resumeUrl || GATEWAY_URL;
  console.log("  [discord] Connecting to Gateway...");

  const ws = new WebSocket(url);
  gateway.ws = ws;

  ws.onopen = () => {
    gateway.reconnectAttempts = 0;
  };

  ws.onmessage = (event) => {
    let payload: any;
    try {
      payload = JSON.parse(String(event.data));
    } catch {
      return;
    }

    const { op, d, s, t } = payload;

    if (s !== null && s !== undefined) gateway.sequence = s;

    // Op 10: Hello — start heartbeating and identify
    if (op === 10) {
      startHeartbeat(d.heartbeat_interval);

      if (gateway.sessionId && gateway.sequence !== null) {
        // Resume
        ws.send(
          JSON.stringify({
            op: 6,
            d: { token, session_id: gateway.sessionId, seq: gateway.sequence },
          }),
        );
      } else {
        // Identify
        ws.send(
          JSON.stringify({
            op: 2,
            d: {
              token,
              intents: GATEWAY_INTENTS,
              properties: { os: "linux", browser: "reef", device: "reef" },
            },
          }),
        );
      }
      return;
    }

    // Op 11: Heartbeat ACK
    if (op === 11) {
      gateway.heartbeatAcked = true;
      return;
    }

    // Op 1: Heartbeat request
    if (op === 1) {
      ws.send(JSON.stringify({ op: 1, d: gateway.sequence }));
      return;
    }

    // Op 7: Reconnect
    if (op === 7) {
      ws.close(4000, "server requested reconnect");
      return;
    }

    // Op 9: Invalid session
    if (op === 9) {
      gateway.sessionId = null;
      gateway.sequence = null;
      const delay = 1000 + Math.random() * 4000;
      setTimeout(() => connectGateway(), delay);
      return;
    }

    // Op 0: Dispatch
    if (op === 0) {
      handleDispatch(t, d);
    }
  };

  ws.onclose = (event) => {
    if (gateway.heartbeatInterval) clearInterval(gateway.heartbeatInterval);
    gateway.heartbeatInterval = null;
    gateway.ws = null;

    if (gateway.shutdownRequested) return;

    // Reconnect with backoff
    const delay = Math.min(1000 * 2 ** gateway.reconnectAttempts, 30000);
    gateway.reconnectAttempts++;
    console.log(`  [discord] Gateway closed (${event.code}), reconnecting in ${delay}ms...`);
    setTimeout(() => connectGateway(), delay);
  };

  ws.onerror = () => {
    // onclose will handle reconnection
  };
}

function handleDispatch(type: string, data: any) {
  if (type === "READY") {
    gateway.sessionId = data.session_id;
    gateway.resumeUrl = data.resume_gateway_url;
    gateway.botUserId = data.user?.id;
    console.log(`  [discord] Gateway connected as ${data.user?.username}#${data.user?.discriminator}`);
    return;
  }

  if (type === "RESUMED") {
    console.log("  [discord] Gateway session resumed");
    return;
  }

  if (type === "MESSAGE_CREATE") {
    handleMessage(data);
  }
}

function handleMessage(msg: any) {
  // Ignore messages from bots (including ourselves)
  if (msg.author?.bot) return;

  const botMentioned =
    gateway.botUserId && Array.isArray(msg.mentions) && msg.mentions.some((m: any) => m.id === gateway.botUserId);
  const isDM = msg.guild_id === undefined;

  // Only respond to @mentions or DMs
  if (!botMentioned && !isDM) return;

  // Strip the bot mention from the message content
  let content = msg.content || "";
  if (gateway.botUserId) {
    content = content.replace(new RegExp(`<@!?${gateway.botUserId}>`, "g"), "").trim();
  }

  if (!content) {
    content = "The user mentioned the bot without a message. Respond with a brief greeting and what you can help with.";
  }

  const channelId = msg.channel_id;
  console.log(`  [discord] Message from ${msg.author?.username} in ${channelId}: ${content.slice(0, 80)}`);

  const token = resolveToken();
  const messageId = msg.id;

  function react(emoji: string) {
    if (!token) return;
    fetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, {
      method: "PUT",
      headers: discordHeaders(token),
    }).catch(() => {});
  }

  function unreact(emoji: string) {
    if (!token) return;
    fetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, {
      method: "DELETE",
      headers: discordHeaders(token),
    }).catch(() => {});
  }

  // Acknowledge receipt
  react("👀");
  if (token) {
    fetch(`${DISCORD_API}/channels/${channelId}/typing`, {
      method: "POST",
      headers: discordHeaders(token),
    }).catch(() => {});
  }

  // Submit to reef and reply (async, don't block the Gateway handler)
  submitAndWait(content, channelId)
    .then(async (result) => {
      unreact("👀");
      react("✅");
      await sendDiscordReply(channelId, result);
    })
    .catch(async (err) => {
      console.error("  [discord] Error handling message:", err.message);
      unreact("👀");
      react("❌");
      await sendDiscordReply(channelId, "Sorry, I encountered an error processing your message.").catch(() => {});
    });
}

function disconnectGateway() {
  gateway.shutdownRequested = true;
  if (gateway.heartbeatInterval) {
    clearInterval(gateway.heartbeatInterval);
    gateway.heartbeatInterval = null;
  }
  if (gateway.ws) {
    gateway.ws.close(1000, "shutting down");
    gateway.ws = null;
  }
}

// =============================================================================
// Notification forwarding — receives from notifications service
// =============================================================================

function resolveNotificationChannel(): string | null {
  return resolveConfig("DISCORD_NOTIFICATION_CHANNEL_ID");
}

function formatNotificationForDiscord(n: any): string {
  const icon =
    n.level === "error"
      ? "\u274C"
      : n.level === "warning"
        ? "\u26A0\uFE0F"
        : n.level === "success"
          ? "\u2705"
          : "\u2139\uFE0F";
  return `${icon} **${n.title}** — ${n.body}`;
}

function subscribeToNotifications(ctx: ServiceContext) {
  ctx.events.on("notification:push", (data: any) => {
    const channelId = resolveNotificationChannel();
    if (!channelId) return;

    const notifications: any[] = data?.notifications || [];
    if (notifications.length === 0) return;

    const formatted = notifications.map(formatNotificationForDiscord).join("\n\n");
    sendDiscordReply(channelId, formatted).catch((err: any) => {
      console.error("  [discord] Failed to forward notification:", err.message);
    });
  });

  console.log("  [discord] Notification forwarding subscribed");
}

// =============================================================================
// Routes
// =============================================================================

const routes = new Hono();

routes.post("/send", async (c) => {
  const token = resolveToken();
  if (!token) return c.json({ error: "DISCORD_BOT_TOKEN not configured" }, 503);
  try {
    const body = await c.req.json();
    const { channel_id, content } = body as { channel_id: string; content: string };
    if (!channel_id || !content) return c.json({ error: "channel_id and content are required" }, 400);
    const result = await discordRequest("POST", `/channels/${channel_id}/messages`, token, { content });
    return c.json({
      ok: true,
      id: result.id,
      channel_id: result.channel_id,
      content: result.content,
      timestamp: result.timestamp,
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

routes.get("/channels", async (c) => {
  const token = resolveToken();
  if (!token) return c.json({ error: "DISCORD_BOT_TOKEN not configured" }, 503);
  const guildId = c.req.query("guild_id");
  if (!guildId) return c.json({ error: "guild_id query param is required" }, 400);
  try {
    const channels = await discordRequest("GET", `/guilds/${guildId}/channels`, token);
    const textChannels = (channels as any[]).filter((ch: any) => ch.type === 0 || ch.type === 5);
    return c.json({
      channels: textChannels.map((ch: any) => ({
        id: ch.id,
        name: ch.name,
        type: ch.type,
        topic: ch.topic || "",
        position: ch.position,
        parent_id: ch.parent_id,
      })),
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

routes.get("/guilds", async (c) => {
  const token = resolveToken();
  if (!token) return c.json({ error: "DISCORD_BOT_TOKEN not configured" }, 503);
  try {
    const guilds = await discordRequest("GET", "/users/@me/guilds", token);
    return c.json({
      guilds: (guilds as any[]).map((g: any) => ({
        id: g.id,
        name: g.name,
        icon: g.icon,
        owner: g.owner,
        permissions: g.permissions,
      })),
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

routes.get("/invite", (c) => {
  const url = getInviteUrl();
  const appId = resolveAppId();
  const isPlaceholder = appId === DEFAULT_DISCORD_APP_ID;
  return c.json({
    url,
    appId,
    placeholder: isPlaceholder,
    instructions: isPlaceholder
      ? "The official Vers bot is not yet configured. Set DISCORD_APP_ID or use reef_discord_configure with a BYO bot token."
      : "Click the URL to add the Vers bot to your Discord server. Once added, tell the agent which channel to use for notifications.",
  });
});

routes.get("/status", async (c) => {
  const token = resolveToken();
  if (!token) return c.json({ configured: false, error: "DISCORD_BOT_TOKEN not set" });
  try {
    const user = await discordRequest("GET", "/users/@me", token);
    return c.json({
      configured: true,
      username: user.username,
      discriminator: user.discriminator,
      id: user.id,
      bot: user.bot,
      gateway: {
        connected: gateway.ws !== null && gateway.ws.readyState === WebSocket.OPEN,
        sessionId: gateway.sessionId,
        botUserId: gateway.botUserId,
      },
    });
  } catch (e: any) {
    return c.json({ configured: true, error: e.message });
  }
});

routes.get("/_panel", async (c) => {
  const token = resolveToken();
  const configured = !!token;
  const gwConnected = gateway.ws !== null && gateway.ws.readyState === WebSocket.OPEN;
  let statusHtml = `<span style="color:${configured ? "#4f9" : "#f44"}">${configured ? "configured" : "not set"}</span>`;
  if (configured) {
    try {
      const user = await discordRequest("GET", "/users/@me", token!);
      statusHtml += ` — ${escapeHtml(user.username)}#${escapeHtml(user.discriminator)}`;
    } catch (e: any) {
      statusHtml += ` — <span style="color:#f44">${escapeHtml(e.message)}</span>`;
    }
  }
  const gwHtml = `<span style="color:${gwConnected ? "#4f9" : "#f44"}">${gwConnected ? "connected" : "disconnected"}</span>`;
  return c.html(
    `<div style="font-family:monospace;font-size:13px;color:#ccc">` +
      `<div style="margin-bottom:8px;color:#888">Discord Integration</div>` +
      `<div style="margin-bottom:4px">Bot Token: ${statusHtml}</div>` +
      `<div style="margin-bottom:4px">Gateway: ${gwHtml}</div>` +
      `<div style="color:#666;font-size:11px;margin-top:8px">Set via: DISCORD_BOT_TOKEN env var or PUT /vers-config/DISCORD_BOT_TOKEN</div>` +
      `</div>`,
  );
});

routes.get("/notifications", (c) => {
  const channelId = resolveNotificationChannel();
  return c.json({ channelId, enabled: !!channelId });
});

routes.put("/notifications", async (c) => {
  const body = await c.req.json();
  const baseUrl = reefBaseUrl();
  const headers = reefAuthHeaders();

  if (typeof body.channel_id === "string") {
    await fetch(`${baseUrl}/vers-config/DISCORD_NOTIFICATION_CHANNEL_ID`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ value: body.channel_id }),
    });
  }
  invalidateConfigCache();
  return c.json({ channelId: resolveNotificationChannel() });
});

// =============================================================================
// Tools
// =============================================================================

const DISCORD_RULES =
  "\n\nIMPORTANT — Discord operational rules:" +
  "\n- Don't spam channels — batch updates into single messages when possible" +
  "\n- Always specify the target channel ID (use reef_discord_channels to find IDs)" +
  "\n- Keep messages concise and actionable" +
  "\n- Use reef_discord_channels with a guild_id to discover available channels";

function registerTools(pi: ExtensionAPI, client: FleetClient) {
  pi.registerTool({
    name: "reef_discord_send",
    label: "Discord: Send Message",
    description: `Send a message to a Discord channel.${DISCORD_RULES}`,
    parameters: Type.Object({
      channel_id: Type.String({ description: "Discord channel ID" }),
      content: Type.String({ description: "Message content (supports Discord markdown)" }),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api<{ ok: boolean; id?: string; channel_id?: string }>(
          "POST",
          "/discord/send",
          params,
        );
        return client.ok(`Message sent (id: ${result.id}) to channel ${result.channel_id}`);
      } catch (e: any) {
        if (e.message.includes("not configured")) {
          return client.err(
            "Discord not configured. Use reef_discord_setup to get the invite link, or reef_discord_configure for a BYO bot token.",
          );
        }
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "reef_discord_channels",
    label: "Discord: List Channels",
    description: "List text channels in a Discord guild (server).",
    parameters: Type.Object({
      guild_id: Type.String({ description: "Discord guild (server) ID" }),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api<{ channels: any[] }>(
          "GET",
          `/discord/channels?guild_id=${encodeURIComponent(params.guild_id)}`,
        );
        if (!result.channels?.length) return client.ok("No text channels found in this guild.");
        const lines = result.channels.map((ch: any) => `#${ch.name} (ID: ${ch.id})${ch.topic ? ` — ${ch.topic}` : ""}`);
        return client.ok(lines.join("\n"));
      } catch (e: any) {
        if (e.message.includes("not configured")) {
          return client.err(
            "Discord not configured. Use reef_discord_setup to get the invite link, or reef_discord_configure for a BYO bot token.",
          );
        }
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "reef_discord_setup",
    label: "Discord: Setup",
    description:
      "Set up Discord integration. Returns an invite link for the user to add the Vers bot to their server. " +
      "This is the default path — the user clicks the link, authorizes, and the bot joins their server. " +
      "Once added, ask which channel to use for notifications.",
    parameters: Type.Object({}),
    async execute() {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api<{ url: string; placeholder: boolean; instructions: string }>(
          "GET",
          "/discord/invite",
        );
        if (result.placeholder) {
          return client.ok(
            "The official Vers Discord bot is not yet configured.\n\n" +
              "For now, you can bring your own bot token using reef_discord_configure.\n" +
              "To create a bot: discord.com/developers/applications → New App → Bot → copy token.",
          );
        }
        return client.ok(
          "**Add the Vers bot to your Discord server:**\n\n" +
            result.url +
            "\n\n" +
            "Click the link, select your server, and authorize.\n" +
            "Once added, tell me which channel to use for notifications.",
        );
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "reef_discord_configure",
    label: "Discord: Configure (BYO Token)",
    description:
      "Fallback: set a custom Discord Bot Token for self-hosted or BYO-bot setups. " +
      "Most users should use reef_discord_setup instead, which provides the official Vers bot invite link. " +
      "Only use this if the user explicitly provides their own bot token.",
    parameters: Type.Object({
      token: Type.String({ description: "Discord Bot Token" }),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        await client.api("PUT", "/vers-config/DISCORD_BOT_TOKEN", { value: params.token });
        invalidateConfigCache();
        return client.ok(
          "Discord bot token saved. It will take effect on next reef restart, or set DISCORD_BOT_TOKEN in the environment.",
        );
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "reef_discord_notify",
    label: "Discord: Set Notification Channel",
    description:
      "Enable proactive Discord notifications by setting the channel where reef events " +
      "(task completions, lieutenant lifecycle, swarm results, errors) are posted automatically.",
    parameters: Type.Object({
      channel_id: Type.String({ description: "Discord channel ID to send notifications to" }),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        await client.api("PUT", "/discord/notifications", { channel_id: params.channel_id });
        return client.ok(
          `Notifications enabled for channel ${params.channel_id}. Reef events will be posted there automatically.`,
        );
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  // Mute/unmute/stop are handled centrally by the notifications service.
  // Use reef_notify_mute / reef_notify_unmute for global control.
}

// =============================================================================
// Module
// =============================================================================

const routeDocs: Record<string, RouteDocs> = {
  "POST /send": {
    summary: "Send a message to a Discord channel",
    body: {
      channel_id: { type: "string", required: true, description: "Discord channel ID" },
      content: { type: "string", required: true, description: "Message content" },
    },
    response: "{ ok, id, channel_id, content, timestamp }",
  },
  "GET /channels": {
    summary: "List text channels in a guild",
    query: { guild_id: { type: "string", required: true, description: "Discord guild ID" } },
    response: "{ channels: [{ id, name, type, topic, position, parent_id }] }",
  },
  "GET /guilds": {
    summary: "List guilds the bot is in",
    response: "{ guilds: [{ id, name, icon, owner, permissions }] }",
  },
  "GET /invite": {
    summary: "Get the Discord bot invite link for adding the Vers bot to a server",
    response: "{ url, appId, placeholder, instructions }",
  },
  "GET /status": {
    summary: "Check Discord integration status, bot identity, and Gateway connection",
    response: "{ configured, username, discriminator, id, bot, gateway: { connected, sessionId, botUserId } }",
  },
  "GET /_panel": {
    summary: "HTML debug view of Discord integration status",
    response: "text/html",
  },
  "GET /notifications": {
    summary: "Get current notification config",
    response: "{ channelId, muted, enabled }",
  },
  "PUT /notifications": {
    summary: "Set notification channel and/or mute state",
    body: {
      channel_id: { type: "string", description: "Channel ID for notifications (empty to disable)" },
      muted: { type: "boolean", description: "Mute/unmute notifications" },
    },
    response: "{ channelId, muted }",
  },
};

const discord: ServiceModule = {
  name: "discord",
  description: "Discord messaging — send and receive messages via bot token + Gateway",
  routes,
  routeDocs,
  registerTools,

  init(ctx: ServiceContext) {
    serviceBus = ctx.events;

    // Connect to Discord Gateway if token is available
    const token = resolveToken();
    if (token) {
      console.log("  [discord] Token found, connecting to Gateway...");
      connectGateway();
    } else {
      console.log(
        "  [discord] No DISCORD_BOT_TOKEN set, Gateway disabled. Set token to enable bidirectional messaging.",
      );
    }

    // Subscribe to notification:push from the notifications service
    subscribeToNotifications(ctx);
    const notifChannel = resolveNotificationChannel();
    if (notifChannel) {
      console.log(`  [discord] Notification forwarding to channel ${notifChannel}`);
    } else {
      console.log("  [discord] No notification channel set. Use reef_discord_notify to enable.");
    }
  },

  store: {
    async close() {
      disconnectGateway();
    },
  },

  dependencies: ["vers-config"],
  capabilities: ["discord.send", "discord.channels", "discord.gateway"],
};

export default discord;
