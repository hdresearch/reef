import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { createReef } from "./reef.js";
import type { ConversationTree } from "./tree.js";

const TOKEN = "test-token-reef";
process.env.VERS_AUTH_TOKEN = TOKEN;
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

// Use isolated data dir for tests
const TEST_DATA_DIR = "data/test-reef";
if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
process.env.REEF_DATA_DIR = TEST_DATA_DIR;
afterAll(() => {
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
});

describe("reef", () => {
  let app: any;
  let tree: ConversationTree;

  const setup = (async () => {
    const reef = await createReef({ server: { modules: [] } });
    app = reef.app;
    tree = reef.tree;
  })();

  async function json(path: string, opts?: { method?: string; body?: unknown; auth?: boolean }) {
    await setup;
    const h = opts?.auth === false ? {} : headers;
    const res = await app.fetch(
      new Request(`http://localhost${path}`, {
        method: opts?.method ?? "GET",
        headers: h,
        body: opts?.body ? JSON.stringify(opts.body) : undefined,
      }),
    );
    return { status: res.status, data: await res.json() };
  }

  // ===========================================================================
  // Basic routing
  // ===========================================================================

  test("GET /reef/state — initial state", async () => {
    const { status, data } = await json("/reef/state");
    expect(status).toBe(200);
    expect(data.mode).toBe("agent");
    expect(data.activeTasks).toBe(0);
    expect(data.totalNodes).toBe(1); // system prompt
  });

  test("GET /reef/tree — has system root", async () => {
    const { data } = await json("/reef/tree");
    expect(data.root).toBeTruthy();
    const root = data.nodes[data.root];
    expect(root.role).toBe("system");
    expect(root.parentId).toBeNull();
    // main ref points to root
    expect(data.refs.main).toBe(data.root);
  });

  test("GET /reef/tasks — empty initially", async () => {
    const { data } = await json("/reef/tasks");
    expect(data.tasks).toEqual([]);
  });

  test("GET /reef/tasks/:name — 404 for unknown", async () => {
    const { status } = await json("/reef/tasks/nope");
    expect(status).toBe(404);
  });

  test("GET /health — no auth required", async () => {
    await setup;
    const res = await app.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
  });

  test("requires auth", async () => {
    const { status } = await json("/reef/state", { auth: false });
    expect(status).toBe(401);
  });

  // ===========================================================================
  // Submit validation
  // ===========================================================================

  test("POST /reef/submit — 400 without task", async () => {
    const { status, data } = await json("/reef/submit", { method: "POST", body: {} });
    expect(status).toBe(400);
    expect(data.error).toContain("task");
  });

  test("POST /reef/submit — 400 with non-string task", async () => {
    const { status } = await json("/reef/submit", { method: "POST", body: { task: 123 } });
    expect(status).toBe(400);
  });

  test("POST /reef/submit — creates task and user node", async () => {
    // pi won't be available in test, but the tree node + task should still be created
    const { status, data } = await json("/reef/submit", {
      method: "POST",
      body: { task: "test task", taskId: "test-1" },
    });
    // 202 even if pi fails to spawn — task is created
    expect(status).toBe(202);
    expect(data.id).toBe("test-1");
    expect(data.nodeId).toBeTruthy();

    // Tree should have the user node
    const node = tree.get(data.nodeId);
    expect(node).toBeTruthy();
    expect(node!.role).toBe("user");
    expect(node!.content).toBe("test task");

    // Task should be registered
    const taskInfo = tree.getTask("test-1");
    expect(taskInfo).toBeTruthy();
    expect(taskInfo!.trigger).toBe("test task");
  });

  test("POST /reef/submit — auto-generates taskId", async () => {
    const { data } = await json("/reef/submit", {
      method: "POST",
      body: { task: "auto id test" },
    });
    expect(data.id).toBeTruthy();
    expect(data.id).not.toBe("test-1"); // different from previous
  });

  test("POST /reef/submit — user node is child of main", async () => {
    const { data } = await json("/reef/submit", {
      method: "POST",
      body: { task: "child test", taskId: "test-parent" },
    });
    const node = tree.get(data.nodeId);
    const mainId = tree.getRef("main");
    expect(node!.parentId).toBe(mainId);
  });

  // ===========================================================================
  // Continuation
  // ===========================================================================

  test("POST /reef/submit — continuation with parentId", async () => {
    // First task
    const { data: first } = await json("/reef/submit", {
      method: "POST",
      body: { task: "first message", taskId: "cont-test" },
    });

    // Simulate assistant response
    const assistantNode = tree.add(first.nodeId, "assistant", "first response");
    tree.setRef("cont-test", assistantNode.id);
    tree.completeTask("cont-test", { summary: "done", filesChanged: [] });

    // Continue
    const { status, data: second } = await json("/reef/submit", {
      method: "POST",
      body: { task: "follow up", taskId: "cont-test", parentId: assistantNode.id },
    });
    expect(status).toBe(202);

    // User node should be child of assistant
    const contNode = tree.get(second.nodeId);
    expect(contNode!.parentId).toBe(assistantNode.id);
    expect(contNode!.role).toBe("user");
    expect(contNode!.content).toBe("follow up");

    // Task should be reopened
    const taskInfo = tree.getTask("cont-test");
    expect(taskInfo!.status).toBe("running");
  });

  // ===========================================================================
  // Tree API
  // ===========================================================================

  test("GET /reef/tree/:id — returns node and children", async () => {
    await setup;
    const mainId = tree.getRef("main")!;
    const { status, data } = await json(`/reef/tree/${mainId}`);
    expect(status).toBe(200);
    expect(data.node.role).toBe("system");
    expect(data.children.length).toBeGreaterThan(0); // tasks we submitted
  });

  test("GET /reef/tree/:id — 404 for unknown", async () => {
    const { status } = await json("/reef/tree/nonexistent");
    expect(status).toBe(404);
  });

  test("GET /reef/tree/:id/path — returns ancestors", async () => {
    // Get a task's user node
    const _taskInfo = tree.getTask("test-1");
    const leafId = tree.getRef("test-1")!;
    const { status, data } = await json(`/reef/tree/${leafId}/path`);
    expect(status).toBe(200);
    expect(data.path.length).toBeGreaterThanOrEqual(2); // system + user
    expect(data.path[0].role).toBe("system"); // root is first
  });

  test("GET /reef/tasks — lists created tasks", async () => {
    const { data } = await json("/reef/tasks");
    expect(data.tasks.length).toBeGreaterThan(0);
    const names = data.tasks.map((t: any) => t.name);
    expect(names).toContain("test-1");
  });

  test("GET /reef/tasks?status=running — filters by status", async () => {
    const { data } = await json("/reef/tasks?status=done");
    // cont-test should not be done (we reopened it)
    const names = data.tasks.map((t: any) => t.name);
    expect(names).not.toContain("cont-test");
  });

  test("GET /reef/tasks/:name — returns task with path", async () => {
    const { status, data } = await json("/reef/tasks/test-1");
    expect(status).toBe(200);
    expect(data.name).toBe("test-1");
    expect(data.trigger).toBe("test task");
    expect(data.nodes.length).toBeGreaterThanOrEqual(2);
  });

  // ===========================================================================
  // SSE
  // ===========================================================================

  test("GET /reef/events — SSE connects with correct headers", async () => {
    await setup;
    const res = await app.fetch(new Request("http://localhost/reef/events", { headers }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  // ===========================================================================
  // State
  // ===========================================================================

  test("GET /reef/state — reflects submitted tasks", async () => {
    const { data } = await json("/reef/state");
    expect(data.totalTasks).toBeGreaterThan(0);
    expect(data.totalNodes).toBeGreaterThan(1);
  });
});
