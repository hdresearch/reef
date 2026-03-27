import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../src/core/server.js";
import { ServiceEventBus } from "../src/core/events.js";
import vmTree from "../services/vm-tree/index.js";
import { SwarmRuntime } from "../services/swarm/runtime.js";
import { VMTreeStore } from "../services/vm-tree/store.js";

const TMP_DIR = join(import.meta.dir, ".tmp-swarm-runtime");

beforeEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  delete process.env.VERS_VM_ID;
  delete process.env.VERS_AGENT_NAME;
});

describe("vm-tree root status", () => {
  test("marks the root infra VM as running during init", async () => {
    process.env.VERS_VM_ID = "vm-root-1";
    process.env.VERS_AGENT_NAME = "root-reef";

    const server = await createServer({
      modules: [vmTree],
    });

    const vmTreeStore = server.ctx.getStore<{ vmTreeStore: VMTreeStore }>("vm-tree")?.vmTreeStore;
    const root = vmTreeStore?.getVM("vm-root-1");
    expect(root?.category).toBe("infra_vm");
    expect(root?.status).toBe("running");
    expect(root?.address).toBe("vm-root-1.vm.vers.sh");
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
