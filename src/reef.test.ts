import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
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

  test("GET /reef/conversations — empty initially", async () => {
    const { data } = await json("/reef/conversations?includeClosed=true");
    expect(data.conversations).toEqual([]);
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

  test("POST /reef/conversations — creates persisted conversation metadata", async () => {
    const { status, data } = await json("/reef/conversations", {
      method: "POST",
      body: { task: "persist this chat" },
    });
    expect(status).toBe(202);
    expect(data.id).toBeTruthy();
    expect(data.title).toBe("persist this chat");
    expect(data.closed).toBe(false);
    const logPath = `${TEST_DATA_DIR}/conversations/${data.id}.jsonl`;
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(JSON.parse(lines[0]).type).toBe("user");
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

  test("POST /reef/conversations/:id/messages — continues conversation from current leaf", async () => {
    const { data: created } = await json("/reef/conversations", {
      method: "POST",
      body: { task: "conversation start" },
    });

    const assistantNode = tree.add(created.nodeId, "assistant", "first response");
    tree.setRef(created.id, assistantNode.id);
    tree.completeTask(created.id, { summary: "first response", filesChanged: [] });

    const { status, data } = await json(`/reef/conversations/${created.id}/messages`, {
      method: "POST",
      body: { task: "follow up without explicit parent" },
    });
    expect(status).toBe(202);

    const contNode = tree.get(data.nodeId);
    expect(contNode!.parentId).toBe(assistantNode.id);
    expect(tree.getTask(created.id)?.closed).toBe(false);
  });

  test("POST /reef/conversations/:id/close and /open — toggle persisted visibility", async () => {
    await json("/reef/conversations", {
      method: "POST",
      body: { task: "close me later" },
    });

    const { data: list } = await json("/reef/conversations?includeClosed=true");
    const conversation = list.conversations.find((item: any) => item.title === "close me later");
    expect(conversation).toBeTruthy();

    const { data: closed } = await json(`/reef/conversations/${conversation.id}/close`, { method: "POST" });
    expect(closed.closed).toBe(true);

    const { data: hidden } = await json("/reef/conversations");
    const openIds = hidden.conversations.map((item: any) => item.id);
    expect(openIds).not.toContain(conversation.id);

    const { data: reopened } = await json(`/reef/conversations/${conversation.id}/open`, { method: "POST" });
    expect(reopened.closed).toBe(false);

    const logPath = `${TEST_DATA_DIR}/conversations/${conversation.id}.jsonl`;
    const lines = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.some((line) => line.type === "conversation_closed")).toBe(true);
    expect(lines.some((line) => line.type === "conversation_opened")).toBe(true);
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

  test("GET /reef/conversations/:id — returns conversation metadata and nodes", async () => {
    const { data: list } = await json("/reef/conversations?includeClosed=true");
    const conversation = list.conversations.find((item: any) => item.title === "persist this chat");
    const { status, data } = await json(`/reef/conversations/${conversation.id}`);
    expect(status).toBe(200);
    expect(data.id).toBe(conversation.id);
    expect(data.title).toBe("persist this chat");
    expect(data.nodes.length).toBeGreaterThanOrEqual(1);
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
