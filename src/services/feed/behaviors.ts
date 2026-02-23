/**
 * Feed behaviors — auto-publish agent lifecycle events.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { FleetClient } from "../../core/types.js";

export function registerBehaviors(pi: ExtensionAPI, client: FleetClient) {
  pi.on("agent_start", async () => {
    if (!client.getBaseUrl()) return;
    try {
      await client.api("POST", "/feed/events", {
        agent: client.agentName,
        type: "agent_started",
        summary: `Agent ${client.agentName} started processing`,
      });
    } catch {
      // best-effort
    }
  });

  // agent_end publish is handled by the usage service (it has cost data to include)
}
