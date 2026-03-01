/**
 * Feed tools — publish events, list events, get stats.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { FleetClient } from "../src/core/types.js";

export function registerTools(pi: ExtensionAPI, client: FleetClient) {
  pi.registerTool({
    name: "feed_publish",
    label: "Feed: Publish Event",
    description: "Publish an event to the activity feed. Used for coordination, progress reporting, and audit trails.",
    parameters: Type.Object({
      type: StringEnum(
        [
          "task_started",
          "task_completed",
          "task_failed",
          "blocker_found",
          "question",
          "finding",
          "skill_proposed",
          "file_changed",
          "cost_update",
          "agent_started",
          "agent_stopped",
          "custom",
        ] as const,
        { description: "Event type" },
      ),
      summary: Type.String({ description: "Short human-readable summary" }),
      detail: Type.Optional(Type.String({ description: "Longer detail or structured data" })),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const event = await client.api("POST", "/feed/events", {
          ...params,
          agent: client.agentName,
        });
        return client.ok(JSON.stringify(event, null, 2), { event });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "feed_list",
    label: "Feed: List Events",
    description: "List recent activity feed events. Optionally filter by agent, type, or limit.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Filter by agent name" })),
      type: Type.Optional(Type.String({ description: "Filter by event type" })),
      limit: Type.Optional(Type.Number({ description: "Max events to return (default 50)" })),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const qs = new URLSearchParams();
        if (params.agent) qs.set("agent", params.agent);
        if (params.type) qs.set("type", params.type);
        if (params.limit) qs.set("limit", String(params.limit));
        const query = qs.toString();
        const result = await client.api("GET", `/feed/events${query ? `?${query}` : ""}`);
        return client.ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "feed_stats",
    label: "Feed: Stats",
    description: "Get summary statistics of the activity feed.",
    parameters: Type.Object({}),
    async execute() {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const stats = await client.api("GET", "/feed/stats");
        return client.ok(JSON.stringify(stats, null, 2), { stats });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });
}
