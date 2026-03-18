/**
 * Registry tools — VM registration, discovery, heartbeat, lineage.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { FleetClient } from "../../src/core/types.js";

const ROLE_VALUES = ["infra", "lieutenant", "worker", "golden", "custom"] as const;

export function registerTools(pi: ExtensionAPI, client: FleetClient) {
  pi.registerTool({
    name: "registry_list",
    label: "Registry: List VMs",
    description: "List VMs in the coordination registry. Optionally filter by role, status, or parent.",
    parameters: Type.Object({
      role: Type.Optional(Type.String({ description: "Filter by role: infra | lieutenant | worker | golden | custom" })),
      status: Type.Optional(Type.String({ description: "Filter by status: running | paused | stopped" })),
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
    description: "Register a VM so other agents can discover it. Supports lineage tracking via parentVmId.",
    parameters: Type.Object({
      id: Type.String({ description: "VM ID" }),
      name: Type.String({ description: "Human-readable name" }),
      role: Type.String({ description: "VM role: infra | lieutenant | worker | golden | custom" }),
      address: Type.String({ description: "Network address or endpoint" }),
      parentVmId: Type.Optional(Type.String({ description: "Parent VM ID for lineage tracking" })),
      reefConfig: Type.Optional(
        Type.Object(
          {
            organs: Type.Array(Type.String(), { description: "Service modules loaded" }),
            capabilities: Type.Array(Type.String(), { description: "Extension capabilities" }),
          },
          { description: "VM DNA — modules and capabilities" },
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
    description: "Discover running VMs by role — find workers, lieutenants, or other agents.",
    parameters: Type.Object({
      role: Type.String({ description: "VM role to discover" }),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api("GET", `/registry/discover/${encodeURIComponent(params.role)}`);
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
        const result = await client.api("POST", `/registry/vms/${encodeURIComponent(params.id)}/heartbeat`);
        return client.ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "registry_lineage",
    label: "Registry: VM Lineage",
    description: "View a VM's lineage — ancestors (path to root) or subtree (all descendants).",
    parameters: Type.Object({
      id: Type.String({ description: "VM ID" }),
      direction: Type.Optional(
        Type.Union([Type.Literal("ancestors"), Type.Literal("subtree"), Type.Literal("children")], {
          description: "Direction: ancestors (default), subtree, or children",
        }),
      ),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const dir = params.direction || "ancestors";
        const result = await client.api("GET", `/registry/vms/${encodeURIComponent(params.id)}/${dir}`);
        return client.ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });
}
