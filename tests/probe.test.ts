import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import probe from "../services/probe/index.js";
import { probeSqliteWithPython } from "../services/probe/index.js";

const TMP_DIR = join(import.meta.dir, ".tmp-probe");

function collectTools(mod: { registerTools?: Function }) {
  const tools = new Map<string, any>();
  mod.registerTools?.(
    {
      registerTool(spec: any) {
        tools.set(spec.name, spec);
      },
    },
    {
      api: async () => ({}),
      getBaseUrl: () => "https://reef.example",
      agentName: "agent-probe",
      vmId: "vm-probe",
      agentRole: "worker",
      agentCategory: "agent_vm",
      isChildAgent: true,
      ok: (text: string, details?: Record<string, unknown>) => ({
        content: [{ type: "text" as const, text }],
        details,
      }),
      err: (text: string) => ({
        content: [{ type: "text" as const, text }],
        isError: true,
      }),
      noUrl: () => ({
        content: [{ type: "text" as const, text: "no url" }],
        isError: true,
      }),
    },
  );
  return tools;
}

beforeEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("reef_schema_probe", () => {
  test("inspects sqlite tables, columns, and sample rows", async () => {
    const dbPath = join(TMP_DIR, "idol.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE pull_requests (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        state TEXT NOT NULL
      );
      INSERT INTO pull_requests (title, state) VALUES ('Ship usage panel', 'open');
    `);
    db.close();

    const tools = collectTools(probe);
    const tool = tools.get("reef_schema_probe");
    expect(tool).toBeDefined();

    const tables = await tool.execute(
      "call-1",
      { engine: "sqlite", path: "idol.sqlite", action: "tables" },
      undefined,
      undefined,
      { cwd: TMP_DIR },
    );
    expect(tables.isError).toBeUndefined();
    expect(tables.content[0].text).toContain("pull_requests");

    const describe = await tool.execute(
      "call-2",
      { engine: "sqlite", path: "idol.sqlite", action: "describe", target: "pull_requests" },
      undefined,
      undefined,
      { cwd: TMP_DIR },
    );
    expect(describe.content[0].text).toContain('"name": "title"');

    const sample = await tool.execute(
      "call-3",
      { engine: "sqlite", path: "idol.sqlite", action: "sample", target: "pull_requests", limit: 1 },
      undefined,
      undefined,
      { cwd: TMP_DIR },
    );
    expect(sample.content[0].text).toContain("Ship usage panel");
  });

  test("python sqlite fallback returns tables, columns, and rows", async () => {
    const dbPath = join(TMP_DIR, "idol-python.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE contributors (
        id INTEGER PRIMARY KEY,
        login TEXT NOT NULL,
        commits INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO contributors (login, commits) VALUES ('pranav', 42);
    `);
    db.close();

    const tables = await probeSqliteWithPython(dbPath, "tables", undefined, 5, TMP_DIR);
    expect(tables).toEqual([{ name: "contributors" }]);

    const describe = await probeSqliteWithPython(dbPath, "describe", "contributors", 5, TMP_DIR);
    expect(describe).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "login", type: "TEXT" }),
        expect.objectContaining({ name: "commits", type: "INTEGER" }),
      ]),
    );

    const sample = await probeSqliteWithPython(dbPath, "sample", "contributors", 1, TMP_DIR);
    expect(sample).toEqual([{ id: 1, login: "pranav", commits: 42 }]);
  });
});
