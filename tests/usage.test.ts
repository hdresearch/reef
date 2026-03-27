import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "../src/core/server.js";
import { ServiceEventBus } from "../src/core/events.js";
import usage from "../services/usage/index.js";
import vmTree from "../services/vm-tree/index.js";
import { VMTreeStore } from "../services/vm-tree/store.js";

beforeEach(() => {
  delete process.env.VERS_VM_ID;
  delete process.env.VERS_AGENT_NAME;
  delete process.env.VERS_AUTH_TOKEN;
});

afterEach(() => {
  delete process.env.VERS_VM_ID;
  delete process.env.VERS_AGENT_NAME;
  delete process.env.VERS_AUTH_TOKEN;
});

describe("usage service", () => {
  test("captures usage records from usage:message events and summarizes by agent", async () => {
    process.env.VERS_VM_ID = `vm-root-${Date.now()}-usage`;
    process.env.VERS_AGENT_NAME = "root-reef";
    const startedAt = Date.now();
    const ltAgentName = `idol-lt-${startedAt}`;
    const workerAgentName = `staging-worker-${startedAt}`;

    const server = await createServer({
      modules: [vmTree, usage],
    });

    const store = server.ctx.getStore<{ vmTreeStore: VMTreeStore }>("vm-tree")?.vmTreeStore;
    expect(store).toBeDefined();

    await server.events.emit("usage:message", {
      agentId: "vm-a",
      agentName: ltAgentName,
      taskId: "task-1",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: {
          input: 1200,
          output: 300,
          cacheRead: 50,
          cacheWrite: 0,
          cost: { input: 0.003, output: 0.004, cacheRead: 0.0001, cacheWrite: 0, total: 0.0071 },
        },
      },
    });

    await server.events.emit("usage:message", {
      agentId: "vm-b",
      agentName: workerAgentName,
      taskId: "task-2",
      message: {
        role: "assistant",
        provider: "vers",
        model: "claude-sonnet-4-6",
        usage: {
          input: 400,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0.001, output: 0.0014, cacheRead: 0, cacheWrite: 0, total: 0.0024 },
        },
      },
    });

    const summary = store!.usageSummary(startedAt - 1);
    expect(summary.totals.totalTokens).toBe(2050);
    expect(summary.totals.totalCost).toBeCloseTo(0.0095, 6);
    expect(summary.byAgent).toHaveLength(2);
    expect(summary.byAgent[0]).toMatchObject({
      agentName: ltAgentName,
      totalTokens: 1550,
    });

    const response = await server.app.fetch(
      new Request(`http://localhost/usage/records?agent=${encodeURIComponent(ltAgentName)}&limit=10`),
    );
    expect(response.status).toBe(200);
    const json: any = await response.json();
    expect(json.count).toBe(1);
    expect(json.records[0].agentName).toBe(ltAgentName);
    expect(json.records[0].totalTokens).toBe(1550);
  });

  test("prefers child session snapshots and rolls totals up across descendant lineages", () => {
    const store = new VMTreeStore(`data/fleet-${Date.now()}-usage-lineage.sqlite`);

    try {
      store.upsertVM({ vmId: "root", name: "root-reef", category: "infra_vm", status: "running" });
      store.upsertVM({ vmId: "lt-1", name: "idol-lt", parentId: "root", category: "lieutenant", status: "running" });
      store.upsertVM({
        vmId: "agent-1",
        name: "idol-dashboard",
        parentId: "lt-1",
        category: "agent_vm",
        status: "running",
      });
      store.upsertVM({
        vmId: "swarm-1",
        name: "staging-worker",
        parentId: "agent-1",
        category: "swarm_vm",
        status: "running",
      });

      store.insertUsage({
        agentId: "root",
        agentName: "root-reef",
        provider: "vers",
        model: "claude-sonnet-4-6",
        totalTokens: 100,
        totalCost: 0.01,
      });
      store.insertUsage({
        agentId: "lt-1",
        agentName: "idol-lt",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        totalTokens: 10,
        totalCost: 0.001,
      });
      store.upsertUsageSession({
        agentId: "lt-1",
        agentName: "idol-lt",
        sessionId: "sess-lt-1",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        assistantMessages: 4,
        inputTokens: 150,
        outputTokens: 50,
        totalTokens: 200,
        totalCost: 0.02,
      });
      store.upsertUsageSession({
        agentId: "agent-1",
        agentName: "idol-dashboard",
        sessionId: "sess-agent-1",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        assistantMessages: 3,
        inputTokens: 220,
        outputTokens: 80,
        totalTokens: 300,
        totalCost: 0.03,
      });
      store.upsertUsageSession({
        agentId: "swarm-1",
        agentName: "staging-worker",
        sessionId: "sess-swarm-1",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        assistantMessages: 5,
        inputTokens: 280,
        outputTokens: 120,
        totalTokens: 400,
        totalCost: 0.04,
      });

      const summary = store.usageSummary();
      expect(summary.totals.totalTokens).toBe(1000);
      expect(summary.totals.totalCost).toBeCloseTo(0.1, 6);

      const lieutenant = summary.byAgent.find((row) => row.agentId === "lt-1");
      expect(lieutenant).toMatchObject({
        agentName: "idol-lt",
        category: "lieutenant",
        totalTokens: 200,
        totalCost: 0.02,
        turns: 4,
      });

      const rootLineage = summary.lineages.find((row) => row.agentId === "root");
      expect(rootLineage).toMatchObject({
        agentName: "root-reef",
        descendantAgents: 3,
        selfTokens: 100,
        subtreeTokens: 1000,
      });

      const lieutenantLineage = summary.lineages.find((row) => row.agentId === "lt-1");
      expect(lieutenantLineage).toMatchObject({
        agentName: "idol-lt",
        descendantAgents: 2,
        selfTokens: 200,
        subtreeTokens: 900,
      });

      const agentLineage = summary.lineages.find((row) => row.agentId === "agent-1");
      expect(agentLineage).toMatchObject({
        agentName: "idol-dashboard",
        descendantAgents: 1,
        selfTokens: 300,
        subtreeTokens: 700,
      });

      expect(summary.accuracy.childAgentsSource).toContain("get_session_stats");
      expect(summary.accuracy.caveats).toContain(
        "agents without a session snapshot yet fall back to assistant message usage rows",
      );
    } finally {
      store.close();
    }
  });

  test("aggregates multiple session snapshots for the same agent instead of only the latest session", () => {
    const store = new VMTreeStore(`data/fleet-${Date.now()}-usage-root-sessions.sqlite`);

    try {
      store.upsertVM({ vmId: "root", name: "root-reef", category: "infra_vm", status: "running" });
      store.upsertUsageSession({
        agentId: "root",
        agentName: "root-reef",
        sessionId: "sess-root-1",
        provider: "anthropic",
        model: "claude-opus-4-6",
        assistantMessages: 2,
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        totalCost: 0.014,
      });
      store.upsertUsageSession({
        agentId: "root",
        agentName: "root-reef",
        sessionId: "sess-root-2",
        provider: "anthropic",
        model: "claude-opus-4-6",
        assistantMessages: 3,
        inputTokens: 200,
        outputTokens: 60,
        totalTokens: 260,
        totalCost: 0.026,
      });

      const summary = store.usageSummary();
      expect(summary.byAgent).toHaveLength(1);
      expect(summary.byAgent[0]).toMatchObject({
        agentId: "root",
        agentName: "root-reef",
        totalTokens: 400,
        totalCost: 0.04,
        turns: 5,
      });
      expect(summary.totals.totalTokens).toBe(400);
      expect(summary.accuracy.rootSource).toContain("get_session_stats");
      expect(summary.accuracy.caveats).toContain(
        "session-backed agents aggregate the latest snapshot from each known session, not just the latest session overall",
      );
    } finally {
      store.close();
    }
  });

  test("records usage:stats events and exposes accuracy copy in the summary panel", async () => {
    process.env.VERS_VM_ID = `vm-root-${Date.now()}-usage-stats`;
    process.env.VERS_AGENT_NAME = "root-reef";

    const server = await createServer({
      modules: [vmTree, usage],
    });

    const store = server.ctx.getStore<{ vmTreeStore: VMTreeStore }>("vm-tree")?.vmTreeStore;
    expect(store).toBeDefined();
    store!.upsertVM({ vmId: "lt-2", name: "idol-lt-2", parentId: process.env.VERS_VM_ID, category: "lieutenant", status: "running" });

    await server.events.emit("usage:message", {
      agentId: process.env.VERS_VM_ID,
      agentName: process.env.VERS_AGENT_NAME,
      taskId: "task-root",
      message: {
        role: "assistant",
        provider: "vers",
        model: "claude-sonnet-4-6",
        usage: {
          input: 50,
          output: 25,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
        },
      },
    });

    await server.events.emit("usage:stats", {
      agentId: "lt-2",
      agentName: "idol-lt-2",
      taskId: "task-lt",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      stats: {
        sessionId: "sess-lt-2",
        sessionFile: "/tmp/session.json",
        userMessages: 1,
        assistantMessages: 2,
        toolCalls: 1,
        toolResults: 1,
        totalMessages: 5,
        tokens: { input: 120, output: 80, cacheRead: 10, cacheWrite: 0, total: 210 },
        cost: 0.012,
      },
    });

    const summaryResponse = await server.app.fetch(new Request("http://localhost/usage/summary?windowMinutes=1440"));
    expect(summaryResponse.status).toBe(200);
    const summary: any = await summaryResponse.json();
    expect(summary.accuracy.childAgentsSource).toContain("falls back to assistant-message usage");
    expect(summary.lineages.find((row: any) => row.agentId === process.env.VERS_VM_ID)?.subtreeTokens).toBe(285);

    const panelResponse = await server.app.fetch(new Request("http://localhost/usage/_panel"));
    expect(panelResponse.status).toBe(200);
    const html = await panelResponse.text();
    expect(html).toContain("Top Lineages");
    expect(html).toContain("falls back to assistant-message usage rows");
    expect(html).toContain("vm-tree lineage");
  });

  test("ignores usage events without assistant usage payload", async () => {
    const runtimeEvents = new ServiceEventBus();
    const store = new VMTreeStore(`data/fleet-${Date.now()}-usage.sqlite`);
    usage.init?.({
      events: runtimeEvents,
      servicesDir: process.cwd(),
      getStore(name: string) {
        if (name === "vm-tree") return { vmTreeStore: store } as any;
        return undefined;
      },
      getModules() {
        return [usage];
      },
      getModule(name: string) {
        return name === "usage" ? usage : undefined;
      },
      async loadModule() {
        throw new Error("not needed");
      },
      async unloadModule() {
        throw new Error("not needed");
      },
    });

    await runtimeEvents.emit("usage:message", {
      agentId: "vm-x",
      agentName: "agent-x",
      message: { role: "assistant" },
    });

    expect(store.queryUsage({ limit: 10 })).toHaveLength(0);
    store.close();
  });
});
