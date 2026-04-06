import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "../src/core/server.js";
import vmTree from "../services/vm-tree/index.js";
import { VMTreeStore } from "../services/vm-tree/store.js";

const AUTH_TOKEN = "vm-tree-history-token";

function authHeaders(extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    ...extra,
  };
}

async function json(
  app: { fetch: (req: Request) => Promise<Response> },
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
  return { status: res.status, data: await res.json() };
}

beforeEach(() => {
  process.env.VERS_AUTH_TOKEN = AUTH_TOKEN;
  process.env.VERS_VM_ID = `vm-root-history-${Date.now()}`;
  process.env.VERS_AGENT_NAME = "root-reef";
});

afterEach(() => {
  delete process.env.VERS_AUTH_TOKEN;
  delete process.env.VERS_VM_ID;
  delete process.env.VERS_AGENT_NAME;
});

describe("vm-tree active vs history views", () => {
  test("tree, children, and descendants are active-only by default and include history explicitly", async () => {
    const server = await createServer({ modules: [vmTree] });
    const store = server.ctx.getStore<{ vmTreeStore: VMTreeStore }>("vm-tree")?.vmTreeStore;
    expect(store).toBeDefined();

    const suffix = `${Date.now()}-history-tree`;
    const rootVmId = `root-${suffix}`;
    const runningChildVmId = `running-${suffix}`;
    const errorChildVmId = `error-${suffix}`;
    const stoppedChildVmId = `stopped-${suffix}`;
    const destroyedChildVmId = `destroyed-${suffix}`;
    const stoppedGrandchildVmId = `stopped-grandchild-${suffix}`;

    store!.upsertVM({ vmId: rootVmId, name: `root-${suffix}`, category: "infra_vm", status: "running" });
    store!.upsertVM({
      vmId: runningChildVmId,
      name: `running-${suffix}`,
      category: "agent_vm",
      status: "running",
      parentId: rootVmId,
    });
    store!.upsertVM({
      vmId: errorChildVmId,
      name: `error-${suffix}`,
      category: "agent_vm",
      status: "error",
      parentId: rootVmId,
    });
    store!.upsertVM({
      vmId: stoppedChildVmId,
      name: `stopped-${suffix}`,
      category: "agent_vm",
      status: "stopped",
      parentId: rootVmId,
    });
    store!.upsertVM({
      vmId: destroyedChildVmId,
      name: `destroyed-${suffix}`,
      category: "resource_vm",
      status: "destroyed",
      parentId: rootVmId,
    });
    store!.upsertVM({
      vmId: stoppedGrandchildVmId,
      name: `stopped-grandchild-${suffix}`,
      category: "swarm_vm",
      status: "stopped",
      parentId: stoppedChildVmId,
    });

    const childrenDefault = await json(server.app, `/vm-tree/vms/${rootVmId}/children`, {
      headers: authHeaders(),
    });
    expect(childrenDefault.status).toBe(200);
    expect(childrenDefault.data.children.map((vm: any) => vm.vmId).sort()).toEqual(
      [errorChildVmId, runningChildVmId].sort(),
    );

    const childrenWithHistory = await json(server.app, `/vm-tree/vms/${rootVmId}/children?includeHistory=true`, {
      headers: authHeaders(),
    });
    expect(childrenWithHistory.status).toBe(200);
    expect(childrenWithHistory.data.children.map((vm: any) => vm.vmId).sort()).toEqual(
      [runningChildVmId, errorChildVmId, stoppedChildVmId, destroyedChildVmId].sort(),
    );

    const descendantsDefault = await json(server.app, `/vm-tree/vms/${rootVmId}/descendants`, {
      headers: authHeaders(),
    });
    expect(descendantsDefault.status).toBe(200);
    expect(descendantsDefault.data.descendants.map((vm: any) => vm.vmId).sort()).toEqual(
      [errorChildVmId, runningChildVmId].sort(),
    );

    const descendantsWithHistory = await json(
      server.app,
      `/vm-tree/vms/${rootVmId}/descendants?includeHistory=true`,
      {
        headers: authHeaders(),
      },
    );
    expect(descendantsWithHistory.status).toBe(200);
    expect(descendantsWithHistory.data.descendants.map((vm: any) => vm.vmId).sort()).toEqual(
      [runningChildVmId, errorChildVmId, stoppedChildVmId, destroyedChildVmId, stoppedGrandchildVmId].sort(),
    );

    const treeDefault = await json(server.app, `/vm-tree/tree?root=${encodeURIComponent(rootVmId)}`, {
      headers: authHeaders(),
    });
    expect(treeDefault.status).toBe(200);
    expect(treeDefault.data.tree).toHaveLength(1);
    expect(treeDefault.data.tree[0].children.map((child: any) => child.vm.vmId).sort()).toEqual(
      [errorChildVmId, runningChildVmId].sort(),
    );
    expect(treeDefault.data.mode).toBe("active");
    expect(treeDefault.data.historyIncluded).toBe(false);
    expect(treeDefault.data.notes[0]).toContain("Active view");

    const treeWithHistory = await json(
      server.app,
      `/vm-tree/tree?root=${encodeURIComponent(rootVmId)}&includeHistory=true`,
      {
        headers: authHeaders(),
      },
    );
    expect(treeWithHistory.status).toBe(200);
    expect(treeWithHistory.data.tree).toHaveLength(1);
    const children = treeWithHistory.data.tree[0].children;
    expect(children.map((child: any) => child.vm.vmId).sort()).toEqual(
      [runningChildVmId, errorChildVmId, stoppedChildVmId, destroyedChildVmId].sort(),
    );
    const stoppedNode = children.find((child: any) => child.vm.vmId === stoppedChildVmId);
    expect(stoppedNode.children.map((child: any) => child.vm.vmId)).toEqual([stoppedGrandchildVmId]);
    expect(treeDefault.data.visibleCount).toBe(3);
    expect(treeDefault.data.totalRegistered).toBeGreaterThanOrEqual(treeDefault.data.visibleCount);
    expect(treeWithHistory.data.mode).toBe("history");
    expect(treeWithHistory.data.historyIncluded).toBe(true);
    expect(treeWithHistory.data.notes[0]).toContain("History view");
  });

  test("fleet status is active-only by default and exposes history explicitly", async () => {
    const server = await createServer({ modules: [vmTree] });
    const store = server.ctx.getStore<{ vmTreeStore: VMTreeStore }>("vm-tree")?.vmTreeStore;
    expect(store).toBeDefined();

    const suffix = `${Date.now()}-history-status`;
    store!.upsertVM({ vmId: `root-${suffix}`, name: `root-${suffix}`, category: "infra_vm", status: "running" });
    store!.upsertVM({
      vmId: `active-${suffix}`,
      name: `active-${suffix}`,
      category: "agent_vm",
      status: "running",
      parentId: `root-${suffix}`,
    });
    store!.upsertVM({
      vmId: `stopped-${suffix}`,
      name: `stopped-${suffix}`,
      category: "agent_vm",
      status: "stopped",
      parentId: `root-${suffix}`,
    });
    store!.upsertVM({
      vmId: `destroyed-${suffix}`,
      name: `destroyed-${suffix}`,
      category: "resource_vm",
      status: "destroyed",
      parentId: `root-${suffix}`,
    });

    const activeStatus = await json(server.app, "/vm-tree/fleet/status", {
      headers: authHeaders(),
    });
    expect(activeStatus.status).toBe(200);
    expect(activeStatus.data.mode).toBe("active");
    expect(activeStatus.data.historyIncluded).toBe(false);
    expect(activeStatus.data.byStatus.stopped).toBeUndefined();
    expect(activeStatus.data.byStatus.destroyed).toBeUndefined();
    expect(activeStatus.data.byCategory.agent_vm).toBeGreaterThanOrEqual(1);

    const historyStatus = await json(server.app, "/vm-tree/fleet/status?includeHistory=true", {
      headers: authHeaders(),
    });
    expect(historyStatus.status).toBe(200);
    expect(historyStatus.data.mode).toBe("history");
    expect(historyStatus.data.historyIncluded).toBe(true);
    expect(historyStatus.data.byStatus.stopped).toBeGreaterThanOrEqual(1);
    expect(historyStatus.data.byStatus.destroyed).toBeGreaterThanOrEqual(1);
    expect(historyStatus.data.totalSpawned).toBeGreaterThanOrEqual(activeStatus.data.totalSpawned);
  });

  test("active tree surfaces running resource VMs even when their parent subtree is historical", async () => {
    const server = await createServer({ modules: [vmTree] });
    const store = server.ctx.getStore<{ vmTreeStore: VMTreeStore }>("vm-tree")?.vmTreeStore;
    expect(store).toBeDefined();

    const suffix = `${Date.now()}-history-resource`;
    const rootVmId = `root-${suffix}`;
    const stoppedLtVmId = `lt-${suffix}`;
    const runningResourceVmId = `resource-${suffix}`;

    store!.upsertVM({ vmId: rootVmId, name: `root-${suffix}`, category: "infra_vm", status: "running" });
    store!.upsertVM({
      vmId: stoppedLtVmId,
      name: `lt-${suffix}`,
      category: "lieutenant",
      status: "stopped",
      parentId: rootVmId,
    });
    store!.upsertVM({
      vmId: runningResourceVmId,
      name: `resource-${suffix}`,
      category: "resource_vm",
      status: "running",
      parentId: stoppedLtVmId,
    });

    const treeDefault = await json(server.app, `/vm-tree/tree?root=${encodeURIComponent(rootVmId)}`, {
      headers: authHeaders(),
    });
    expect(treeDefault.status).toBe(200);
    expect(treeDefault.data.visibleCount).toBe(2);
    expect(treeDefault.data.totalRegistered).toBeGreaterThanOrEqual(3);
    expect(treeDefault.data.tree).toHaveLength(1);
    expect(treeDefault.data.tree[0].vm.vmId).toBe(rootVmId);
    expect(treeDefault.data.tree[0].children).toHaveLength(1);
    expect(treeDefault.data.tree[0].children[0].vm.vmId).toBe(runningResourceVmId);

    const treeWithHistory = await json(server.app, `/vm-tree/tree?root=${encodeURIComponent(rootVmId)}&includeHistory=true`, {
      headers: authHeaders(),
    });
    expect(treeWithHistory.status).toBe(200);
    expect(treeWithHistory.data.tree[0].children).toHaveLength(1);
    expect(treeWithHistory.data.tree[0].children[0].vm.vmId).toBe(stoppedLtVmId);
    expect(treeWithHistory.data.tree[0].children[0].children[0].vm.vmId).toBe(runningResourceVmId);
  });
});
