import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "../src/core/server.js";
import scheduled from "../services/scheduled/index.js";
import vmTree from "../services/vm-tree/index.js";

const AUTH_TOKEN = "scheduled-test-token";

function request(
  app: { fetch: (req: Request) => Promise<Response> },
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    ...(opts.headers || {}),
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
}

async function json(
  app: { fetch: (req: Request) => Promise<Response> },
  path: string,
  opts: Parameters<typeof request>[2] = {},
) {
  const res = await request(app, path, opts);
  return { status: res.status, data: await res.json() };
}

beforeEach(() => {
  process.env.VERS_VM_ID = `vm-root-scheduled-${Date.now()}`;
  process.env.VERS_AGENT_NAME = "root-reef";
  process.env.VERS_AUTH_TOKEN = AUTH_TOKEN;
});

afterEach(() => {
  delete process.env.VERS_VM_ID;
  delete process.env.VERS_AGENT_NAME;
  delete process.env.VERS_AUTH_TOKEN;
});

describe("scheduled orchestration checks", () => {
  test("creates, lists, and cancels scheduled checks", async () => {
    const server = await createServer({ modules: [vmTree, scheduled] });

    const created = await json(server.app, "/scheduled", {
      method: "POST",
      body: {
        kind: "follow_up",
        message: "check on peer-a",
        targetAgent: "peer-a",
        delay: "5m",
      },
    });

    expect(created.status).toBe(201);
    expect(created.data.status).toBe("pending");

    const listed = await json(server.app, "/scheduled?status=pending");
    expect(listed.status).toBe(200);
    expect(listed.data.count).toBe(1);
    expect(listed.data.checks[0].id).toBe(created.data.id);

    const cancelled = await json(server.app, `/scheduled/${created.data.id}/cancel`, {
      method: "POST",
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.data.status).toBe("cancelled");
  });

  test("fires due checks into the downward signals plane for active targets", async () => {
    const server = await createServer({ modules: [vmTree, scheduled] });
    const vmTreeStore = server.ctx.getStore<any>("vm-tree")!.vmTreeStore;
    const targetAgent = `peer-a-${Date.now()}`;

    vmTreeStore.upsertVM({
      vmId: `vm-${targetAgent}`,
      name: targetAgent,
      parentId: process.env.VERS_VM_ID!,
      category: "agent_vm",
      status: "running",
    });
    vmTreeStore.updateVM(`vm-${targetAgent}`, { rpcStatus: "connected" });

    const created = await json(server.app, "/scheduled", {
      method: "POST",
      body: {
        kind: "follow_up",
        message: "check if peer-a finished",
        targetAgent,
        dueAt: Date.now() - 10,
      },
    });

    expect(created.status).toBe(201);

    const tick = await json(server.app, "/scheduled/_tick", { method: "POST" });
    expect(tick.status).toBe(200);

    const fired = await json(server.app, `/scheduled?status=fired&targetAgent=${encodeURIComponent(targetAgent)}`);
    expect(fired.status).toBe(200);
    expect(fired.data.count).toBe(1);
    expect(fired.data.checks[0].statusReason).toContain(`delivered to ${targetAgent}`);
    expect(fired.data.checks[0].id).toBe(created.data.id);

    const signals = vmTreeStore.querySignals({ toAgent: targetAgent, signalType: "steer" });
    expect(signals).toHaveLength(1);
    expect(signals[0].fromAgent).toBe("reef-scheduler");
    expect(signals[0].payload).toMatchObject({
      source: "scheduled",
      scheduledCheckId: created.data.id,
      message: "check if peer-a finished",
    });

    await json(server.app, "/scheduled/_tick", { method: "POST" });
    const signalsAfterRetick = vmTreeStore.querySignals({ toAgent: targetAgent, signalType: "steer" });
    expect(signalsAfterRetick).toHaveLength(1);
  });

  test('normalizes targetAgent "root" to the actual root agent name', async () => {
    const server = await createServer({ modules: [vmTree, scheduled] });

    const created = await json(server.app, "/scheduled", {
      method: "POST",
      body: {
        kind: "follow_up",
        message: "wake root through alias",
        targetAgent: "root",
        dueAt: Date.now() - 10,
      },
    });

    expect(created.status).toBe(201);
    expect(created.data.targetAgent).toBe("root-reef");

    await json(server.app, "/scheduled/_tick", { method: "POST" });

    const fired = await json(server.app, `/scheduled?status=fired&targetAgent=${encodeURIComponent("root-reef")}`);
    expect(fired.status).toBe(200);
    expect(fired.data.count).toBe(1);
    expect(fired.data.checks[0].id).toBe(created.data.id);
    expect(fired.data.checks[0].statusReason).toContain("delivered to root-reef");
  });

  test("supersedes pending checks when the auto-cancel condition already matches", async () => {
    const server = await createServer({ modules: [vmTree, scheduled] });
    const vmTreeStore = server.ctx.getStore<any>("vm-tree")!.vmTreeStore;
    const targetAgent = `peer-b-${Date.now()}`;

    vmTreeStore.upsertVM({
      vmId: `vm-${targetAgent}`,
      name: targetAgent,
      parentId: process.env.VERS_VM_ID!,
      category: "agent_vm",
      status: "running",
    });
    vmTreeStore.updateVM(`vm-${targetAgent}`, { rpcStatus: "connected" });

    const created = await json(server.app, "/scheduled", {
      method: "POST",
      body: {
        kind: "follow_up",
        message: "check whether peer-b is done",
        targetAgent,
        dueAt: Date.now() + 60_000,
        autoCancelOn: {
          signalType: "done",
        },
      },
    });

    expect(created.status).toBe(201);

    vmTreeStore.insertSignal({
      fromAgent: targetAgent,
      toAgent: "root-reef",
      direction: "up",
      signalType: "done",
      payload: { ok: true },
    });

    await json(server.app, "/scheduled/_tick", { method: "POST" });

    const superseded = await json(
      server.app,
      `/scheduled?status=superseded&targetAgent=${encodeURIComponent(targetAgent)}`,
    );
    expect(superseded.status).toBe(200);
    expect(superseded.data.count).toBe(1);
    expect(superseded.data.checks[0].statusReason).toContain("matching signal done");
    expect(superseded.data.checks[0].id).toBe(created.data.id);

    const signals = vmTreeStore.querySignals({ toAgent: targetAgent, signalType: "steer" });
    expect(signals).toHaveLength(0);
  });

  test("condition-first await_store checks fire when the store condition matches without requiring a delay", async () => {
    const server = await createServer({ modules: [vmTree, scheduled] });
    const vmTreeStore = server.ctx.getStore<any>("vm-tree")!.vmTreeStore;
    const targetAgent = `peer-c-${Date.now()}`;

    vmTreeStore.upsertVM({
      vmId: `vm-${targetAgent}`,
      name: targetAgent,
      parentId: process.env.VERS_VM_ID!,
      category: "agent_vm",
      status: "running",
    });
    vmTreeStore.updateVM(`vm-${targetAgent}`, { rpcStatus: "connected" });

    const created = await json(server.app, "/scheduled", {
      method: "POST",
      body: {
        kind: "await_store",
        message: "peer-c is ready",
        targetAgent,
        triggerOn: {
          storeKey: `${targetAgent}:coord/phase`,
          storeEquals: "ready",
        },
      },
    });

    expect(created.status).toBe(201);
    expect(created.data.dueAt).toBe(0);

    await json(server.app, "/scheduled/_tick", { method: "POST" });
    let pending = await json(server.app, `/scheduled?status=pending&targetAgent=${encodeURIComponent(targetAgent)}`);
    expect(pending.data.count).toBe(1);

    vmTreeStore.storePut(`${targetAgent}:coord/phase`, "ready", targetAgent, `vm-${targetAgent}`);

    await json(server.app, "/scheduled/_tick", { method: "POST" });
    const fired = await json(server.app, `/scheduled?status=fired&targetAgent=${encodeURIComponent(targetAgent)}`);
    expect(fired.status).toBe(200);
    expect(fired.data.count).toBe(1);
    expect(fired.data.checks[0].id).toBe(created.data.id);
    expect(fired.data.checks[0].statusReason).toContain("triggered after store condition matched");

    const signals = vmTreeStore.querySignals({ toAgent: targetAgent, signalType: "steer" });
    expect(signals).toHaveLength(1);
    expect(signals[0].payload).toMatchObject({
      scheduledCheckId: created.data.id,
      kind: "await_store",
      message: "peer-c is ready",
    });
  });

  test("emits a scheduled:fired event when a due check is delivered", async () => {
    const server = await createServer({ modules: [vmTree, scheduled] });
    const vmTreeStore = server.ctx.getStore<any>("vm-tree")!.vmTreeStore;
    const targetAgent = `peer-d-${Date.now()}`;
    const firedEvents: any[] = [];

    server.events.on("scheduled:fired", (data: any) => {
      firedEvents.push(data);
    });

    vmTreeStore.upsertVM({
      vmId: `vm-${targetAgent}`,
      name: targetAgent,
      parentId: process.env.VERS_VM_ID!,
      category: "agent_vm",
      status: "running",
    });
    vmTreeStore.updateVM(`vm-${targetAgent}`, { rpcStatus: "connected" });

    const created = await json(server.app, "/scheduled", {
      method: "POST",
      body: {
        kind: "follow_up",
        message: "check if peer-d finished",
        targetAgent,
        dueAt: Date.now() - 10,
      },
    });

    expect(created.status).toBe(201);

    await json(server.app, "/scheduled/_tick", { method: "POST" });

    expect(firedEvents).toHaveLength(1);
    expect(firedEvents[0]).toMatchObject({
      checkId: created.data.id,
      targetAgent,
      kind: "follow_up",
      message: "check if peer-d finished",
    });
  });
});
