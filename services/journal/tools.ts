import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { FleetClient } from "../../src/core/types.js";

export function registerTools(pi: ExtensionAPI, client: FleetClient) {
  pi.registerTool({
    name: "journal_entry",
    label: "Journal: Write Entry",
    description:
      "Write a personal journal entry — thoughts, vibes, product intuitions, feelings. NOT for operational tasks (use log_append for that).",
    parameters: Type.Object({
      text: Type.String({ description: "Journal entry text" }),
      mood: Type.Optional(Type.String({ description: "Optional mood/vibe tag" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags" })),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const body: Record<string, unknown> = {
          text: params.text,
          author: client.agentName,
        };
        if (params.mood) body.mood = params.mood;
        if (params.tags) body.tags = params.tags;
        const entry = await client.api("POST", "/journal", body);
        return client.ok(JSON.stringify(entry, null, 2), { entry });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });
}
