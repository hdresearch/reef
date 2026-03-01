/**
 * Cron service — schedule recurring jobs.
 *
 * Job types:
 *   - agent: posts a task to /reef/submit with a prompt
 *   - http: makes an HTTP request to a reef endpoint
 *   - exec: runs a shell command via Bun.spawn
 *
 * Schedule formats:
 *   - Cron syntax: '* /5 * * * *' (5 standard fields)
 *   - Simple intervals: '30s', '5m', '1h', '1d'
 *
 * Storage: data/cron-jobs.json (loaded on init, saved on change)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { ulid } from "ulid";
import type { ServiceContext, ServiceModule } from "../../src/core/types.js";

// =============================================================================
// Types
// =============================================================================

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  type: "agent" | "http" | "exec";
  config: AgentConfig | HttpConfig | ExecConfig;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AgentConfig {
  prompt: string;
}

interface HttpConfig {
  method: string;
  path: string;
  body?: unknown;
}

interface ExecConfig {
  command: string;
}

interface RunRecord {
  id: string;
  jobId: string;
  jobName: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "success" | "error";
  output?: string;
  error?: string;
}

// =============================================================================
// Cron expression parser
// =============================================================================

/**
 * Parse a single cron field against a value.
 * Supports: * (any), N (exact), * /N (every N)
 */
function matchCronField(field: string, value: number, max: number): boolean {
  field = field.trim();
  if (field === "*") return true;

  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    if (Number.isNaN(step) || step <= 0) return false;
    return value % step === 0;
  }

  // Comma-separated values
  if (field.includes(",")) {
    return field.split(",").some((f) => matchCronField(f.trim(), value, max));
  }

  const num = parseInt(field, 10);
  if (Number.isNaN(num)) return false;
  return value === num;
}

/**
 * Check whether a cron expression matches the given date.
 * Format: minute hour day-of-month month day-of-week
 */
function matchesCron(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // 1-12
  const dayOfWeek = date.getDay(); // 0=Sun

  return (
    matchCronField(parts[0], minute, 59) &&
    matchCronField(parts[1], hour, 23) &&
    matchCronField(parts[2], dayOfMonth, 31) &&
    matchCronField(parts[3], month, 12) &&
    matchCronField(parts[4], dayOfWeek, 6)
  );
}

/**
 * Compute the next time a cron expression matches, starting from `after`.
 * Scans minute-by-minute up to 366 days out.
 */
function nextCronRun(expr: string, after: Date): Date | null {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  const limit = 366 * 24 * 60; // max minutes to scan
  for (let i = 0; i < limit; i++) {
    if (matchesCron(expr, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// =============================================================================
// Interval parser
// =============================================================================

/**
 * Parse a simple interval string like '30s', '5m', '1h', '1d' to milliseconds.
 * Returns null if not a valid interval.
 */
function parseInterval(s: string): number | null {
  const m = s.trim().match(/^(\d+)(s|m|h|d)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n <= 0) return null;
  switch (m[2]) {
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    default:
      return null;
  }
}

/**
 * Determine if a schedule string is a cron expression or a simple interval.
 */
function isInterval(schedule: string): boolean {
  return parseInterval(schedule) !== null;
}

/**
 * Get the next run time for a schedule (cron or interval) after the given date.
 */
function getNextRunTime(schedule: string, after: Date): Date | null {
  const ms = parseInterval(schedule);
  if (ms !== null) {
    return new Date(after.getTime() + ms);
  }
  return nextCronRun(schedule, after);
}

// =============================================================================
// State
// =============================================================================

let dataFilePath = "";
let _ctx: ServiceContext | null = null;

const jobs = new Map<string, CronJob>();
const runHistory = new Map<string, RunRecord[]>(); // jobId -> runs (max 20)
const timers = new Map<string, ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>();

const MAX_RUNS_PER_JOB = 20;

// =============================================================================
// Persistence
// =============================================================================

function loadJobs(): void {
  if (!dataFilePath) return;
  try {
    if (existsSync(dataFilePath)) {
      const raw = JSON.parse(readFileSync(dataFilePath, "utf-8"));
      const list: CronJob[] = Array.isArray(raw) ? raw : (raw.jobs ?? []);
      for (const job of list) {
        jobs.set(job.id, job);
      }
    }
  } catch (err) {
    console.error(`  [cron] failed to load jobs: ${err}`);
  }
}

function saveJobs(): void {
  if (!dataFilePath) return;
  try {
    const dir = join(dataFilePath, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(dataFilePath, JSON.stringify({ jobs: Array.from(jobs.values()) }, null, 2));
  } catch (err) {
    console.error(`  [cron] failed to save jobs: ${err}`);
  }
}

// =============================================================================
// Job execution
// =============================================================================

function addRun(run: RunRecord): void {
  let list = runHistory.get(run.jobId);
  if (!list) {
    list = [];
    runHistory.set(run.jobId, list);
  }
  list.push(run);
  if (list.length > MAX_RUNS_PER_JOB) list.shift();
}

function getPort(): number {
  return parseInt(process.env.PORT || "3000", 10);
}

function getAuthToken(): string {
  return process.env.VERS_AUTH_TOKEN || "";
}

async function executeJob(job: CronJob): Promise<RunRecord> {
  const run: RunRecord = {
    id: ulid(),
    jobId: job.id,
    jobName: job.name,
    startedAt: new Date().toISOString(),
    status: "running",
  };
  addRun(run);

  try {
    switch (job.type) {
      case "agent": {
        const cfg = job.config as AgentConfig;
        const port = getPort();
        const token = getAuthToken();
        const res = await fetch(`http://localhost:${port}/reef/submit`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ task: cfg.prompt }),
        });
        run.output = JSON.stringify(await res.json());
        run.status = res.ok ? "success" : "error";
        if (!res.ok) run.error = `HTTP ${res.status}`;
        break;
      }

      case "http": {
        const cfg = job.config as HttpConfig;
        const port = getPort();
        const token = getAuthToken();
        const url = `http://localhost:${port}${cfg.path}`;
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
        };
        let body: string | undefined;
        if (cfg.body) {
          headers["Content-Type"] = "application/json";
          body = JSON.stringify(cfg.body);
        }
        const res = await fetch(url, {
          method: cfg.method.toUpperCase(),
          headers,
          body,
        });
        const text = await res.text();
        run.output = text.slice(0, 10000);
        run.status = res.ok ? "success" : "error";
        if (!res.ok) run.error = `HTTP ${res.status}`;
        break;
      }

      case "exec": {
        const cfg = job.config as ExecConfig;
        const proc = Bun.spawn(["sh", "-c", cfg.command], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        run.output = (stdout + stderr).slice(0, 10000);
        run.status = exitCode === 0 ? "success" : "error";
        if (exitCode !== 0) run.error = `exit code ${exitCode}`;
        break;
      }

      default:
        run.status = "error";
        run.error = `Unknown job type: ${job.type}`;
    }
  } catch (err: any) {
    run.status = "error";
    run.error = err.message || String(err);
  }

  run.completedAt = new Date().toISOString();
  return run;
}

// =============================================================================
// Scheduling
// =============================================================================

function scheduleJob(job: CronJob): void {
  clearJobTimer(job.id);
  if (!job.enabled) return;

  const interval = parseInterval(job.schedule);
  if (interval !== null) {
    // Simple interval — use setInterval
    const timer = setInterval(() => {
      executeJob(job);
    }, interval);
    timers.set(job.id, timer);
  } else {
    // Cron expression — use recursive setTimeout, checking each minute
    scheduleCronTick(job);
  }
}

function scheduleCronTick(job: CronJob): void {
  // Find next matching minute
  const now = new Date();
  const next = nextCronRun(job.schedule, now);
  if (!next) return;

  const delay = next.getTime() - now.getTime();
  const timer = setTimeout(() => {
    executeJob(job);
    // Schedule the next tick
    if (job.enabled && jobs.has(job.id)) {
      scheduleCronTick(job);
    }
  }, delay);
  timers.set(job.id, timer);
}

function clearJobTimer(jobId: string): void {
  const timer = timers.get(jobId);
  if (timer !== undefined) {
    clearTimeout(timer as any);
    clearInterval(timer as any);
    timers.delete(jobId);
  }
}

function clearAllTimers(): void {
  for (const [id] of timers) {
    clearJobTimer(id);
  }
}

function scheduleAllJobs(): void {
  for (const job of jobs.values()) {
    scheduleJob(job);
  }
}

// =============================================================================
// Validation
// =============================================================================

function validateSchedule(schedule: string): string | null {
  if (parseInterval(schedule) !== null) return null;
  // Try to parse as cron
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return "Cron expression must have 5 fields: minute hour day-of-month month day-of-week";
  for (const part of parts) {
    if (part === "*") continue;
    if (part.startsWith("*/")) {
      const n = parseInt(part.slice(2), 10);
      if (Number.isNaN(n) || n <= 0) return `Invalid step value: ${part}`;
      continue;
    }
    if (part.includes(",")) {
      for (const sub of part.split(",")) {
        const n = parseInt(sub.trim(), 10);
        if (Number.isNaN(n) || n < 0) return `Invalid value: ${sub}`;
      }
      continue;
    }
    const n = parseInt(part, 10);
    if (Number.isNaN(n) || n < 0) return `Invalid value: ${part}`;
  }
  return null;
}

function validateJobType(type: string): string | null {
  if (!["agent", "http", "exec"].includes(type)) {
    return `Invalid job type: ${type}. Must be agent, http, or exec`;
  }
  return null;
}

function validateConfig(type: string, config: any): string | null {
  if (!config || typeof config !== "object") return "config is required";
  switch (type) {
    case "agent":
      if (!config.prompt || typeof config.prompt !== "string") return "config.prompt is required for agent jobs";
      break;
    case "http":
      if (!config.method || typeof config.method !== "string") return "config.method is required for http jobs";
      if (!config.path || typeof config.path !== "string") return "config.path is required for http jobs";
      break;
    case "exec":
      if (!config.command || typeof config.command !== "string") return "config.command is required for exec jobs";
      break;
  }
  return null;
}

// =============================================================================
// Routes
// =============================================================================

const routes = new Hono();

// Create a job
routes.post("/jobs", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const { name, schedule, type, config, enabled } = body;
  if (!name || typeof name !== "string") return c.json({ error: "name is required" }, 400);
  if (!schedule || typeof schedule !== "string") return c.json({ error: "schedule is required" }, 400);
  if (!type) return c.json({ error: "type is required" }, 400);

  const typeErr = validateJobType(type);
  if (typeErr) return c.json({ error: typeErr }, 400);

  const schedErr = validateSchedule(schedule);
  if (schedErr) return c.json({ error: schedErr }, 400);

  const cfgErr = validateConfig(type, config);
  if (cfgErr) return c.json({ error: cfgErr }, 400);

  const now = new Date().toISOString();
  const job: CronJob = {
    id: ulid(),
    name: name.trim(),
    schedule,
    type,
    config,
    enabled: enabled !== false,
    createdAt: now,
    updatedAt: now,
  };

  jobs.set(job.id, job);
  saveJobs();
  scheduleJob(job);

  return c.json(job, 201);
});

// List all jobs
routes.get("/jobs", (c) => {
  const now = new Date();
  const list = Array.from(jobs.values()).map((job) => ({
    ...job,
    nextRunAt: job.enabled ? (getNextRunTime(job.schedule, now)?.toISOString() ?? null) : null,
  }));
  return c.json({ jobs: list, count: list.length });
});

// Get a job with run history
routes.get("/jobs/:id", (c) => {
  const job = jobs.get(c.req.param("id"));
  if (!job) return c.json({ error: "Job not found" }, 404);

  const now = new Date();
  const runs = (runHistory.get(job.id) ?? []).slice().reverse();
  return c.json({
    ...job,
    nextRunAt: job.enabled ? (getNextRunTime(job.schedule, now)?.toISOString() ?? null) : null,
    runs,
  });
});

// Update a job (enable/disable, change schedule)
routes.patch("/jobs/:id", async (c) => {
  const job = jobs.get(c.req.param("id"));
  if (!job) return c.json({ error: "Job not found" }, 404);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  if (body.schedule !== undefined) {
    const err = validateSchedule(body.schedule);
    if (err) return c.json({ error: err }, 400);
    job.schedule = body.schedule;
  }

  if (body.enabled !== undefined) {
    job.enabled = !!body.enabled;
  }

  if (body.name !== undefined) {
    job.name = String(body.name).trim();
  }

  if (body.type !== undefined) {
    const err = validateJobType(body.type);
    if (err) return c.json({ error: err }, 400);
    job.type = body.type;
  }

  if (body.config !== undefined) {
    const err = validateConfig(body.type ?? job.type, body.config);
    if (err) return c.json({ error: err }, 400);
    job.config = body.config;
  }

  job.updatedAt = new Date().toISOString();
  saveJobs();
  scheduleJob(job);

  return c.json(job);
});

// Delete a job
routes.delete("/jobs/:id", (c) => {
  const id = c.req.param("id");
  const job = jobs.get(id);
  if (!job) return c.json({ error: "Job not found" }, 404);

  clearJobTimer(id);
  jobs.delete(id);
  runHistory.delete(id);
  saveJobs();

  return c.json({ id, deleted: true });
});

// Trigger a job immediately
routes.post("/jobs/:id/run", async (c) => {
  const job = jobs.get(c.req.param("id"));
  if (!job) return c.json({ error: "Job not found" }, 404);

  const run = await executeJob(job);
  return c.json(run);
});

// Recent runs across all jobs
routes.get("/runs", (c) => {
  const allRuns: RunRecord[] = [];
  for (const runs of runHistory.values()) {
    allRuns.push(...runs);
  }
  allRuns.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return c.json({ runs: allRuns.slice(0, 100), count: allRuns.length });
});

// HTML panel
routes.get("/_panel", (c) => {
  const now = new Date();
  const jobList = Array.from(jobs.values());

  const jobRows = jobList
    .map((job) => {
      const nextRun = job.enabled ? (getNextRunTime(job.schedule, now)?.toISOString() ?? "—") : "disabled";
      const runs = (runHistory.get(job.id) ?? []).slice(-5).reverse();
      const recentHtml = runs.length
        ? runs
            .map((r) => {
              const statusColor = r.status === "success" ? "#4caf50" : r.status === "error" ? "#f44336" : "#ff9800";
              return `<span style="color:${statusColor}" title="${r.error || r.output || ""}">${r.status}</span>`;
            })
            .join(", ")
        : "<em>none</em>";

      return `<tr>
      <td>${job.name}</td>
      <td><code>${job.schedule}</code></td>
      <td>${job.type}</td>
      <td>${job.enabled ? "✅" : "❌"}</td>
      <td>${nextRun}</td>
      <td>${recentHtml}</td>
    </tr>`;
    })
    .join("\n");

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Cron Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #1a1a2e; color: #e0e0e0; }
    h1 { color: #64b5f6; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    th, td { padding: 0.6rem 1rem; text-align: left; border-bottom: 1px solid #333; }
    th { background: #16213e; color: #90caf9; }
    tr:hover { background: #1a1a3e; }
    code { background: #2a2a4a; padding: 0.15rem 0.4rem; border-radius: 3px; }
    em { color: #888; }
    .count { color: #888; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>⏰ Cron Jobs</h1>
  <p class="count">${jobList.length} job${jobList.length !== 1 ? "s" : ""} configured</p>
  <table>
    <thead>
      <tr><th>Name</th><th>Schedule</th><th>Type</th><th>Enabled</th><th>Next Run</th><th>Recent</th></tr>
    </thead>
    <tbody>
      ${jobRows || '<tr><td colspan="6"><em>No jobs configured</em></td></tr>'}
    </tbody>
  </table>
</body>
</html>`;

  return c.html(html);
});

// =============================================================================
// Module export
// =============================================================================

const cron: ServiceModule = {
  name: "cron",
  description: "Schedule recurring jobs — cron expressions and simple intervals",
  routes,

  init(serviceCtx: ServiceContext) {
    _ctx = serviceCtx;
    // Resolve data file path relative to project root (parent of servicesDir)
    const projectRoot = resolve(serviceCtx.servicesDir, "..");
    const dataDir = join(projectRoot, "data");
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    dataFilePath = join(dataDir, "cron-jobs.json");

    loadJobs();
    scheduleAllJobs();
    console.log(`  [cron] loaded ${jobs.size} job(s) from ${dataFilePath}`);
  },

  store: {
    flush() {
      saveJobs();
    },
    async close() {
      clearAllTimers();
    },
  },

  routeDocs: {
    "POST /jobs": {
      summary: "Create a cron job",
      body: {
        name: { type: "string", required: true, description: "Job name" },
        schedule: {
          type: "string",
          required: true,
          description: "Cron expression (5 fields) or interval (e.g. 30s, 5m, 1h, 1d)",
        },
        type: { type: "string", required: true, description: "Job type: agent, http, or exec" },
        config: {
          type: "object",
          required: true,
          description: "Type-specific config. agent: {prompt}. http: {method, path, body?}. exec: {command}",
        },
        enabled: { type: "boolean", description: "Whether the job is active (default: true)" },
      },
      response: "The created job object with generated ID and timestamps",
    },
    "GET /jobs": {
      summary: "List all cron jobs with next run time",
      response: "{ jobs: [...], count }",
    },
    "GET /jobs/:id": {
      summary: "Get job details plus recent run history",
      params: { id: { type: "string", required: true, description: "Job ID" } },
      response: "{ ...job, nextRunAt, runs: [...] }",
    },
    "PATCH /jobs/:id": {
      summary: "Update a job — enable/disable, change schedule, etc.",
      params: { id: { type: "string", required: true, description: "Job ID" } },
      body: {
        enabled: { type: "boolean", description: "Enable or disable the job" },
        schedule: { type: "string", description: "New schedule" },
        name: { type: "string", description: "New name" },
        type: { type: "string", description: "New job type" },
        config: { type: "object", description: "New config" },
      },
      response: "The updated job object",
    },
    "DELETE /jobs/:id": {
      summary: "Remove a job",
      params: { id: { type: "string", required: true, description: "Job ID" } },
      response: "{ id, deleted: true }",
    },
    "POST /jobs/:id/run": {
      summary: "Trigger a job immediately",
      params: { id: { type: "string", required: true, description: "Job ID" } },
      response: "Run record with status, output/error",
    },
    "GET /runs": {
      summary: "Recent runs across all jobs (last 100)",
      response: "{ runs: [...], count }",
    },
    "GET /_panel": {
      summary: "HTML dashboard showing active jobs, next run times, and recent results",
      response: "text/html",
    },
  },

  capabilities: ["cron.schedule", "cron.execute"],
};

export default cron;

// Export internals for testing
export {
  jobs,
  runHistory,
  timers,
  clearAllTimers,
  matchCronField,
  matchesCron,
  nextCronRun,
  parseInterval,
  isInterval,
  getNextRunTime,
  executeJob,
};
export type { CronJob, AgentConfig, HttpConfig, ExecConfig, RunRecord };
