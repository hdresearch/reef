/**
 * Registry tools — VM registration, discovery, heartbeat.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { FleetClient } from "../src/core/types.js";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

const ROLE_ENUM = StringEnum(
  ["infra", "lieutenant", "worker", "golden", "custom"] as const,
  { description: "VM role in the swarm" },
);

export function registerTools(pi: ExtensionAPI, client: FleetClient) {
  pi.registerTool({
    name: "registry_list",
    label: "Registry: List VMs",
    description: "List VMs in the coordination registry. Optionally filter by role or status.",
    parameters: Type.Object({
      role: Type.Optional(ROLE_ENUM),
      status: Type.Optional(
        StringEnum(["running", "paused", "stopped"] as const, { description: "Filter by status" }),
      ),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const qs = new URLSearchParams();
        if (params.role) qs.set("role", params.role);
        if (params.status) qs.set("status", params.status);
        const query = qs.toString();
        const result = await client.api("GET", `/registry/vms${query ? `?${query}` : ""}`);
        return client.ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "registry_register",
    label: "Registry: Register VM",
    description: "Register a VM so other agents can discover it.",
    parameters: Type.Object({
      id: Type.String({ description: "VM ID (from Vers)" }),
      name: Type.String({ description: "Human-readable name" }),
      role: ROLE_ENUM,
      address: Type.String({ description: "Network address or endpoint" }),
      services: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String(),
            port: Type.Number(),
            protocol: Type.Optional(Type.String()),
          }),
          { description: "Services exposed by this VM" },
        ),
      ),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const vm = await client.api("POST", "/registry/vms", {
          ...params,
          registeredBy: client.agentName,
        });
        return client.ok(JSON.stringify(vm, null, 2), { vm });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "registry_discover",
    label: "Registry: Discover VMs",
    description: "Discover VMs by role — find workers, lieutenants, or other agents.",
    parameters: Type.Object({
      role: ROLE_ENUM,
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api(
          "GET",
          `/registry/discover/${encodeURIComponent(params.role)}`,
        );
        return client.ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "registry_heartbeat",
    label: "Registry: Heartbeat",
    description: "Send a heartbeat to keep a VM's registration active.",
    parameters: Type.Object({
      id: Type.String({ description: "VM ID to heartbeat" }),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api(
          "POST",
          `/registry/vms/${encodeURIComponent(params.id)}/heartbeat`,
        );
        return client.ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });
}
