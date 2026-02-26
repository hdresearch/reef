import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { FleetClient } from "../src/core/types.js";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

export function registerTools(pi: ExtensionAPI, client: FleetClient) {
  pi.registerTool({
    name: "usage_summary",
    label: "Usage: Summary",
    description: "Get cost & token usage summary across the agent fleet.",
    parameters: Type.Object({
      range: Type.Optional(Type.String({ description: 'Time range, e.g. "7d", "30d", "24h" (default: "7d")' })),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const qs = new URLSearchParams();
        if (params.range) qs.set("range", params.range);
        const query = qs.toString();
        const result = await client.api("GET", `/usage${query ? `?${query}` : ""}`);
        return client.ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "usage_sessions",
    label: "Usage: Sessions",
    description: "List session usage records — tokens, cost, turns, tool calls per session.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Filter by agent name" })),
      range: Type.Optional(Type.String({ description: 'Time range, e.g. "7d", "30d", "24h"' })),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const qs = new URLSearchParams();
        if (params.agent) qs.set("agent", params.agent);
        if (params.range) qs.set("range", params.range);
        const query = qs.toString();
        const result = await client.api("GET", `/usage/sessions${query ? `?${query}` : ""}`);
        return client.ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "usage_vms",
    label: "Usage: VMs",
    description: "List VM lifecycle records — creation, commit, destruction events.",
    parameters: Type.Object({
      role: Type.Optional(StringEnum(["orchestrator", "lieutenant", "worker", "infra", "golden"] as const)),
      agent: Type.Optional(Type.String({ description: "Filter by agent name" })),
      range: Type.Optional(Type.String({ description: 'Time range, e.g. "7d", "30d", "24h"' })),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const qs = new URLSearchParams();
        if (params.role) qs.set("role", params.role);
        if (params.agent) qs.set("agent", params.agent);
        if (params.range) qs.set("range", params.range);
        const query = qs.toString();
        const result = await client.api("GET", `/usage/vms${query ? `?${query}` : ""}`);
        return client.ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });
}
