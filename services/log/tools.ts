import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { FleetClient } from "../../src/core/types.js";

export function registerTools(pi: ExtensionAPI, client: FleetClient) {
  pi.registerTool({
    name: "log_append",
    label: "Log: Append Entry",
    description: "Append a work log entry — timestamped, append-only. Like Carmack's .plan file.",
    parameters: Type.Object({
      text: Type.String({ description: "Log entry text" }),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const entry = await client.api("POST", "/log", {
          text: params.text,
          agent: client.agentName,
        });
        return client.ok(JSON.stringify(entry, null, 2), { entry });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "log_query",
    label: "Log: Query Entries",
    description:
      "Query the work log. Returns timestamped entries filtered by time range. Use raw=true for plain text output.",
    parameters: Type.Object({
      since: Type.Optional(Type.String({ description: "Start time (ISO timestamp)" })),
      until: Type.Optional(Type.String({ description: "End time (ISO timestamp)" })),
      last: Type.Optional(Type.String({ description: 'Duration shorthand, e.g. "24h", "7d"' })),
      raw: Type.Optional(Type.Boolean({ description: "Return plain text instead of JSON" })),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const qs = new URLSearchParams();
        if (params.since) qs.set("since", params.since);
        if (params.until) qs.set("until", params.until);
        if (params.last) qs.set("last", params.last);
        const query = qs.toString();
        const endpoint = params.raw ? "/log/raw" : "/log";
        const result = await client.api("GET", `${endpoint}${query ? `?${query}` : ""}`);
        if (params.raw && typeof result === "string") {
          return client.ok(result || "(no entries)");
        }
        return client.ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });
}
