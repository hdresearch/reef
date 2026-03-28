/**
 * Probe service — inspect real local data interfaces before coding against them.
 *
 * Focused on the failure mode from idol: writing transforms against imagined
 * tables or columns instead of the actual database state.
 */

import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { FleetClient, ServiceModule } from "../../src/core/types.js";

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function runShell(command: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
    child.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
    child.on("error", (err) => rejectPromise(err));
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error((stderr || stdout || `command failed (${code})`).trim()));
    });
  });
}

async function probeDuckDb(
  dbPath: string,
  action: "tables" | "describe" | "sample",
  target: string | undefined,
  limit: number,
  cwd: string,
) {
  let sql = "";
  if (action === "tables") {
    sql =
      "SELECT table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_name;";
  } else if (action === "describe") {
    if (!target) throw new Error("target is required for describe");
    sql = `DESCRIBE SELECT * FROM ${quoteIdent(target)};`;
  } else {
    if (!target) throw new Error("target is required for sample");
    sql = `SELECT * FROM ${quoteIdent(target)} LIMIT ${Math.max(1, Math.min(limit, 50))};`;
  }

  try {
    const cli = await runShell(
      `command -v duckdb >/dev/null && duckdb -json ${JSON.stringify(dbPath)} ${JSON.stringify(sql)}`,
      cwd,
    );
    return JSON.parse(cli.stdout);
  } catch {
    const py = await runShell(
      `python3 - <<'PY'
import json, sys
try:
    import duckdb
except Exception as e:
    raise SystemExit(f"duckdb python module unavailable: {e}")
conn = duckdb.connect(${JSON.stringify(dbPath)}, read_only=True)
rows = conn.execute(${JSON.stringify(sql)}).fetchall()
cols = [d[0] for d in conn.description] if conn.description else []
print(json.dumps([dict(zip(cols, row)) for row in rows]))
PY`,
      cwd,
    );
    return JSON.parse(py.stdout);
  }
}

export async function probeSqliteWithPython(
  dbPath: string,
  action: "tables" | "describe" | "sample",
  target: string | undefined,
  limit: number,
  cwd: string,
) {
  const sql =
    action === "tables"
      ? "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
      : action === "describe"
        ? target
          ? `PRAGMA table_info(${quoteIdent(target)})`
          : ""
        : target
          ? `SELECT * FROM ${quoteIdent(target)} LIMIT ${Math.max(1, Math.min(limit, 50))}`
          : "";

  if ((action === "describe" || action === "sample") && !target) {
    throw new Error(`target is required for ${action}`);
  }

  const py = await runShell(
    `python3 - <<'PY'
import json, sqlite3
conn = sqlite3.connect(${JSON.stringify(dbPath)})
conn.row_factory = sqlite3.Row
cur = conn.cursor()
cur.execute(${JSON.stringify(sql)})
rows = cur.fetchall()
if ${JSON.stringify(action)} == "describe":
    result = [
        {
            "cid": row[0],
            "name": row[1],
            "type": row[2],
            "notnull": row[3],
            "dflt_value": row[4],
            "pk": row[5],
        }
        for row in rows
    ]
else:
    result = [dict(row) for row in rows]
print(json.dumps(result))
PY`,
    cwd,
  );
  return JSON.parse(py.stdout);
}

function probeSqliteDirect(
  dbPath: string,
  action: "tables" | "describe" | "sample",
  target: string | undefined,
  limit: number,
) {
  const db = new Database(dbPath, { readonly: true });
  try {
    if (action === "tables") {
      return db
        .query(
          "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
    }
    if (action === "describe") {
      if (!target) throw new Error("target is required for describe");
      return db.query(`PRAGMA table_info(${quoteIdent(target)})`).all();
    }
    if (!target) throw new Error("target is required for sample");
    return db.query(`SELECT * FROM ${quoteIdent(target)} LIMIT ${Math.max(1, Math.min(limit, 50))}`).all();
  } finally {
    db.close();
  }
}

function registerTools(pi: ExtensionAPI, client: FleetClient) {
  pi.registerTool({
    name: "reef_schema_probe",
    label: "Probe: Schema Reality",
    description: [
      "Inspect a real local database before writing code against it.",
      "Use this to verify tables, columns, and sample rows so you do not code against imagined upstream output.",
      "Supports SQLite directly with python fallback and DuckDB on a best-effort basis via CLI or python module.",
    ].join("\n"),
    parameters: Type.Object({
      engine: Type.Union([Type.Literal("sqlite"), Type.Literal("duckdb")], {
        description: "Database engine",
      }),
      path: Type.String({ description: "Path to the database file" }),
      action: Type.Union([Type.Literal("tables"), Type.Literal("describe"), Type.Literal("sample")], {
        description: "Inspection action",
      }),
      target: Type.Optional(Type.String({ description: "Table/view name for describe/sample" })),
      limit: Type.Optional(Type.Number({ description: "Row limit for sample (default: 5)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = resolve(ctx.cwd || process.cwd());
      const dbPath = resolve(cwd, params.path);
      if (!existsSync(dbPath)) return client.err(`Database file not found: ${dbPath}`);

      try {
        let result: unknown;
        if (params.engine === "sqlite") {
          try {
            result = probeSqliteDirect(dbPath, params.action, params.target, params.limit || 5);
          } catch {
            result = await probeSqliteWithPython(dbPath, params.action, params.target, params.limit || 5, cwd);
          }
        } else {
          result = await probeDuckDb(dbPath, params.action, params.target, params.limit || 5, cwd);
        }

        return client.ok(
          [
            `${params.engine} ${params.action}: ${dbPath}`,
            params.target ? `target: ${params.target}` : "",
            "",
            JSON.stringify(result, null, 2),
          ]
            .filter(Boolean)
            .join("\n"),
          { result, path: dbPath, engine: params.engine, action: params.action, target: params.target || null },
        );
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });
}

const probe: ServiceModule = {
  name: "probe",
  description: "Reality-check tools for local schemas and data interfaces",
  registerTools,
  capabilities: ["agent.probe"],
};

export default probe;
