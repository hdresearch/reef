import { describe, test, expect, afterAll } from "bun:test";
import { createReef } from "./reef.js";

const TOKEN = "test-token-reef";
process.env.VERS_AUTH_TOKEN = TOKEN;
const headers = { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" };

describe("reef", () => {
  let app: any;

  const setup = (async () => {
    const reef = await createReef({ server: { modules: [] } });
    app = reef.app;
  })();

  async function json(path: string, opts?: { method?: string; body?: unknown; auth?: boolean }) {
    await setup;
    const h = opts?.auth === false ? {} : headers;
    const res = await app.fetch(new Request(`http://localhost${path}`, {
      method: opts?.method ?? "GET",
      headers: h,
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    }));
    return { status: res.status, data: await res.json() };
  }

  test("GET /reef/state", async () => {
    const { status, data } = await json("/reef/state");
    expect(status).toBe(200);
    expect(data.mode).toBe("agent");
    expect(data.activeTasks).toBe(0);
    expect(data.totalNodes).toBe(1); // system prompt
  });

  test("GET /reef/tree — has system prompt", async () => {
    const { data } = await json("/reef/tree");
    expect(data.root).toBeTruthy();
    const nodes = data.nodes || {};
    const root = nodes[data.root];
    expect(root.role).toBe("system");
  });

  test("GET /reef/tasks — empty initially", async () => {
    const { data } = await json("/reef/tasks");
    expect(data.tasks).toEqual([]);
  });

  test("POST /reef/submit — 400 without task", async () => {
    const { status } = await json("/reef/submit", { method: "POST", body: {} });
    expect(status).toBe(400);
  });

  test("requires auth", async () => {
    const { status } = await json("/reef/state", { auth: false });
    expect(status).toBe(401);
  });

  test("GET /health still works", async () => {
    await setup;
    const res = await app.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
  });

  test("GET /reef/events — SSE connects", async () => {
    await setup;
    const res = await app.fetch(new Request("http://localhost/reef/events", { headers }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });

  test("GET /reef/tasks/:name — 404 for unknown", async () => {
    const { status } = await json("/reef/tasks/nope");
    expect(status).toBe(404);
  });
});
