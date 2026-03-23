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

    pi.registerTool({
      name: "reef_files",
      label: "Reef: List Files",
      description: "List files uploaded to the root reef server. Returns file names, URLs, and sizes.",
      parameters: Type.Object({}),
      async execute() {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const result = await client.api<{ files: any[]; count: number }>("GET", "/reef/files");
          if (result.count === 0) return client.ok("No files uploaded.", { files: [] });
          const lines = result.files.map((f: any) => `  ${f.name} (${f.size} bytes) — ${f.url}`);
          return client.ok(`${result.count} file(s):\n${lines.join("\n")}`, { files: result.files });
        } catch (error) {
          return client.err(error instanceof Error ? error.message : String(error));
        }
      },
    });

    pi.registerTool({
      name: "reef_download",
      label: "Reef: Download File",
      description:
        "Download a file from the root reef server to the local filesystem. Use this when a task references a file uploaded to the reef.",
      parameters: Type.Object({
        url: Type.String({ description: "The file URL path, e.g. /reef/files/1234-report.pdf" }),
        dest: Type.Optional(
          Type.String({ description: "Local destination path (defaults to filename in current directory)" }),
        ),
      }),
      async execute(_id, params) {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const base = client.getBaseUrl()!;
          const headers: Record<string, string> = {};
          const token = process.env.VERS_AUTH_TOKEN;
          if (token) headers.Authorization = `Bearer ${token}`;

          const res = await fetch(`${base}${params.url}`, { headers });
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            return client.err(`Download failed (${res.status}): ${text}`);
          }

          const buffer = Buffer.from(await res.arrayBuffer());
          const filename = params.url.split("/").pop() || "download";
          const destPath = params.dest || filename;

          const { writeFileSync: writeFs, mkdirSync: mkFs } = await import("node:fs");
          const { dirname } = await import("node:path");
          mkFs(dirname(destPath), { recursive: true });
          writeFs(destPath, buffer);

          return client.ok(`Downloaded ${buffer.length} bytes to ${destPath}`, { path: destPath, size: buffer.length });
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
