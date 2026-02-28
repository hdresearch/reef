import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { createTestHarness, type TestHarness } from "../../src/core/testing.js";
import cron, {
  matchCronField,
  matchesCron,
  nextCronRun,
  parseInterval,
  getNextRunTime,
  jobs,
  runHistory,
  clearAllTimers,
} from "./index.js";

let t: TestHarness;

beforeAll(async () => {
  t = await createTestHarness({ services: [cron] });
});

afterAll(() => {
  clearAllTimers();
  jobs.clear();
  runHistory.clear();
  t?.cleanup();
});

// =============================================================================
// Cron expression parsing
// =============================================================================

describe("cron expression parsing", () => {
  test("matchCronField — wildcard", () => {
    expect(matchCronField("*", 0, 59)).toBe(true);
    expect(matchCronField("*", 30, 59)).toBe(true);
  });

  test("matchCronField — exact value", () => {
    expect(matchCronField("5", 5, 59)).toBe(true);
    expect(matchCronField("5", 6, 59)).toBe(false);
  });

  test("matchCronField — step value */N", () => {
    expect(matchCronField("*/5", 0, 59)).toBe(true);
    expect(matchCronField("*/5", 5, 59)).toBe(true);
    expect(matchCronField("*/5", 10, 59)).toBe(true);
    expect(matchCronField("*/5", 3, 59)).toBe(false);
    expect(matchCronField("*/15", 30, 59)).toBe(true);
    expect(matchCronField("*/15", 7, 59)).toBe(false);
  });

  test("matchesCron — every 5 minutes", () => {
    const d = new Date("2026-02-28T06:00:00Z");
    expect(matchesCron("*/5 * * * *", d)).toBe(true);
    d.setMinutes(3);
    expect(matchesCron("*/5 * * * *", d)).toBe(false);
  });

  test("matchesCron — specific time", () => {
    const d = new Date("2026-02-28T14:30:00Z");
    expect(matchesCron("30 14 * * *", d)).toBe(true);
    expect(matchesCron("30 15 * * *", d)).toBe(false);
  });

  test("matchesCron — day of week", () => {
    // Feb 28 2026 is Saturday = 6
    const d = new Date("2026-02-28T12:00:00Z");
    expect(matchesCron("0 12 * * 6", d)).toBe(true);
    expect(matchesCron("0 12 * * 1", d)).toBe(false);
  });

  test("matchesCron — rejects invalid expressions", () => {
    const d = new Date();
    expect(matchesCron("bad", d)).toBe(false);
    expect(matchesCron("* * *", d)).toBe(false);
  });

  test("nextCronRun finds next match", () => {
    const after = new Date("2026-02-28T06:02:00Z");
    const next = nextCronRun("*/5 * * * *", after);
    expect(next).not.toBeNull();
    expect(next!.getMinutes()).toBe(5);
    expect(next!.getHours()).toBe(6);
  });

  test("nextCronRun — specific hour", () => {
    const after = new Date("2026-02-28T06:00:00Z");
    const next = nextCronRun("0 12 * * *", after);
    expect(next).not.toBeNull();
    expect(next!.getHours()).toBe(12);
    expect(next!.getMinutes()).toBe(0);
  });
});

// =============================================================================
// Interval parsing
// =============================================================================

describe("interval parsing", () => {
  test("parses seconds", () => {
    expect(parseInterval("30s")).toBe(30000);
  });

  test("parses minutes", () => {
    expect(parseInterval("5m")).toBe(300000);
  });

  test("parses hours", () => {
    expect(parseInterval("1h")).toBe(3600000);
  });

  test("parses days", () => {
    expect(parseInterval("1d")).toBe(86400000);
  });

  test("returns null for invalid", () => {
    expect(parseInterval("abc")).toBeNull();
    expect(parseInterval("5x")).toBeNull();
    expect(parseInterval("")).toBeNull();
    expect(parseInterval("0s")).toBeNull();
  });

  test("getNextRunTime works for intervals", () => {
    const now = new Date("2026-02-28T06:00:00Z");
    const next = getNextRunTime("30s", now);
    expect(next).not.toBeNull();
    expect(next!.getTime() - now.getTime()).toBe(30000);
  });

  test("getNextRunTime works for cron", () => {
    const now = new Date("2026-02-28T06:00:00Z");
    const next = getNextRunTime("*/10 * * * *", now);
    expect(next).not.toBeNull();
    expect(next!.getMinutes()).toBe(10);
  });
});

// =============================================================================
// Job CRUD
// =============================================================================

describe("job CRUD", () => {
  test("POST /cron/jobs — create a job", async () => {
    const { status, data } = await t.json<any>("/cron/jobs", {
      method: "POST",
      auth: true,
      body: {
        name: "test-exec-job",
        schedule: "5m",
        type: "exec",
        config: { command: "echo hello" },
      },
    });
    expect(status).toBe(201);
    expect(data.id).toBeDefined();
    expect(data.name).toBe("test-exec-job");
    expect(data.schedule).toBe("5m");
    expect(data.type).toBe("exec");
    expect(data.enabled).toBe(true);
  });

  test("POST /cron/jobs — create with cron expression", async () => {
    const { status, data } = await t.json<any>("/cron/jobs", {
      method: "POST",
      auth: true,
      body: {
        name: "cron-job",
        schedule: "*/5 * * * *",
        type: "exec",
        config: { command: "echo cron" },
      },
    });
    expect(status).toBe(201);
    expect(data.schedule).toBe("*/5 * * * *");
  });

  test("POST /cron/jobs — validates type", async () => {
    const { status, data } = await t.json<any>("/cron/jobs", {
      method: "POST",
      auth: true,
      body: {
        name: "bad",
        schedule: "5m",
        type: "badtype",
        config: {},
      },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("Invalid job type");
  });

  test("POST /cron/jobs — validates schedule", async () => {
    const { status, data } = await t.json<any>("/cron/jobs", {
      method: "POST",
      auth: true,
      body: {
        name: "bad",
        schedule: "bad-schedule",
        type: "exec",
        config: { command: "echo" },
      },
    });
    expect(status).toBe(400);
  });

  test("POST /cron/jobs — validates config", async () => {
    const { status, data } = await t.json<any>("/cron/jobs", {
      method: "POST",
      auth: true,
      body: {
        name: "bad",
        schedule: "5m",
        type: "agent",
        config: {},
      },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("prompt");
  });

  test("POST /cron/jobs — validates http config", async () => {
    const { status } = await t.json<any>("/cron/jobs", {
      method: "POST",
      auth: true,
      body: {
        name: "bad-http",
        schedule: "5m",
        type: "http",
        config: { method: "GET" },
      },
    });
    expect(status).toBe(400);
  });

  test("GET /cron/jobs — list jobs", async () => {
    const { status, data } = await t.json<any>("/cron/jobs", { auth: true });
    expect(status).toBe(200);
    expect(data.jobs).toBeDefined();
    expect(data.count).toBeGreaterThanOrEqual(1);
    // Should have nextRunAt
    const enabled = data.jobs.find((j: any) => j.enabled);
    if (enabled) {
      expect(enabled.nextRunAt).toBeDefined();
    }
  });

  test("GET /cron/jobs/:id — get job", async () => {
    // Create a job first
    const { data: created } = await t.json<any>("/cron/jobs", {
      method: "POST",
      auth: true,
      body: {
        name: "get-test",
        schedule: "1h",
        type: "exec",
        config: { command: "echo get" },
      },
    });

    const { status, data } = await t.json<any>(`/cron/jobs/${created.id}`, { auth: true });
    expect(status).toBe(200);
    expect(data.id).toBe(created.id);
    expect(data.runs).toBeDefined();
    expect(Array.isArray(data.runs)).toBe(true);
  });

  test("GET /cron/jobs/:id — 404 for missing", async () => {
    const { status } = await t.json<any>("/cron/jobs/nonexistent", { auth: true });
    expect(status).toBe(404);
  });

  test("PATCH /cron/jobs/:id — disable job", async () => {
    const { data: created } = await t.json<any>("/cron/jobs", {
      method: "POST",
      auth: true,
      body: {
        name: "patch-test",
        schedule: "1h",
        type: "exec",
        config: { command: "echo patch" },
      },
    });

    const { status, data } = await t.json<any>(`/cron/jobs/${created.id}`, {
      method: "PATCH",
      auth: true,
      body: { enabled: false },
    });
    expect(status).toBe(200);
    expect(data.enabled).toBe(false);
  });

  test("PATCH /cron/jobs/:id — change schedule", async () => {
    const { data: created } = await t.json<any>("/cron/jobs", {
      method: "POST",
      auth: true,
      body: {
        name: "schedule-change",
        schedule: "1h",
        type: "exec",
        config: { command: "echo schedule" },
      },
    });

    const { status, data } = await t.json<any>(`/cron/jobs/${created.id}`, {
      method: "PATCH",
      auth: true,
      body: { schedule: "30s" },
    });
    expect(status).toBe(200);
    expect(data.schedule).toBe("30s");
  });

  test("PATCH /cron/jobs/:id — 404 for missing", async () => {
    const { status } = await t.json<any>("/cron/jobs/nonexistent", {
      method: "PATCH",
      auth: true,
      body: { enabled: false },
    });
    expect(status).toBe(404);
  });

  test("DELETE /cron/jobs/:id — remove job", async () => {
    const { data: created } = await t.json<any>("/cron/jobs", {
      method: "POST",
      auth: true,
      body: {
        name: "delete-me",
        schedule: "1h",
        type: "exec",
        config: { command: "echo delete" },
      },
    });

    const { status, data } = await t.json<any>(`/cron/jobs/${created.id}`, {
      method: "DELETE",
      auth: true,
    });
    expect(status).toBe(200);
    expect(data.deleted).toBe(true);

    // Confirm gone
    const { status: getStatus } = await t.json<any>(`/cron/jobs/${created.id}`, { auth: true });
    expect(getStatus).toBe(404);
  });

  test("DELETE /cron/jobs/:id — 404 for missing", async () => {
    const { status } = await t.json<any>("/cron/jobs/nonexistent", {
      method: "DELETE",
      auth: true,
    });
    expect(status).toBe(404);
  });
});

// =============================================================================
// Immediate trigger & run history
// =============================================================================

describe("immediate trigger and run history", () => {
  test("POST /cron/jobs/:id/run — exec job", async () => {
    const { data: created } = await t.json<any>("/cron/jobs", {
      method: "POST",
      auth: true,
      body: {
        name: "run-test",
        schedule: "1d",
        type: "exec",
        config: { command: "echo hello-from-cron" },
      },
    });

    const { status, data } = await t.json<any>(`/cron/jobs/${created.id}/run`, {
      method: "POST",
      auth: true,
    });
    expect(status).toBe(200);
    expect(data.status).toBe("success");
    expect(data.output).toContain("hello-from-cron");
    expect(data.startedAt).toBeDefined();
    expect(data.completedAt).toBeDefined();
    expect(data.jobId).toBe(created.id);
  });

  test("POST /cron/jobs/:id/run — 404 for missing", async () => {
    const { status } = await t.json<any>("/cron/jobs/nonexistent/run", {
      method: "POST",
      auth: true,
    });
    expect(status).toBe(404);
  });

  test("POST /cron/jobs/:id/run — failed exec", async () => {
    const { data: created } = await t.json<any>("/cron/jobs", {
      method: "POST",
      auth: true,
      body: {
        name: "fail-test",
        schedule: "1d",
        type: "exec",
        config: { command: "exit 1" },
      },
    });

    const { status, data } = await t.json<any>(`/cron/jobs/${created.id}/run`, {
      method: "POST",
      auth: true,
    });
    expect(status).toBe(200);
    expect(data.status).toBe("error");
    expect(data.error).toContain("exit code");
  });

  test("run history appears in job detail", async () => {
    const { data: created } = await t.json<any>("/cron/jobs", {
      method: "POST",
      auth: true,
      body: {
        name: "history-test",
        schedule: "1d",
        type: "exec",
        config: { command: "echo run1" },
      },
    });

    // Trigger twice
    await t.json(`/cron/jobs/${created.id}/run`, { method: "POST", auth: true });
    await t.json(`/cron/jobs/${created.id}/run`, { method: "POST", auth: true });

    const { data } = await t.json<any>(`/cron/jobs/${created.id}`, { auth: true });
    expect(data.runs.length).toBe(2);
    // Most recent first
    expect(data.runs[0].startedAt >= data.runs[1].startedAt).toBe(true);
  });

  test("GET /cron/runs — all recent runs", async () => {
    const { status, data } = await t.json<any>("/cron/runs", { auth: true });
    expect(status).toBe(200);
    expect(data.runs).toBeDefined();
    expect(data.runs.length).toBeGreaterThanOrEqual(1);
    // Each run has jobName
    expect(data.runs[0].jobName).toBeDefined();
  });
});

// =============================================================================
// Panel
// =============================================================================

describe("panel", () => {
  test("GET /cron/_panel returns HTML", async () => {
    const res = await t.fetch("/cron/_panel", { auth: true });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Cron");
  });
});
