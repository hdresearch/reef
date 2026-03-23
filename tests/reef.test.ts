/**
 * Reef core route tests — profile, upload, disk, state, conversations.
 *
 * Uses createReef() directly — no port binding, no agent spawning.
 * Tests the HTTP API surface for headless operation.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createReef } from "../src/reef.js";

const AUTH_TOKEN = "test-token-reef";
const DATA_DIR = join(import.meta.dir, ".tmp-reef-data");
const STORE_PATH = join(DATA_DIR, "store.json");

const ORIGINAL_ENV = {
  VERS_AUTH_TOKEN: process.env.VERS_AUTH_TOKEN,
  REEF_DATA_DIR: process.env.REEF_DATA_DIR,
  SERVICES_DIR: process.env.SERVICES_DIR,
};

function restoreEnv() {
  for (const [key, val] of Object.entries(ORIGINAL_ENV)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

async function json(
  app: { fetch: (req: Request) => Promise<Response> },
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean; formData?: FormData } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.body) headers["Content-Type"] = "application/json";
  if (opts.auth) headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;

  let reqBody: string | FormData | undefined;
  if (opts.formData) {
    reqBody = opts.formData;
    if (opts.auth) headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
  } else if (opts.body) {
    reqBody = JSON.stringify(opts.body);
  }

  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method: opts.method ?? "GET",
      headers: opts.formData ? { Authorization: headers.Authorization || "" } : headers,
      body: reqBody,
    }),
  );
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

beforeEach(() => {
  process.env.VERS_AUTH_TOKEN = AUTH_TOKEN;
  process.env.REEF_DATA_DIR = DATA_DIR;
  process.env.SERVICES_DIR = join(import.meta.dir, "../services");
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  // Clean store.json used by profile (reads from CWD/data/store.json)
  if (existsSync("data/store.json")) {
    const store = JSON.parse(readFileSync("data/store.json", "utf-8"));
    delete store["reef:profile"];
    const { writeFileSync: wfs } = require("node:fs");
    wfs("data/store.json", JSON.stringify(store, null, 2));
  }
});

afterEach(() => {
  restoreEnv();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// =============================================================================
// Profile
// =============================================================================

describe("profile", () => {
  test("GET /reef/profile returns empty profile initially", async () => {
    const { app } = await createReef();
    const { status, data } = await json(app, "/reef/profile", { auth: true });
    expect(status).toBe(200);
    expect(data).toEqual({});
  });

  test("PUT /reef/profile sets profile fields", async () => {
    const { app } = await createReef();

    const { status, data } = await json(app, "/reef/profile", {
      method: "PUT",
      body: { name: "Pranav", timezone: "America/New_York", location: "NYC" },
      auth: true,
    });
    expect(status).toBe(200);
    expect(data.name).toBe("Pranav");
    expect(data.timezone).toBe("America/New_York");
    expect(data.location).toBe("NYC");
  });

  test("PUT /reef/profile merges with existing profile", async () => {
    const { app } = await createReef();

    await json(app, "/reef/profile", {
      method: "PUT",
      body: { name: "Pranav", timezone: "America/New_York" },
      auth: true,
    });

    const { data } = await json(app, "/reef/profile", {
      method: "PUT",
      body: { location: "San Francisco" },
      auth: true,
    });
    expect(data.name).toBe("Pranav");
    expect(data.timezone).toBe("America/New_York");
    expect(data.location).toBe("San Francisco");
  });

  test("PUT /reef/profile removes empty string fields", async () => {
    const { app } = await createReef();

    await json(app, "/reef/profile", {
      method: "PUT",
      body: { name: "Pranav", location: "NYC" },
      auth: true,
    });

    const { data } = await json(app, "/reef/profile", {
      method: "PUT",
      body: { location: "" },
      auth: true,
    });
    expect(data.name).toBe("Pranav");
    expect(data.location).toBeUndefined();
  });

  test("profile is persisted in the store file", async () => {
    const { app } = await createReef();

    await json(app, "/reef/profile", {
      method: "PUT",
      body: { name: "Test User" },
      auth: true,
    });

    // writeProfile uses "data/store.json" relative to CWD
    const storePath = "data/store.json";
    expect(existsSync(storePath)).toBe(true);
    const store = JSON.parse(readFileSync(storePath, "utf-8"));
    expect(store["reef:profile"].value.name).toBe("Test User");
  });

  test("GET /reef/profile/_panel returns HTML form", async () => {
    const { app } = await createReef();
    const res = await app.fetch(
      new Request("http://localhost/reef/profile/_panel", {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("profile-form");
    expect(html).toContain("timezone");
  });
});

// =============================================================================
// Disk
// =============================================================================

describe("disk", () => {
  test("GET /reef/disk returns disk usage info", async () => {
    const { app } = await createReef();
    const { status, data } = await json(app, "/reef/disk", { auth: true });
    expect(status).toBe(200);
    expect(typeof data.totalMib).toBe("number");
    expect(typeof data.usedMib).toBe("number");
    expect(typeof data.availMib).toBe("number");
    expect(data.totalMib).toBeGreaterThan(0);
  });

  test("POST /reef/disk/resize rejects missing fs_size_mib", async () => {
    process.env.VERS_VM_ID = "test-vm-id";
    const { app } = await createReef();
    const { status, data } = await json(app, "/reef/disk/resize", {
      method: "POST",
      body: {},
      auth: true,
    });
    expect(status).toBe(400);
    expect(data.error).toContain("fs_size_mib");
  });

  test("POST /reef/disk/resize rejects without VERS_VM_ID", async () => {
    delete process.env.VERS_VM_ID;
    const { app } = await createReef();
    const { status, data } = await json(app, "/reef/disk/resize", {
      method: "POST",
      body: { fs_size_mib: 16384 },
      auth: true,
    });
    expect(status).toBe(400);
    expect(data.error).toContain("VERS_VM_ID");
  });
});

// =============================================================================
// Upload
// =============================================================================

describe("upload", () => {
  test("POST /reef/upload rejects non-multipart requests", async () => {
    const { app } = await createReef();
    const { status, data } = await json(app, "/reef/upload", {
      method: "POST",
      body: { file: "not a file" },
      auth: true,
    });
    expect(status).toBe(400);
    expect(data.error).toContain("multipart");
  });

  test("POST /reef/upload handles multipart file upload", async () => {
    const { app } = await createReef();

    const formData = new FormData();
    formData.append("file", new File(["hello world"], "test.txt", { type: "text/plain" }));

    const res = await app.fetch(
      new Request("http://localhost/reef/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
        body: formData,
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.files).toHaveLength(1);
    expect(data.files[0].name).toBe("test.txt");
    expect(data.files[0].size).toBe(11);
    expect(existsSync(data.files[0].path)).toBe(true);

    const content = readFileSync(data.files[0].path, "utf-8");
    expect(content).toBe("hello world");
  });

  test("POST /reef/upload handles multiple files", async () => {
    const { app } = await createReef();

    const formData = new FormData();
    formData.append("file", new File(["aaa"], "a.txt", { type: "text/plain" }));
    formData.append("file", new File(["bbb"], "b.txt", { type: "text/plain" }));

    const res = await app.fetch(
      new Request("http://localhost/reef/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
        body: formData,
      }),
    );
    const data = await res.json();
    expect(data.files).toHaveLength(2);
  });
});

// =============================================================================
// State
// =============================================================================

describe("state", () => {
  test("GET /reef/state returns status info", async () => {
    const { app } = await createReef();
    const { status, data } = await json(app, "/reef/state", { auth: true });
    expect(status).toBe(200);
    expect(data.mode).toBe("agent");
    expect(typeof data.activeTasks).toBe("number");
    expect(typeof data.conversations).toBe("number");
    expect(Array.isArray(data.services)).toBe(true);
  });
});

// =============================================================================
// Conversations (headless operation)
// =============================================================================

describe("conversations", () => {
  test("GET /reef/conversations returns empty list initially", async () => {
    const { app } = await createReef();
    const { status, data } = await json(app, "/reef/conversations", { auth: true });
    expect(status).toBe(200);
    expect(data.conversations).toEqual([]);
  });

  test("GET /reef/tree returns tree structure", async () => {
    const { app } = await createReef();
    const { status, data } = await json(app, "/reef/tree", { auth: true });
    expect(status).toBe(200);
    expect(data.nodes).toBeDefined();
    expect(data.refs).toBeDefined();
  });
});
