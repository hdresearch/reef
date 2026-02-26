/**
 * Registry behaviors — auto-registration, heartbeat, lifecycle event handling.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { FleetClient } from "../src/core/types.js";

export function registerBehaviors(pi: ExtensionAPI, client: FleetClient) {
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Auto-register this VM on agent start
  pi.on("agent_start", async () => {
    if (!client.getBaseUrl() || !client.vmId) return;

    try {
      await client.api("POST", "/registry/vms", {
        id: client.vmId,
        name: client.agentName,
        role: client.agentRole,
        address: `${client.vmId}.vm.vers.sh`,
        registeredBy: client.agentName,
        metadata: { pid: process.pid, startedAt: new Date().toISOString() },
      });
    } catch {
      // Might already exist — try update instead
      try {
        await client.api("PATCH", `/registry/vms/${client.vmId}`, {
          name: client.agentName,
          status: "running",
        });
      } catch { /* best-effort */ }
    }
  });

  // Mark stopped on agent end
  pi.on("agent_end", async () => {
    if (!client.getBaseUrl() || !client.vmId) return;
    try {
      await client.api("PATCH", `/registry/vms/${client.vmId}`, { status: "stopped" });
    } catch { /* best-effort */ }
  });

  // Start heartbeat timer on session start
  pi.on("session_start", async () => {
    if (!client.getBaseUrl() || !client.vmId) return;

    heartbeatTimer = setInterval(async () => {
      try {
        await client.api("POST", `/registry/vms/${client.vmId}/heartbeat`);
      } catch { /* best-effort */ }
    }, 60_000);
  });

  // Stop heartbeat on shutdown
  pi.on("session_shutdown", async () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  });

  // Handle swarm/lieutenant lifecycle events from other extensions
  pi.events.on("vers:agent_spawned", async (data: {
    vmId: string; label: string; role: string; address: string; commitId?: string;
  }) => {
    if (!client.getBaseUrl()) return;
    try {
      await client.api("POST", "/registry/vms", {
        id: data.vmId,
        name: data.label,
        role: data.role || "worker",
        address: data.address,
        registeredBy: "fleet-services",
        metadata: {
          agentId: data.label,
          commitId: data.commitId,
          registeredVia: "vers:agent_spawned",
          createdAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      console.error(`[registry] Registration failed for ${data.label}: ${err instanceof Error ? err.message : err}`);
    }
  });

  pi.events.on("vers:agent_destroyed", async (data: { vmId: string; label: string }) => {
    if (!client.getBaseUrl()) return;
    try {
      await client.api("DELETE", `/registry/vms/${encodeURIComponent(data.vmId)}`);
    } catch (err) {
      console.error(`[registry] Delete failed for ${data.label}: ${err instanceof Error ? err.message : err}`);
    }
  });

  pi.events.on("vers:lt_created", async (data: {
    vmId: string; name: string; role: string; address: string;
    ltRole?: string; commitId?: string; createdAt?: string;
  }) => {
    if (!client.getBaseUrl()) return;
    try {
      await client.api("POST", "/registry/vms", {
        id: data.vmId,
        name: data.name,
        role: data.role || "lieutenant",
        address: data.address,
        registeredBy: "fleet-services",
        metadata: {
          agentId: data.name,
          role: data.ltRole,
          commitId: data.commitId,
          createdAt: data.createdAt,
          registeredVia: "vers:lt_created",
        },
      });
    } catch (err) {
      console.error(`[registry] LT registration failed for ${data.name}: ${err instanceof Error ? err.message : err}`);
    }
  });

  pi.events.on("vers:lt_destroyed", async (data: { vmId: string; name: string }) => {
    if (!client.getBaseUrl()) return;
    try {
      await client.api("DELETE", `/registry/vms/${encodeURIComponent(data.vmId)}`);
    } catch (err) {
      console.error(`[registry] LT delete failed for ${data.name}: ${err instanceof Error ? err.message : err}`);
    }
  });
}
