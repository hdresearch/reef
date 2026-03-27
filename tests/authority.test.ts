import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "../src/core/server.js";
import logs from "../services/logs/index.js";
import signals from "../services/signals/index.js";
import vmTree from "../services/vm-tree/index.js";
import { VMTreeStore } from "../services/vm-tree/store.js";

const AUTH_TOKEN = "authority-test-token";

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
  process.env.VERS_VM_ID = `vm-root-${Date.now()}`;
  process.env.VERS_AGENT_NAME = "root-reef";
});

afterEach(() => {
  delete process.env.VERS_AUTH_TOKEN;
  delete process.env.VERS_VM_ID;
  delete process.env.VERS_AGENT_NAME;
});

function seedHierarchy(store: VMTreeStore, suffix: string) {
  const ids = {
    rootVmId: `root-${suffix}`,
    rootName: `root-reef-${suffix}`,
    ltVmId: `lt-1-${suffix}`,
    ltName: `lineage-lt-${suffix}`,
    agentVmId: `agent-1-${suffix}`,
    agentName: `lineage-agent-${suffix}`,
    siblingAgentVmId: `agent-1b-${suffix}`,
    siblingAgentName: `lineage-agent-sibling-${suffix}`,
    swarmVmId: `swarm-1-${suffix}`,
    swarmName: `agent-1-worker-${suffix}`,
    otherLtVmId: `lt-2-${suffix}`,
    otherLtName: `other-lt-${suffix}`,
    otherAgentVmId: `agent-2-${suffix}`,
    otherAgentName: `other-agent-${suffix}`,
  };

  store.upsertVM({ vmId: ids.rootVmId, name: ids.rootName, category: "infra_vm", status: "running" });
  store.upsertVM({
    vmId: ids.ltVmId,
    name: ids.ltName,
    category: "lieutenant",
    status: "running",
    parentId: ids.rootVmId,
  });
  store.upsertVM({
    vmId: ids.agentVmId,
    name: ids.agentName,
    category: "agent_vm",
    status: "running",
    parentId: ids.ltVmId,
  });
  store.upsertVM({
    vmId: ids.siblingAgentVmId,
    name: ids.siblingAgentName,
    category: "agent_vm",
    status: "running",
    parentId: ids.ltVmId,
  });
  store.upsertVM({
    vmId: ids.swarmVmId,
    name: ids.swarmName,
    category: "swarm_vm",
    status: "running",
    parentId: ids.agentVmId,
  });
  store.upsertVM({
    vmId: ids.otherLtVmId,
    name: ids.otherLtName,
    category: "lieutenant",
    status: "running",
    parentId: ids.rootVmId,
  });
  store.upsertVM({
    vmId: ids.otherAgentVmId,
    name: ids.otherAgentName,
    category: "agent_vm",
    status: "running",
    parentId: ids.otherLtVmId,
  });

  return ids;
}

describe("authority model", () => {
  test("reef_command is enforced to the requester's subtree", async () => {
    const server = await createServer({ modules: [vmTree, signals] });
    const store = server.ctx.getStore<{ vmTreeStore: VMTreeStore }>("vm-tree")?.vmTreeStore;
    expect(store).toBeDefined();
    const ids = seedHierarchy(store!, `${Date.now()}-cmd`);

    const lieutenantHeaders = authHeaders({
      "X-Reef-Agent-Name": ids.ltName,
      "X-Reef-VM-ID": ids.ltVmId,
      "X-Reef-Category": "lieutenant",
    });

    const lieutenantToChild = await json(server.app, "/signals/", {
      method: "POST",
      headers: lieutenantHeaders,
      body: {
        fromAgent: ids.ltName,
        toAgent: ids.agentName,
        direction: "down",
        signalType: "steer",
        payload: { message: "focus on lineage accounting" },
      },
    });
    expect(lieutenantToChild.status).toBe(201);

    const lieutenantToGrandchild = await json(server.app, "/signals/", {
      method: "POST",
      headers: lieutenantHeaders,
      body: {
        fromAgent: ids.ltName,
        toAgent: ids.swarmName,
        direction: "down",
        signalType: "pause",
      },
    });
    expect(lieutenantToGrandchild.status).toBe(201);

    store!.updateVM(ids.agentVmId, { status: "stopped" });
    const lieutenantToStoppedChild = await json(server.app, "/signals/", {
      method: "POST",
      headers: lieutenantHeaders,
      body: {
        fromAgent: ids.ltName,
        toAgent: ids.agentName,
        direction: "down",
        signalType: "steer",
      },
    });
    expect(lieutenantToStoppedChild.status).toBe(409);

    const agentHeaders = authHeaders({
      "X-Reef-Agent-Name": ids.agentName,
      "X-Reef-VM-ID": ids.agentVmId,
      "X-Reef-Category": "agent_vm",
    });

    const agentToSiblingBranch = await json(server.app, "/signals/", {
      method: "POST",
      headers: agentHeaders,
      body: {
        fromAgent: ids.agentName,
        toAgent: ids.otherAgentName,
        direction: "down",
        signalType: "steer",
      },
    });
    expect(agentToSiblingBranch.status).toBe(403);

    const agentToParent = await json(server.app, "/signals/", {
      method: "POST",
      headers: agentHeaders,
      body: {
        fromAgent: ids.agentName,
        toAgent: ids.ltName,
        direction: "down",
        signalType: "resume",
      },
    });
    expect(agentToParent.status).toBe(403);

    const rootHeaders = authHeaders({
      "X-Reef-Agent-Name": ids.rootName,
      "X-Reef-VM-ID": ids.rootVmId,
      "X-Reef-Category": "infra_vm",
    });
    const rootToAnyone = await json(server.app, "/signals/", {
      method: "POST",
      headers: rootHeaders,
      body: {
        fromAgent: ids.rootName,
        toAgent: ids.otherAgentName,
        direction: "down",
        signalType: "abort",
      },
    });
    expect(rootToAnyone.status).toBe(201);
  });

  test("reef_peer_signal allows same-parent siblings but denies cross-branch peers", async () => {
    const server = await createServer({ modules: [vmTree, signals] });
    const store = server.ctx.getStore<{ vmTreeStore: VMTreeStore }>("vm-tree")?.vmTreeStore;
    expect(store).toBeDefined();
    const ids = seedHierarchy(store!, `${Date.now()}-peer`);

    const agentHeaders = authHeaders({
      "X-Reef-Agent-Name": ids.agentName,
      "X-Reef-VM-ID": ids.agentVmId,
      "X-Reef-Category": "agent_vm",
    });

    const siblingPeer = await json(server.app, "/signals/", {
      method: "POST",
      headers: agentHeaders,
      body: {
        fromAgent: ids.agentName,
        toAgent: ids.siblingAgentName,
        direction: "peer",
        signalType: "artifact",
        payload: { summary: "branch ready", branch: "feat/lineage-agent/demo" },
      },
    });
    expect(siblingPeer.status).toBe(201);

    const inbox = await json(
      server.app,
      `/signals/?to=${encodeURIComponent(ids.siblingAgentName)}&direction=peer&acknowledged=false&limit=10`,
      {
        headers: authHeaders({
          "X-Reef-Agent-Name": ids.siblingAgentName,
          "X-Reef-VM-ID": ids.siblingAgentVmId,
          "X-Reef-Category": "agent_vm",
        }),
      },
    );
    expect(inbox.status).toBe(200);
    expect(inbox.data.count).toBe(1);
    expect(inbox.data.signals[0].signalType).toBe("artifact");
    expect(inbox.data.signals[0].fromAgent).toBe(ids.agentName);

    const crossBranchPeer = await json(server.app, "/signals/", {
      method: "POST",
      headers: agentHeaders,
      body: {
        fromAgent: ids.agentName,
        toAgent: ids.otherAgentName,
        direction: "peer",
        signalType: "request",
        payload: { summary: "send me your branch" },
      },
    });
    expect(crossBranchPeer.status).toBe(403);

    store!.updateVM(ids.siblingAgentVmId, { status: "stopped" });
    const stoppedSiblingPeer = await json(server.app, "/signals/", {
      method: "POST",
      headers: agentHeaders,
      body: {
        fromAgent: ids.agentName,
        toAgent: ids.siblingAgentName,
        direction: "peer",
        signalType: "warning",
        payload: { summary: "late coordination attempt" },
      },
    });
    expect(stoppedSiblingPeer.status).toBe(409);
  });

  test("reef_logs is scoped to self, direct parent, descendants, same-parent siblings, and root override", async () => {
    const server = await createServer({ modules: [vmTree, logs] });
    const store = server.ctx.getStore<{ vmTreeStore: VMTreeStore }>("vm-tree")?.vmTreeStore;
    expect(store).toBeDefined();
    const ids = seedHierarchy(store!, `${Date.now()}-logs`);

    store!.insertLog({ agentId: ids.ltVmId, agentName: ids.ltName, level: "info", message: "lt log" });
    store!.insertLog({ agentId: ids.agentVmId, agentName: ids.agentName, level: "info", message: "agent log" });
    store!.insertLog({
      agentId: ids.siblingAgentVmId,
      agentName: ids.siblingAgentName,
      level: "info",
      message: "sibling agent log",
    });
    store!.insertLog({ agentId: ids.swarmVmId, agentName: ids.swarmName, level: "info", message: "swarm log" });
    store!.insertLog({ agentId: ids.otherAgentVmId, agentName: ids.otherAgentName, level: "info", message: "other log" });

    const lieutenantHeaders = authHeaders({
      "X-Reef-Agent-Name": ids.ltName,
      "X-Reef-VM-ID": ids.ltVmId,
      "X-Reef-Category": "lieutenant",
    });
    const ltReadsDescendant = await json(server.app, `/logs/?agent=${encodeURIComponent(ids.agentName)}&limit=10`, {
      headers: lieutenantHeaders,
    });
    expect(ltReadsDescendant.status).toBe(200);
    expect(ltReadsDescendant.data.count).toBe(1);
    expect(ltReadsDescendant.data.logs[0].agentName).toBe(ids.agentName);

    store!.updateVM(ids.agentVmId, { status: "stopped" });
    const ltReadsStoppedDescendant = await json(server.app, `/logs/?agent=${encodeURIComponent(ids.agentName)}&limit=10`, {
      headers: lieutenantHeaders,
    });
    expect(ltReadsStoppedDescendant.status).toBe(200);
    expect(ltReadsStoppedDescendant.data.count).toBe(1);
    expect(ltReadsStoppedDescendant.data.logs[0].agentName).toBe(ids.agentName);

    const agentHeaders = authHeaders({
      "X-Reef-Agent-Name": ids.agentName,
      "X-Reef-VM-ID": ids.agentVmId,
      "X-Reef-Category": "agent_vm",
    });
    const agentReadsParent = await json(server.app, `/logs/?agent=${encodeURIComponent(ids.ltName)}&limit=10`, {
      headers: agentHeaders,
    });
    expect(agentReadsParent.status).toBe(200);
    expect(agentReadsParent.data.count).toBe(1);
    expect(agentReadsParent.data.logs[0].agentName).toBe(ids.ltName);

    const agentReadsDefaultSelf = await json(server.app, "/logs/?limit=10", {
      headers: agentHeaders,
    });
    expect(agentReadsDefaultSelf.status).toBe(200);
    expect(agentReadsDefaultSelf.data.count).toBe(1);
    expect(agentReadsDefaultSelf.data.logs[0].agentName).toBe(ids.agentName);

    const siblingHeaders = authHeaders({
      "X-Reef-Agent-Name": ids.siblingAgentName,
      "X-Reef-VM-ID": ids.siblingAgentVmId,
      "X-Reef-Category": "agent_vm",
    });
    const siblingReadsSibling = await json(server.app, `/logs/?agent=${encodeURIComponent(ids.agentName)}&limit=10`, {
      headers: siblingHeaders,
    });
    expect(siblingReadsSibling.status).toBe(200);
    expect(siblingReadsSibling.data.count).toBe(1);
    expect(siblingReadsSibling.data.logs[0].agentName).toBe(ids.agentName);

    const agentReadsOtherBranch = await json(server.app, `/logs/?agent=${encodeURIComponent(ids.otherAgentName)}&limit=10`, {
      headers: agentHeaders,
    });
    expect(agentReadsOtherBranch.status).toBe(403);

    const rootHeaders = authHeaders({
      "X-Reef-Agent-Name": ids.rootName,
      "X-Reef-VM-ID": ids.rootVmId,
      "X-Reef-Category": "infra_vm",
    });
    const rootReadsAnyone = await json(server.app, `/logs/?agent=${encodeURIComponent(ids.otherAgentName)}&limit=10`, {
      headers: rootHeaders,
    });
    expect(rootReadsAnyone.status).toBe(200);
    expect(rootReadsAnyone.data.count).toBe(1);
    expect(rootReadsAnyone.data.logs[0].agentName).toBe(ids.otherAgentName);
  });
});
