/**
 * Vers Config service — centralized config resolution for the Vers platform.
 *
 * Replaces scattered config files from pi-vers:
 *   ~/.vers/keys.json           → reef config overrides + file fallback
 *   ~/.vers/config.json         → reef config overrides + file fallback
 *   ~/.vers/agent-services.json → reef config overrides + file fallback
 *   ~/.pi/lieutenants.json     → reef SQLite (lieutenant service)
 *
 * SSH-specific config (keys, control sockets) stays in pi-vers.
 *
 * Config hierarchy (highest priority first):
 *   1. Environment variables (VERS_API_KEY, VERS_AUTH_TOKEN, etc.)
 *   2. Reef override file values (set via API or tools)
 *   3. File-based fallbacks (~/.vers/keys.json, etc.)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Hono } from "hono";
import type { FleetClient, ServiceContext, ServiceModule } from "../../src/core/types.js";

// =============================================================================
// Config resolution
// =============================================================================

interface VersConfig {
  apiKey: string | null;
  infraUrl: string | null;
  authToken: string | null;
  baseUrl: string | null;
  agentName: string | null;
  vmId: string | null;
  agentRole: string | null;
}

const OVERRIDES_PATH = join(process.cwd(), "data", "vers-config.json");

/** Stored overrides (set via API, persisted in reef data dir) */
const overrides: Record<string, string> = {};

function loadOverrides() {
  try {
    if (!existsSync(OVERRIDES_PATH)) return;
    Object.assign(overrides, JSON.parse(readFileSync(OVERRIDES_PATH, "utf-8")));
  } catch {
    // Fall back to empty overrides on malformed data.
  }
}

function saveOverrides() {
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
}

function loadFileConfig(filename: string): Record<string, unknown> {
  try {
    const filePath = join(homedir(), ".vers", filename);
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf-8"));
    }
  } catch {
    /* ignore */
  }
  return {};
}

function resolveApiKey(): string | null {
  // 1. Environment variable
  if (process.env.VERS_API_KEY) return process.env.VERS_API_KEY;
  // 2. Store override
  if (overrides.VERS_API_KEY) return overrides.VERS_API_KEY;
  // 3. File fallback
  const keys = loadFileConfig("keys.json") as { keys?: { VERS_API_KEY?: string } };
  return keys.keys?.VERS_API_KEY || null;
}

function resolveConfig(): VersConfig {
  const agentServices = loadFileConfig("agent-services.json") as {
    infraUrl?: string;
    authToken?: string;
  };
  const config = loadFileConfig("config.json") as {
    baseUrl?: string;
  };

  return {
    apiKey: resolveApiKey(),
    infraUrl: process.env.VERS_INFRA_URL || overrides.VERS_INFRA_URL || agentServices.infraUrl || null,
    authToken: process.env.VERS_AUTH_TOKEN || overrides.VERS_AUTH_TOKEN || agentServices.authToken || null,
    baseUrl: process.env.VERS_BASE_URL || overrides.VERS_BASE_URL || config.baseUrl || null,
    agentName: process.env.VERS_AGENT_NAME || overrides.VERS_AGENT_NAME || null,
    vmId: process.env.VERS_VM_ID || overrides.VERS_VM_ID || null,
    agentRole: process.env.VERS_AGENT_ROLE || overrides.VERS_AGENT_ROLE || null,
  };
}

// =============================================================================
// Routes
// =============================================================================

const routes = new Hono();

// GET / — resolve current config (masks sensitive values)
routes.get("/", (c) => {
  const cfg = resolveConfig();
  return c.json({
    apiKey: cfg.apiKey ? `${cfg.apiKey.slice(0, 8)}...` : null,
    infraUrl: cfg.infraUrl,
    authToken: cfg.authToken ? `${cfg.authToken.slice(0, 8)}...` : null,
    baseUrl: cfg.baseUrl,
    agentName: cfg.agentName,
    vmId: cfg.vmId,
    agentRole: cfg.agentRole,
    sources: {
      apiKey: process.env.VERS_API_KEY ? "env" : overrides.VERS_API_KEY ? "store" : "file",
      infraUrl: process.env.VERS_INFRA_URL ? "env" : overrides.VERS_INFRA_URL ? "store" : "file",
      authToken: process.env.VERS_AUTH_TOKEN ? "env" : overrides.VERS_AUTH_TOKEN ? "store" : "file",
    },
  });
});

// PUT /:key — set a config override
routes.put("/:key", async (c) => {
  const key = c.req.param("key").toUpperCase();
  const validKeys = new Set([
    "VERS_API_KEY",
    "VERS_INFRA_URL",
    "VERS_AUTH_TOKEN",
    "VERS_BASE_URL",
    "VERS_AGENT_NAME",
    "VERS_VM_ID",
    "VERS_AGENT_ROLE",
    "SLACK_BOT_TOKEN",
    "DISCORD_BOT_TOKEN",
    "DISCORD_NOTIFICATION_CHANNEL_ID",
    "DISCORD_NOTIFICATIONS_MUTED",
    "NOTIFICATION_MUTE",
    "NOTIFICATION_MIN_DURATION_MS",
    "SLACK_NOTIFICATION_CHANNEL",
  ]);

  if (!validKeys.has(key)) {
    return c.json({ error: `Invalid config key: ${key}. Valid: ${Array.from(validKeys).join(", ")}` }, 400);
  }

  const body = await c.req.json();
  if (typeof body.value !== "string") {
    return c.json({ error: "value must be a string" }, 400);
  }

  overrides[key] = body.value;
  saveOverrides();
  return c.json({ key, set: true, source: "store" });
});

// DELETE /:key — remove a config override
routes.delete("/:key", (c) => {
  const key = c.req.param("key").toUpperCase();
  if (overrides[key]) {
    delete overrides[key];
    saveOverrides();
    return c.json({ key, deleted: true });
  }
  return c.json({ error: "Key not found in overrides" }, 404);
});

// GET /resolve/:key — resolve a single config value (full value, not masked)
routes.get("/resolve/:key", (c) => {
  const key = c.req.param("key").toUpperCase();
  const cfg = resolveConfig();
  const map: Record<string, string | null> = {
    VERS_API_KEY: cfg.apiKey,
    VERS_INFRA_URL: cfg.infraUrl,
    VERS_AUTH_TOKEN: cfg.authToken,
    VERS_BASE_URL: cfg.baseUrl,
    VERS_AGENT_NAME: cfg.agentName,
    VERS_VM_ID: cfg.vmId,
    VERS_AGENT_ROLE: cfg.agentRole,
  };

  if (!(key in map)) {
    return c.json({ error: `Unknown config key: ${key}` }, 400);
  }

  return c.json({
    key,
    value: map[key],
    source: process.env[key] ? "env" : overrides[key] ? "store" : "file",
  });
});

const versConfig: ServiceModule = {
  name: "vers-config",
  description: "Centralized Vers platform config resolution",
  routes,

  init(_ctx: ServiceContext) {
    loadOverrides();
  },

  registerTools(pi: ExtensionAPI, client: FleetClient) {
    pi.registerTool({
      name: "vers_config_get",
      label: "Vers Config: View",
      description:
        "View the current Vers platform configuration. Shows resolved values from env, store, or file sources.",
      parameters: Type.Object({}),
      async execute() {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const result = await client.api<any>("GET", "/vers-config/");
          const lines = [
            `API Key:    ${result.apiKey || "(not set)"} [${result.sources.apiKey}]`,
            `Infra URL:  ${result.infraUrl || "(not set)"} [${result.sources.infraUrl}]`,
            `Auth Token: ${result.authToken || "(not set)"} [${result.sources.authToken}]`,
            `Base URL:   ${result.baseUrl || "(not set)"}`,
            `Agent Name: ${result.agentName || "(not set)"}`,
            `VM ID:      ${result.vmId || "(not set)"}`,
            `Agent Role: ${result.agentRole || "(not set)"}`,
          ];
          return client.ok(lines.join("\n"), { config: result });
        } catch (e: any) {
          return client.err(e.message);
        }
      },
    });

    pi.registerTool({
      name: "vers_config_set",
      label: "Vers Config: Set",
      description:
        "Set a Vers config value. Stored in reef (takes priority over file-based config, overridden by env vars).",
      parameters: Type.Object({
        key: Type.String({
          description:
            "Config key: VERS_API_KEY, VERS_INFRA_URL, VERS_AUTH_TOKEN, VERS_BASE_URL, VERS_AGENT_NAME, VERS_VM_ID, VERS_AGENT_ROLE",
        }),
        value: Type.String({ description: "Config value" }),
      }),
      async execute(_id, params) {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          await client.api("PUT", `/vers-config/${encodeURIComponent(params.key)}`, { value: params.value });
          return client.ok(`Set ${params.key} (source: store).`);
        } catch (e: any) {
          return client.err(e.message);
        }
      },
    });
  },

  routeDocs: {
    "GET /": {
      summary: "View resolved config (sensitive values masked)",
      response: "{ apiKey, infraUrl, authToken, baseUrl, agentName, vmId, agentRole, sources }",
    },
    "PUT /:key": {
      summary: "Set a config override",
      params: { key: { type: "string", required: true, description: "Config key (e.g., VERS_API_KEY)" } },
      body: { value: { type: "string", required: true, description: "Config value" } },
    },
    "DELETE /:key": {
      summary: "Remove a config override",
      params: { key: { type: "string", required: true, description: "Config key" } },
    },
    "GET /resolve/:key": {
      summary: "Resolve a single config value (full, unmasked)",
      params: { key: { type: "string", required: true, description: "Config key" } },
    },
  },

  dependencies: ["store"],
  capabilities: ["config.resolve", "config.manage"],
};

export default versConfig;
