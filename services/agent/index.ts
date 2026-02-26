/**
 * Agent service — run tasks using pi as the coding agent.
 *
 * Spawns `pi -p` (print mode) with a task, streams output, tracks runs.
 * Pi already has read/write/edit/bash tools. If reef is installed as a
 * pi package, the agent also gets fleet tools.
 *
 *   POST   /agent/tasks          — submit a task
 *   GET    /agent/tasks          — list runs
 *   GET    /agent/tasks/:id      — get run status + output
 *   POST   /agent/tasks/:id/cancel — cancel a running task
 *
 * The agent can curl reef's own API to reload services it creates:
 *   curl -X POST localhost:3000/services/reload/new-service
 *
 * Config (env vars):
 *   PI_PATH        — path to pi binary (default: "pi")
 *   PI_MODEL       — model to use (default: "claude-sonnet-4-20250514")
 *   PI_PROVIDER    — provider (default: "anthropic")
 */

import { Hono } from "hono";
import { spawn, type ChildProcess } from "node:child_process";
import { ulid } from "ulid";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ServiceModule, ServiceContext } from "../src/core/types.js";

let ctx: ServiceContext;

// =============================================================================
// Run tracking
// =============================================================================

interface Run {
  id: string;
  task: string;
  status: "running" | "done" | "error" | "cancelled";
  output: string;
  pid?: number;
  createdAt: string;
  finishedAt?: string;
  exitCode?: number | null;
}

const runs = new Map<string, Run>();
const processes = new Map<string, ChildProcess>();

// =============================================================================
// Build the system prompt append
// =============================================================================

function buildContext(projectRoot: string, port: number): string {
  const lines: string[] = [];

  lines.push(`You are working inside a reef server (running on localhost:${port}).`);
  lines.push(`Project root: ${projectRoot}`);
  lines.push("");
  lines.push("## Reef conventions");
  lines.push("- Service modules go in services/<name>/index.ts");
  lines.push("- Each module default-exports a ServiceModule (see src/core/types.ts)");
  lines.push("- After writing a service, reload it:");
  lines.push(`  curl -X POST localhost:${port}/services/reload/<name> -H "Authorization: Bearer $VERS_AUTH_TOKEN"`);
  lines.push("- Example services are in examples/services/");
  lines.push("- The create-service skill has full documentation");
  lines.push("");

  // Include the create-service skill if available
  const skillPath = join(projectRoot, "skills/create-service/SKILL.md");
  if (existsSync(skillPath)) {
    const skill = readFileSync(skillPath, "utf-8");
    lines.push("## Create-service skill reference");
    lines.push("");
    lines.push(skill);
  }

  return lines.join("\n");
}

// =============================================================================
// Spawn pi
// =============================================================================

function spawnPi(
  run: Run,
  projectRoot: string,
  port: number,
): ChildProcess {
  const piPath = process.env.PI_PATH || "pi";
  const model = process.env.PI_MODEL || "claude-sonnet-4-20250514";
  const provider = process.env.PI_PROVIDER || "anthropic";
  const contextText = buildContext(projectRoot, port);

  const args = [
    "-p",                               // print mode — non-interactive
    "--no-session",                      // ephemeral, no session file
    "--provider", provider,
    "--model", model,
    "--append-system-prompt", contextText,
    run.task,
  ];

  const child = spawn(piPath, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      // Pass through auth so pi can curl reef
      VERS_AUTH_TOKEN: process.env.VERS_AUTH_TOKEN || "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    run.output += chunk.toString();
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    run.output += chunk.toString();
  });

  child.on("close", (code) => {
    run.exitCode = code;
    run.finishedAt = new Date().toISOString();

    if (run.status === "cancelled") {
      // Already cancelled, don't overwrite
    } else if (code === 0) {
      run.status = "done";
    } else {
      run.status = "error";
    }

    processes.delete(run.id);
  });

  child.on("error", (err) => {
    run.output += `\nProcess error: ${err.message}`;
    run.status = "error";
    run.finishedAt = new Date().toISOString();
    processes.delete(run.id);
  });

  return child;
}

// =============================================================================
// Routes
// =============================================================================

const routes = new Hono();

routes.post("/tasks", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const task = (body.task as string)?.trim();

  if (!task) {
    return c.json({ error: "task is required" }, 400);
  }

  // Check pi is available
  const piPath = process.env.PI_PATH || "pi";
  try {
    const { execSync } = await import("node:child_process");
    execSync(`${piPath} --help`, { stdio: "ignore", timeout: 5000 });
  } catch {
    return c.json({ error: `pi not found at "${piPath}". Set PI_PATH env var.` }, 500);
  }

  const id = ulid();
  const port = parseInt(process.env.PORT || "3000", 10);
  const projectRoot = process.cwd();

  const run: Run = {
    id,
    task,
    status: "running",
    output: "",
    createdAt: new Date().toISOString(),
  };

  runs.set(id, run);

  const child = spawnPi(run, projectRoot, port);
  run.pid = child.pid;
  processes.set(id, child);

  console.log(`  [agent] started run ${id}: ${task.slice(0, 80)}${task.length > 80 ? "..." : ""}`);

  return c.json({
    id: run.id,
    status: run.status,
    task: run.task,
    createdAt: run.createdAt,
  }, 201);
});

routes.get("/tasks", (c) => {
  const items = Array.from(runs.values()).map((r) => ({
    id: r.id,
    task: r.task,
    status: r.status,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
  }));

  // Most recent first
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return c.json({ runs: items, count: items.length });
});

routes.get("/tasks/:id", (c) => {
  const id = c.req.param("id");
  const run = runs.get(id);

  if (!run) {
    return c.json({ error: "run not found" }, 404);
  }

  // Support ?tail=N to get last N characters of output
  const tail = parseInt(c.req.query("tail") || "0", 10);
  const output = tail > 0 ? run.output.slice(-tail) : run.output;

  return c.json({
    ...run,
    output,
    outputLength: run.output.length,
  });
});

routes.post("/tasks/:id/cancel", (c) => {
  const id = c.req.param("id");
  const run = runs.get(id);

  if (!run) {
    return c.json({ error: "run not found" }, 404);
  }

  if (run.status !== "running") {
    return c.json({ error: `run is already ${run.status}` }, 400);
  }

  const child = processes.get(id);
  if (child) {
    child.kill("SIGTERM");
    // Give it a moment, then force kill
    setTimeout(() => {
      if (processes.has(id)) {
        child.kill("SIGKILL");
      }
    }, 5000);
  }

  run.status = "cancelled";
  run.finishedAt = new Date().toISOString();

  console.log(`  [agent] cancelled run ${id}`);

  return c.json({ id, status: "cancelled" });
});

// =============================================================================
// Module
// =============================================================================

const agent: ServiceModule = {
  name: "agent",
  description: "Run tasks using pi as the coding agent",
  routes,

  init(serviceCtx: ServiceContext) {
    ctx = serviceCtx;
  },

  routeDocs: {
    "POST /tasks": {
      summary: "Submit a task for the agent to execute",
      detail:
        "Spawns a pi agent in print mode to accomplish the task. " +
        "The agent has full read/write/edit/bash tools and can reload " +
        "services via reef's API. Returns immediately with a run ID.",
      body: {
        task: {
          type: "string",
          required: true,
          description: "What you want the agent to do",
        },
      },
      response: "{ id, status: 'running', task, createdAt }",
    },
    "GET /tasks": {
      summary: "List all runs",
      response: "{ runs: [{ id, task, status, createdAt, finishedAt? }], count }",
    },
    "GET /tasks/:id": {
      summary: "Get run status and output",
      detail: "Use ?tail=N to get just the last N characters of output.",
      params: {
        id: { type: "string", required: true, description: "Run ID" },
      },
      query: {
        tail: {
          type: "number",
          description: "Return only the last N characters of output",
        },
      },
      response: "{ id, task, status, output, outputLength, createdAt, finishedAt?, exitCode? }",
    },
    "POST /tasks/:id/cancel": {
      summary: "Cancel a running task",
      params: {
        id: { type: "string", required: true, description: "Run ID" },
      },
      response: "{ id, status: 'cancelled' }",
    },
  },
};

export default agent;
