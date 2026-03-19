import { Type } from "@sinclair/typebox";
import type { FleetClient, ServiceModule } from "../../src/core/types.js";

interface RegistryVm {
  id: string;
  name: string;
  role: string;
  status: string;
  address: string;
  parentVmId: string | null;
  reefConfig?: {
    services?: string[];
    capabilities?: string[];
  };
  metadata?: Record<string, unknown>;
}

interface TreeVm {
  vmId: string;
  name: string;
  parentVmId: string | null;
  category: string;
  reefConfig: {
    services: string[];
    capabilities: string[];
  };
}

function requireVmId(client: FleetClient): string {
  if (!client.vmId) {
    throw new Error("VERS_VM_ID is not set for this agent");
  }
  return client.vmId;
}

async function fetchSelf(client: FleetClient) {
  const vmId = requireVmId(client);
  const [registry, tree] = await Promise.all([
    client.api<RegistryVm>("GET", `/registry/vms/${encodeURIComponent(vmId)}`),
    client.api<TreeVm>("GET", `/vm-tree/vms/${encodeURIComponent(vmId)}`),
  ]);
  return { vmId, registry, tree };
}

async function fetchRegistryMap(client: FleetClient): Promise<Map<string, RegistryVm>> {
  const result = await client.api<{ vms: RegistryVm[] }>("GET", "/registry/vms");
  return new Map(result.vms.map((vm) => [vm.id, vm]));
}

function summarizeWorkerCapacity(nodes: TreeVm[], registryById: Map<string, RegistryVm>) {
  const workers = nodes.filter((node) => node.category === "agent_vm" || node.category === "swarm_vm");
  const byStatus = { running: 0, paused: 0, stopped: 0, unknown: 0 };

  for (const worker of workers) {
    const status = registryById.get(worker.vmId)?.status;
    if (status === "running" || status === "paused" || status === "stopped") {
      byStatus[status] += 1;
    } else {
      byStatus.unknown += 1;
    }
  }

  return {
    totalWorkers: workers.length,
    agentVms: workers.filter((node) => node.category === "agent_vm").length,
    swarmVms: workers.filter((node) => node.category === "swarm_vm").length,
    byStatus,
  };
}

const agentContext: ServiceModule = {
  name: "agent-context",
  description: "Child-safe fleet context tools backed by the root reef APIs",

  registerTools(pi, client) {
    pi.registerTool({
      name: "reef_self",
      label: "Reef: Self",
      description:
        "Show this agent VM's metadata, lineage category, and loaded services/capabilities from the root reef.",
      parameters: Type.Object({}),
      async execute() {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const self = await fetchSelf(client);
          return client.ok(JSON.stringify(self, null, 2), { self });
        } catch (error) {
          return client.err(error instanceof Error ? error.message : String(error));
        }
      },
    });

    pi.registerTool({
      name: "reef_parent",
      label: "Reef: Parent",
      description: "Show the direct parent VM for this agent, if it has one.",
      parameters: Type.Object({}),
      async execute() {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const self = await fetchSelf(client);
          if (!self.tree.parentVmId) {
            return client.ok("This VM has no parent in the lineage tree.", { self });
          }

          const [registryParent, treeParent] = await Promise.all([
            client.api<RegistryVm>("GET", `/registry/vms/${encodeURIComponent(self.tree.parentVmId)}`),
            client.api<TreeVm>("GET", `/vm-tree/vms/${encodeURIComponent(self.tree.parentVmId)}`),
          ]);

          const parent = {
            vmId: self.tree.parentVmId,
            registry: registryParent,
            tree: treeParent,
          };
          return client.ok(JSON.stringify(parent, null, 2), { parent });
        } catch (error) {
          return client.err(error instanceof Error ? error.message : String(error));
        }
      },
    });

    if (client.agentRole !== "lieutenant") return;

    pi.registerTool({
      name: "reef_lt_children",
      label: "Reef LT: Children",
      description: "List this lieutenant's direct child VMs from the root reef lineage tree.",
      parameters: Type.Object({}),
      async execute() {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const vmId = requireVmId(client);
          const result = await client.api<{ children: TreeVm[] }>(
            "GET",
            `/vm-tree/vms/${encodeURIComponent(vmId)}/children`,
          );
          return client.ok(JSON.stringify(result, null, 2), { result });
        } catch (error) {
          return client.err(error instanceof Error ? error.message : String(error));
        }
      },
    });

    pi.registerTool({
      name: "reef_lt_subtree",
      label: "Reef LT: Subtree",
      description: "Show this lieutenant's full descendant subtree from the root reef lineage tree.",
      parameters: Type.Object({}),
      async execute() {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const vmId = requireVmId(client);
          const result = await client.api<{ tree: unknown[]; count: number }>(
            "GET",
            `/vm-tree/tree?root=${encodeURIComponent(vmId)}`,
          );
          return client.ok(JSON.stringify(result, null, 2), { result });
        } catch (error) {
          return client.err(error instanceof Error ? error.message : String(error));
        }
      },
    });

    pi.registerTool({
      name: "reef_lt_worker_capacity",
      label: "Reef LT: Worker Capacity",
      description:
        "Summarize this lieutenant's available worker capacity from the root reef's lineage tree and registry.",
      parameters: Type.Object({}),
      async execute() {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const vmId = requireVmId(client);
          const [descendants, registryById] = await Promise.all([
            client.api<{ descendants: TreeVm[] }>("GET", `/vm-tree/vms/${encodeURIComponent(vmId)}/descendants`),
            fetchRegistryMap(client),
          ]);
          const summary = summarizeWorkerCapacity(descendants.descendants, registryById);
          return client.ok(JSON.stringify(summary, null, 2), { summary });
        } catch (error) {
          return client.err(error instanceof Error ? error.message : String(error));
        }
      },
    });
  },
};

export default agentContext;
