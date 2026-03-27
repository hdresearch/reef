import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../src/core/server.js";
import { ServiceEventBus } from "../src/core/events.js";
import signals from "../services/signals/index.js";
import vmTree from "../services/vm-tree/index.js";
import { SwarmRuntime } from "../services/swarm/runtime.js";
import { spawnResourceVm } from "../services/swarm/tools.js";
import { VMTreeStore } from "../services/vm-tree/store.js";

const TMP_DIR = join(import.meta.dir, ".tmp-swarm-runtime");

beforeEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  delete process.env.VERS_VM_ID;
  delete process.env.VERS_AGENT_NAME;
  delete process.env.VERS_GOLDEN_COMMIT_ID;
});

describe("vm-tree root status", () => {
  test("marks the root infra VM as running during init", async () => {
    process.env.VERS_VM_ID = `vm-root-${Date.now()}-status`;
    process.env.VERS_AGENT_NAME = "root-reef";

    const server = await createServer({
      modules: [vmTree],
    });

    const vmTreeStore = server.ctx.getStore<{ vmTreeStore: VMTreeStore }>("vm-tree")?.vmTreeStore;
    const root = vmTreeStore?.getVM(process.env.VERS_VM_ID!);
    expect(root?.category).toBe("infra_vm");
    expect(root?.status).toBe("running");
    expect(root?.address).toBe(`${process.env.VERS_VM_ID}.vm.vers.sh`);
  });

  test("createVM honors explicit running status on insert", () => {
    const dbPath = join(TMP_DIR, "explicit-status.sqlite");
    const store = new VMTreeStore(dbPath);

    const vm = store.createVM({
      vmId: "vm-resource-1",
      name: "postgres",
      category: "resource_vm",
      parentId: "vm-root-1",
      status: "running",
      lastHeartbeat: 123,
    });

    expect(vm.status).toBe("running");
    expect(vm.lastHeartbeat).toBe(123);

    store.close();
  });

  test("createVM persists discovery hints and service endpoints", () => {
    const dbPath = join(TMP_DIR, "discovery-fields.sqlite");
    const store = new VMTreeStore(dbPath);

    const vm = store.createVM({
      vmId: "vm-agent-1",
      name: "agent-1",
      category: "agent_vm",
      parentId: "vm-root-1",
      spawnedBy: "lineage-lt",
      serviceEndpoints: [{ name: "reef", port: 3000, protocol: "https" }],
      discovery: {
        registeredVia: "swarm:spawn",
        agentLabel: "agent-1",
        parentSession: true,
        reconnectKind: "agent_vm",
        commitId: "commit-123",
      },
    });

    expect(vm.spawnedBy).toBe("lineage-lt");
    expect(vm.serviceEndpoints).toEqual([{ name: "reef", port: 3000, protocol: "https" }]);
    expect(vm.discovery).toMatchObject({
      registeredVia: "swarm:spawn",
      agentLabel: "agent-1",
      parentSession: true,
      reconnectKind: "agent_vm",
      commitId: "commit-123",
    });

    store.close();
  });
});

describe("swarm orphan cleanup", () => {
  test("does not delete the root infra VM even if it is stale and creating", async () => {
    const dbPath = join(TMP_DIR, "fleet.sqlite");
    const store = new VMTreeStore(dbPath);
    const deleted: string[] = [];

    store.createVM({
      vmId: "vm-root",
      name: "root-reef",
      category: "infra_vm",
    });
    store.getDb().run("UPDATE vm_tree SET created_at = ?, updated_at = ? WHERE id = ?", [Date.now() - 10 * 60 * 1000, Date.now(), "vm-root"]);

    store.createVM({
      vmId: "vm-child",
      name: "worker-1",
      category: "swarm_vm",
      parentId: "vm-root",
    });
    store.getDb().run("UPDATE vm_tree SET created_at = ?, updated_at = ? WHERE id = ?", [Date.now() - 10 * 60 * 1000, Date.now(), "vm-child"]);

    const runtime = new SwarmRuntime({
      events: new ServiceEventBus(),
      vmTreeStore: store,
      deleteVm: async (vmId: string) => {
        deleted.push(vmId);
      },
    });

    const result = await runtime.cleanupOrphans();

    expect(deleted).toEqual(["vm-child"]);
    expect(result.cleaned.length).toBe(1);
    expect(store.getVM("vm-root")?.status).toBe("creating");
    expect(store.getVM("vm-child")?.status).toBe("error");

    await runtime.shutdown();
    store.close();
  });
});

describe("resource VM spawn", () => {
  test("uses the direct Vers client path and registers the resource VM as running", async () => {
    process.env.VERS_VM_ID = "vm-root-1";
    process.env.VERS_GOLDEN_COMMIT_ID = "golden-123";

    const apiCalls: Array<{ method: string; path: string; body?: unknown }> = [];
    const result = await spawnResourceVm(
      {
        api: async (method: string, path: string, body?: unknown) => {
          apiCalls.push({ method, path, body });
          return { ok: true } as any;
        },
        getBaseUrl: () => "https://reef.example",
        agentName: "root-reef",
        vmId: "vm-root-1",
        agentRole: "worker",
        agentCategory: "infra_vm",
        isChildAgent: false,
        ok: (text: string, details?: Record<string, unknown>) => ({
          content: [{ type: "text" as const, text }],
          details,
        }),
        err: (text: string) => ({
          content: [{ type: "text" as const, text }],
          isError: true,
        }),
        noUrl: () => ({
          content: [{ type: "text" as const, text: "no url" }],
          isError: true,
        }),
      },
      { name: "idol-demo" },
      {
        createVm: async (commitId: string) => {
          expect(commitId).toBe("golden-123");
          return { vmId: "vm-resource-1" };
        },
        deleteVm: async () => {
          throw new Error("deleteVm should not be called on success");
        },
      },
    );

    expect(result.isError).toBeUndefined();
    expect(apiCalls).toEqual([
      {
        method: "POST",
        path: "/vm-tree/vms",
        body: {
          vmId: "vm-resource-1",
          name: "idol-demo",
          category: "resource_vm",
          parentId: "vm-root-1",
          status: "running",
          address: "vm-resource-1.vm.vers.sh",
          lastHeartbeat: expect.any(Number),
          spawnedBy: "root-reef",
          discovery: {
            registeredVia: "resource:spawn",
            agentLabel: "idol-demo",
            reconnectKind: "resource_vm",
          },
        },
      },
    ]);
    expect(result.details).toMatchObject({
      vmId: "vm-resource-1",
      name: "idol-demo",
      address: "vm-resource-1.vm.vers.sh",
    });
  });
});

describe("swarm completion surfacing", () => {
  test("materializes swarm completion into vm-tree state and a parent-visible done signal", async () => {
    const startedAt = Date.now();
    const rootAgentName = `root-reef-${startedAt}`;
    const workerName = `staging-worker-${startedAt}`;
    process.env.VERS_VM_ID = `vm-root-${startedAt}-signals`;
    process.env.VERS_AGENT_NAME = rootAgentName;
    const workerVmId = `vm-worker-${startedAt}-signals`;

    const server = await createServer({
      modules: [vmTree, signals],
    });

    const store = server.ctx.getStore<{ vmTreeStore: VMTreeStore }>("vm-tree")?.vmTreeStore;
    expect(store).toBeDefined();

    store!.createVM({
      vmId: workerVmId,
      name: workerName,
      category: "swarm_vm",
      parentId: process.env.VERS_VM_ID!,
      status: "running",
    });

    await server.events.emit("swarm:agent_completed", {
      vmId: workerVmId,
      label: workerName,
      task: "build staging SQL",
      outputLength: 321,
      elapsed: 17,
    });

    const worker = store!.getVM(workerVmId);
    expect(worker?.status).toBe("stopped");
    expect(worker?.rpcStatus).toBe("disconnected");

    const signalsToRoot = store!.querySignals({
      toAgent: rootAgentName,
      fromAgent: workerName,
      direction: "up",
      signalType: "done",
    });
    expect(signalsToRoot).toHaveLength(1);
    expect(signalsToRoot[0]?.payload).toMatchObject({
      source: "swarm_runtime",
      task: "build staging SQL",
      outputLength: 321,
      elapsed: 17,
    });

    const events = store!.queryAgentEvents({ agentId: workerVmId, event: "task_completed" });
    expect(events[0]?.metadata).toMatchObject({
      source: "swarm",
      task: "build staging SQL",
      outputLength: 321,
      elapsed: 17,
    });
  });
});
