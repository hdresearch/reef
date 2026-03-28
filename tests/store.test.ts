import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "../src/core/server.js";
import store from "../services/store/index.js";
import vmTree from "../services/vm-tree/index.js";

const AUTH_TOKEN = "store-test-token";

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
  process.env.VERS_VM_ID = `vm-root-store-${Date.now()}`;
  process.env.VERS_AGENT_NAME = "root-reef";
  process.env.VERS_AUTH_TOKEN = AUTH_TOKEN;
});

afterEach(() => {
  delete process.env.VERS_VM_ID;
  delete process.env.VERS_AGENT_NAME;
  delete process.env.VERS_AUTH_TOKEN;
});

describe("store coordination helpers", () => {
  test("lists keys by prefix with owner metadata and optional values", async () => {
    const server = await createServer({ modules: [vmTree, store] });

    await json(server.app, "/store/peer-a%3Acoord%2Fagent%2Fpeer-a-ready", {
      method: "PUT",
      body: { value: { ready: true } },
      headers: {
        "X-Reef-Agent-Name": "peer-a",
        "X-Reef-Category": "agent_vm",
      },
    });

    await json(server.app, "/store/peer-b%3Acoord%2Fagent%2Fpeer-b-ready", {
      method: "PUT",
      body: { value: { ready: true } },
      headers: {
        "X-Reef-Agent-Name": "peer-b",
        "X-Reef-Category": "agent_vm",
      },
    });

    const result = await json(server.app, "/store?prefix=coord%2Fagent%2F&includeValues=1&limit=10");
    expect(result.status).toBe(200);
    expect(result.data.keys).toHaveLength(2);
    expect(result.data.keys[0]).toMatchObject({ value: { ready: true } });
    expect(result.data.keys.map((k: any) => k.key).sort()).toEqual([
      "peer-a:coord/agent/peer-a-ready",
      "peer-b:coord/agent/peer-b-ready",
    ]);
    expect(result.data.keys.map((k: any) => k.agentName).sort()).toEqual(["peer-a", "peer-b"]);
  });

  test("waits for prefix count barriers without manual polling loops", async () => {
    const server = await createServer({ modules: [vmTree, store] });

    setTimeout(() => {
      request(server.app, "/store/swarm-a1%3Acoord%2Fswarm%2Fswarm-a1-ready", {
        method: "PUT",
        body: { value: { ready: true } },
        headers: {
          "X-Reef-Agent-Name": "swarm-a1",
          "X-Reef-Category": "swarm_vm",
        },
      });
    }, 25);

    setTimeout(() => {
      request(server.app, "/store/swarm-a2%3Acoord%2Fswarm%2Fswarm-a2-ready", {
        method: "PUT",
        body: { value: { ready: true } },
        headers: {
          "X-Reef-Agent-Name": "swarm-a2",
          "X-Reef-Category": "swarm_vm",
        },
      });
    }, 50);

    const result = await json(server.app, "/store/wait", {
      method: "POST",
      body: {
        prefix: "coord/swarm/",
        minCount: 2,
        timeoutSeconds: 1,
      },
    });

    expect(result.status).toBe(200);
    expect(result.data.matched).toBe(true);
    expect(result.data.timedOut).toBe(false);
    expect(result.data.entries).toHaveLength(2);
  });

  test("waits for an exact key to reach a specific value", async () => {
    const server = await createServer({ modules: [vmTree, store] });

    setTimeout(() => {
      request(server.app, "/store/peer-b%3Acoord%2Fphase", {
        method: "PUT",
        body: { value: "ready" },
        headers: {
          "X-Reef-Agent-Name": "peer-b",
          "X-Reef-Category": "agent_vm",
        },
      });
    }, 25);

    const result = await json(server.app, "/store/wait", {
      method: "POST",
      body: {
        key: "peer-b:coord/phase",
        equals: "ready",
        timeoutSeconds: 1,
      },
    });

    expect(result.status).toBe(200);
    expect(result.data.matched).toBe(true);
    expect(result.data.timedOut).toBe(false);
    expect(result.data.entries).toHaveLength(1);
    expect(result.data.entries[0]).toMatchObject({
      key: "peer-b:coord/phase",
      value: "ready",
      agentName: "peer-b",
    });
  });
});
