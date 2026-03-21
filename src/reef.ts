/**
 * Reef — an agent with a server.
 *
 * Each task gets its own pi process (RPC mode). Fresh extensions every time.
 * Concurrent tasks = concurrent pi processes. The conversation tree is memory.
 *
 * Lifecycle per task:
 *   1. POST /reef/submit
 *   2. Spawn pi --mode rpc --no-session (fresh process, fresh extensions)
 *   3. Send task with tree context via --append-system-prompt
 *   4. Stream events to SSE clients
 *   5. agent_end → capture result, append to tree, kill pi
 *
 * Routes:
 *   POST /reef/submit   — start a task
 *   GET  /reef/tasks     — list active + completed tasks
 *   GET  /reef/tree      — conversation history
 *   GET  /reef/state     — status
 *   GET  /reef/events    — SSE stream
 */

import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentBinary } from "@hdresearch/pi-v/core";
import { Hono } from "hono";
import { bearerAuth } from "./core/auth.js";
import { createServer, type ServerOptions } from "./core/server.js";
import { ConversationTree } from "./tree.js";

// =============================================================================
// Task — one pi process per task
// =============================================================================

interface Task {
  id: string;
  prompt: string;
  status: "running" | "done" | "error";
  output: string;
  events: any[];
  startedAt: number;
  completedAt?: number;
  error?: string;
}

// =============================================================================
// User profile — persisted in the store, injected into all agent prompts
// =============================================================================

const PROFILE_KEY = "reef:profile";
const STORE_PATH = "data/store.json";

interface UserProfile {
  name?: string;
  timezone?: string;
  location?: string;
  preferences?: string;
}

function readProfile(): UserProfile {
  try {
    if (!existsSync(STORE_PATH)) return {};
    const store = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
    return store[PROFILE_KEY]?.value ?? {};
  } catch {
    return {};
  }
}

function writeProfile(profile: UserProfile): void {
  let store: Record<string, any> = {};
  try {
    if (existsSync(STORE_PATH)) {
      store = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
    }
  } catch {}

  const now = Date.now();
  store[PROFILE_KEY] = {
    value: profile,
    createdAt: store[PROFILE_KEY]?.createdAt ?? now,
    updatedAt: now,
  };

  if (!existsSync("data")) mkdirSync("data", { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function profileContext(): string {
  const profile = readProfile();
  const parts: string[] = [];
  if (profile.name) parts.push(`User name: ${profile.name}`);
  if (profile.timezone) parts.push(`Timezone: ${profile.timezone}`);
  if (profile.location) parts.push(`Location: ${profile.location}`);
  if (profile.preferences) parts.push(`Preferences: ${profile.preferences}`);
  if (parts.length === 0) return "";
  return `[user profile]\n${parts.join("\n")}`;
}

let taskCounter = 0;
export const DEFAULT_ROOT_REEF_MODEL = "claude-opus-4-6";
const ROOT_REEF_PROVIDER = "vers";

function conversationPayload(tree: ConversationTree, id: string) {
  const info = tree.getTask(id);
  if (!info) return null;
  const leafId = tree.getRef(id);
  const nodes = leafId ? tree.ancestors(leafId) : [];
  return {
    id,
    ...info,
    leafId,
    nodes,
  };
}

function spawnTask(
  prompt: string,
  treeContext: string,
  opts: {
    model?: string;
    onEvent: (event: any) => void;
    onDone: (output: string) => void;
    onError: (err: string) => void;
  },
): ChildProcess {
  const piPath = resolveAgentBinary();
  const cwd = process.env.REEF_DIR ?? process.cwd();

  const child = spawn(piPath, ["--mode", "rpc", "--no-session", "--append-system-prompt", treeContext], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: {
      ...process.env,
      PI_PATH: process.env.PI_PATH || piPath,
      ...(opts.model ? { PI_MODEL: opts.model } : {}),
    },
  });

  let lineBuf = "";
  let output = "";
  let prompted = false;
  let modelConfigured = !opts.model;
  let modelSelectionRequested = false;

  // Poll for pi readiness, then send the prompt
  const readyCheck = setInterval(() => {
    try {
      child.stdin.write(`${JSON.stringify({ id: "ready-check", type: "get_state" })}\n`);
    } catch {
      clearInterval(readyCheck);
    }
  }, 1000);

  function handleEvent(event: any) {
    // Wait for ready response before selecting the model and sending the prompt.
    if (!prompted && event.type === "response" && event.command === "get_state") {
      if (!modelConfigured && !modelSelectionRequested && opts.model) {
        modelSelectionRequested = true;
        clearInterval(readyCheck);
        child.stdin.write(
          `${JSON.stringify({ id: "set-model", type: "set_model", provider: ROOT_REEF_PROVIDER, modelId: opts.model })}\n`,
        );
        return;
      }

      prompted = true;
      clearInterval(readyCheck);
      child.stdin.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);
    }

    if (!prompted && event.type === "response" && event.command === "set_model") {
      modelConfigured = true;
      prompted = true;
      child.stdin.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);
    }

    opts.onEvent(event);

    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      output += event.assistantMessageEvent.delta;
    }

    if (event.type === "agent_end") {
      child.kill("SIGTERM");
      opts.onDone(output);
    }
  }

  child.stdout.on("data", (data: Buffer) => {
    lineBuf += data.toString();
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handleEvent(JSON.parse(line));
      } catch {
        /* not JSON */
      }
    }
  });

  child.stderr.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.error(`  [pi] ${msg}`);
  });

  child.on("error", (err) => {
    clearInterval(readyCheck);
    opts.onError(`Failed to spawn pi: ${err.message}`);
  });

  child.on("close", (code) => {
    clearInterval(readyCheck);
    if (code && code !== 0) opts.onError(`pi exited with code ${code}`);
  });

  return child;
}

// =============================================================================
// Reef
// =============================================================================

export interface ReefConfig {
  agent?: { model?: string; systemPrompt?: string };
  server?: ServerOptions;
}

export async function createReef(config: ReefConfig = {}) {
  const { app: serviceApp, liveModules, events, ctx } = await createServer(config.server ?? {});

  const tree = new ConversationTree();
  const dataDir = process.env.REEF_DATA_DIR ?? "data";
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const conversationLogDir = join(dataDir, "conversations");
  if (!existsSync(conversationLogDir)) mkdirSync(conversationLogDir, { recursive: true });
  tree.persist(`${dataDir}/tree.json`);

  const piProcesses = new Map<string, Task>();
  const sseClients = new Set<ReadableStreamDefaultController>();
  const agentModel = config.agent?.model ?? DEFAULT_ROOT_REEF_MODEL;

  // Only add system prompt if tree is empty (fresh start)
  if (tree.size() === 0) {
    const systemPrompt =
      config.agent?.systemPrompt ??
      process.env.REEF_SYSTEM_PROMPT ??
      "You are a reef agent. You have tools to manage VMs, spawn swarms, deploy services, and store state. When given a task, decide the best approach — do it yourself, delegate to a swarm, or decompose it. You build your own tools.";
    const sysNode = tree.add(null, "system", systemPrompt);
    tree.setRef("main", sysNode.id);
  }

  function broadcast(event: any) {
    const data = JSON.stringify(event);
    for (const c of sseClients) {
      try {
        c.enqueue(`data: ${data}\n\n`);
      } catch {
        sseClients.delete(c);
      }
    }
  }

  function appendConversationLog(conversationId: string, entry: Record<string, unknown>) {
    const line = JSON.stringify({
      ts: Date.now(),
      conversationId,
      ...entry,
    });
    appendFileSync(join(conversationLogDir, `${conversationId}.jsonl`), `${line}\n`);
  }

  // Track event parents — e.g. cron_done is child of cron_start
  const eventParents = new Map<string, string>(); // runId/groupKey → nodeId

  // Wire event bus → SSE + tree: every event is a node with a parent
  events.on("reef:event", (data: any) => {
    const { type, source, ...meta } = data;
    const content = meta.prompt || meta.jobName || meta.name || meta.error || type;

    let parentId: string | null = null;

    // Cron done/error are children of their cron_start
    if ((type === "cron_done" || type === "cron_error") && meta.runId) {
      parentId = eventParents.get(meta.runId) ?? null;
    }

    // If no specific parent, add as child of main's current node (sibling, not chain)
    let node: import("./tree.js").TreeNode;
    if (parentId) {
      node = tree.add(parentId, "event", content, { eventType: type, source, meta });
    } else {
      // Events are siblings under main — don't advance the ref
      const mainId = tree.getRef("main") ?? null;
      node = tree.add(mainId, "event", content, { eventType: type, source, meta });
    }

    // Track: cron_start becomes parent for its run
    if (type === "cron_start" && meta.runId) {
      eventParents.set(meta.runId, node.id);
    }

    broadcast({ ...data, nodeId: node.id, parentId: node.parentId });
  });

  // ==========================================================================
  // Task launcher — spawn pi and wire events to the tree
  // ==========================================================================

  function failTask(task: Task, taskId: string, error: string) {
    task.status = "error";
    task.error = error;
    task.completedAt = Date.now();
    tree.failTask(taskId, error);
    appendConversationLog(taskId, { type: "error", error });
    broadcast({ taskId, conversationId: taskId, type: "task_error", error });
    tree.pruneToLimit();
  }

  function launchTask(task: Task, taskId: string, userNode: import("./tree.js").TreeNode, treeContext: string) {
    let lastToolNode: import("./tree.js").TreeNode | null = null;

    try {
      spawnTask(task.prompt, treeContext, {
        model: agentModel,
        onEvent(event) {
          task.events.push(event);
          if (task.events.length > 500) task.events.shift();

          if (event.type === "tool_execution_start") {
            const toolNode = tree.add(userNode.id, "tool_call", event.toolName, {
              toolName: event.toolName,
              toolParams: event.args,
            });
            appendConversationLog(taskId, {
              type: "tool_call",
              nodeId: toolNode.id,
              parentId: toolNode.parentId,
              toolName: event.toolName,
              args: event.args,
            });
            lastToolNode = toolNode;
            broadcast({ taskId, ...event, nodeId: toolNode.id, parentId: toolNode.parentId });
            return;
          }

          if (event.type === "tool_execution_end") {
            const parentToolId = lastToolNode?.id ?? userNode.id;
            const resultText =
              event.result?.content
                ?.filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("") || "";
            const resultNode = tree.add(parentToolId, "tool_result", resultText.slice(0, 1000), {
              toolCallId: event.toolCallId,
              result: event.result,
            });
            appendConversationLog(taskId, {
              type: "tool_result",
              nodeId: resultNode.id,
              parentId: resultNode.parentId,
              toolCallId: event.toolCallId,
              isError: !!event.isError,
              result: resultText.slice(0, 1000),
            });
            broadcast({ taskId, ...event, nodeId: resultNode.id, parentId: resultNode.parentId });
            return;
          }

          broadcast({ taskId, ...event });
        },
        onDone(output) {
          task.status = "done";
          task.output = output;
          task.completedAt = Date.now();

          const assistantNode = tree.add(userNode.id, "assistant", output.trim());
          tree.setRef(taskId, assistantNode.id);
          tree.completeTask(taskId, { summary: output.trim().slice(0, 500), filesChanged: [] });
          appendConversationLog(taskId, {
            type: "assistant",
            nodeId: assistantNode.id,
            parentId: assistantNode.parentId,
            content: output.trim(),
          });

          broadcast({
            taskId,
            conversationId: taskId,
            type: "task_done",
            summary: output.trim().slice(0, 200),
            nodeId: assistantNode.id,
            parentId: assistantNode.parentId,
          });

          tree.pruneToLimit();
        },
        onError(err) {
          failTask(task, taskId, err);
        },
      });
    } catch (err: any) {
      failTask(task, taskId, err.message);
    }
  }

  // ==========================================================================
  // Routes
  // ==========================================================================

  const reef = new Hono();
  const auth = bearerAuth();
  reef.use("*", async (c, next) => await auth(c, next));

  async function submitPrompt(opts: { prompt: string; conversationId?: string; parentId?: string | null }) {
    const taskId = opts.conversationId || `task-${++taskCounter}-${Date.now()}`;
    const taskExists = !!tree.getTask(taskId);
    const continuing = taskExists;
    const parentId = continuing
      ? (opts.parentId ?? tree.getRef(taskId) ?? tree.getRef("main") ?? null)
      : (opts.parentId ?? tree.getRef("main") ?? null);

    const userNode = continuing
      ? tree.add(parentId, "user", opts.prompt)
      : tree.startTask(taskId, opts.prompt, parentId);

    if (continuing) {
      tree.reopenTask(taskId);
      tree.setRef(taskId, userNode.id);
    }
    appendConversationLog(taskId, {
      type: "user",
      nodeId: userNode.id,
      parentId: userNode.parentId,
      content: opts.prompt,
      continuing,
    });

    const task: Task = {
      id: taskId,
      prompt: opts.prompt,
      status: "running",
      output: "",
      events: [],
      startedAt: Date.now(),
    };
    piProcesses.set(taskId, task);

    broadcast({
      type: "task_started",
      taskId,
      conversationId: taskId,
      prompt: opts.prompt,
      nodeId: userNode.id,
      parentId: userNode.parentId,
      continuing,
    });
    const profile = profileContext();
    const context = profile ? `${profile}\n\n${tree.contextFor(userNode.id)}` : tree.contextFor(userNode.id);
    launchTask(task, taskId, userNode, context);

    return { taskId, userNode, continuing };
  }

  reef.post("/submit", async (c) => {
    const body = await c.req.json();
    const prompt = body.task;
    if (!prompt || typeof prompt !== "string") {
      return c.json({ error: "Missing 'task' string in body." }, 400);
    }

    const taskId =
      typeof body.taskId === "string"
        ? body.taskId
        : typeof body.conversationId === "string"
          ? body.conversationId
          : undefined;
    const result = await submitPrompt({
      prompt,
      conversationId: taskId,
      parentId: typeof body.parentId === "string" ? body.parentId : undefined,
    });

    return c.json(
      {
        id: result.taskId,
        conversationId: result.taskId,
        status: "running",
        prompt,
        nodeId: result.userNode.id,
      },
      202,
    );
  });

  reef.get("/conversations", (c) => {
    const includeClosed = c.req.query("includeClosed") === "true";
    let list = tree.listTasks();
    if (!includeClosed) list = list.filter((t) => !t.info.closed);
    list.sort((a, b) => b.info.lastActivityAt - a.info.lastActivityAt);
    return c.json({
      conversations: list.map((t) => ({
        id: t.name,
        ...t.info,
        leafId: t.leafId,
      })),
    });
  });

  reef.get("/conversations/:id", (c) => {
    const conversation = conversationPayload(tree, c.req.param("id"));
    if (!conversation) return c.json({ error: "not found" }, 404);
    return c.json(conversation);
  });

  reef.post("/conversations", async (c) => {
    const body = await c.req.json();
    const prompt = body.task;
    if (!prompt || typeof prompt !== "string") {
      return c.json({ error: "Missing 'task' string in body." }, 400);
    }

    const result = await submitPrompt({ prompt });
    const conversation = conversationPayload(tree, result.taskId);
    return c.json(
      {
        ...conversation,
        status: "running",
        prompt,
        nodeId: result.userNode.id,
      },
      202,
    );
  });

  reef.post("/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!tree.getTask(id)) return c.json({ error: "not found" }, 404);

    const body = await c.req.json();
    const prompt = body.task;
    if (!prompt || typeof prompt !== "string") {
      return c.json({ error: "Missing 'task' string in body." }, 400);
    }

    const result = await submitPrompt({
      prompt,
      conversationId: id,
      parentId: typeof body.parentId === "string" ? body.parentId : undefined,
    });
    return c.json(
      {
        id,
        conversationId: id,
        status: "running",
        prompt,
        nodeId: result.userNode.id,
      },
      202,
    );
  });

  reef.post("/conversations/:id/close", (c) => {
    const id = c.req.param("id");
    if (!tree.closeTask(id)) return c.json({ error: "not found" }, 404);
    appendConversationLog(id, { type: "conversation_closed" });
    const conversation = conversationPayload(tree, id);
    return c.json(conversation);
  });

  reef.post("/conversations/:id/open", (c) => {
    const id = c.req.param("id");
    if (!tree.openTask(id)) return c.json({ error: "not found" }, 404);
    appendConversationLog(id, { type: "conversation_opened" });
    const conversation = conversationPayload(tree, id);
    return c.json(conversation);
  });

  reef.get("/tasks", (c) => {
    const status = c.req.query("status");
    let list = tree.listTasks();
    if (status) list = list.filter((t) => t.info.status === status);
    return c.json({
      tasks: list.map((t) => ({
        name: t.name,
        ...t.info,
        leafId: t.leafId,
      })),
    });
  });

  reef.get("/tasks/:name", (c) => {
    const conversation = conversationPayload(tree, c.req.param("name"));
    if (!conversation) return c.json({ error: "not found" }, 404);
    return c.json({ name: conversation.id, ...conversation });
  });

  reef.get("/tree", (c) => c.json(tree.toJSON()));

  /** Get a node and its children. */
  reef.get("/tree/:id", (c) => {
    const node = tree.get(c.req.param("id"));
    if (!node) return c.json({ error: "not found" }, 404);
    const children = tree.children(node.id);
    return c.json({ node, children });
  });

  /** Get ancestors of a node (the conversation path). */
  reef.get("/tree/:id/path", (c) => {
    const node = tree.get(c.req.param("id"));
    if (!node) return c.json({ error: "not found" }, 404);
    return c.json({ path: tree.ancestors(node.id) });
  });

  // =========================================================================
  // User profile
  // =========================================================================

  reef.get("/profile", (c) => {
    return c.json(readProfile());
  });

  reef.get("/profile/_panel", (c) => {
    const p = readProfile();
    const val = (v?: string) => (v ? v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;") : "");
    return c.html(`
      <div style="font-family:monospace;font-size:13px;color:#ccc">
        <div style="margin-bottom:12px;color:#888">User profile — injected into all agent system prompts</div>
        <form id="profile-form" style="display:flex;flex-direction:column;gap:8px;max-width:400px">
          <label style="color:#888;font-size:11px">Name
            <input name="name" value="${val(p.name)}" style="display:block;width:100%;background:#1a1a1a;border:1px solid #333;color:#ccc;padding:6px 8px;border-radius:4px;font-family:inherit;font-size:13px;margin-top:2px" />
          </label>
          <label style="color:#888;font-size:11px">Timezone
            <input name="timezone" value="${val(p.timezone)}" placeholder="e.g. America/New_York" style="display:block;width:100%;background:#1a1a1a;border:1px solid #333;color:#ccc;padding:6px 8px;border-radius:4px;font-family:inherit;font-size:13px;margin-top:2px" />
          </label>
          <label style="color:#888;font-size:11px">Location
            <input name="location" value="${val(p.location)}" placeholder="e.g. New York, NY" style="display:block;width:100%;background:#1a1a1a;border:1px solid #333;color:#ccc;padding:6px 8px;border-radius:4px;font-family:inherit;font-size:13px;margin-top:2px" />
          </label>
          <label style="color:#888;font-size:11px">Preferences
            <textarea name="preferences" rows="3" placeholder="Any context for your agents..." style="display:block;width:100%;background:#1a1a1a;border:1px solid #333;color:#ccc;padding:6px 8px;border-radius:4px;font-family:inherit;font-size:13px;margin-top:2px;resize:vertical">${val(p.preferences)}</textarea>
          </label>
          <button type="submit" style="align-self:flex-start;background:#4f9;color:#000;border:none;padding:6px 16px;border-radius:4px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer">Save</button>
          <div id="profile-status" style="color:#4f9;font-size:11px;min-height:16px"></div>
        </form>
        <script>
          document.getElementById('profile-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const form = e.target;
            const data = Object.fromEntries(new FormData(form));
            const api = form.closest('[data-api]')?.dataset?.api || '';
            try {
              const res = await fetch(api + '/reef/profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
              });
              if (res.ok) {
                document.getElementById('profile-status').textContent = 'Saved — agents will see this on next task.';
                setTimeout(() => { document.getElementById('profile-status').textContent = ''; }, 3000);
              } else {
                document.getElementById('profile-status').style.color = '#f55';
                document.getElementById('profile-status').textContent = 'Failed to save.';
              }
            } catch (err) {
              document.getElementById('profile-status').style.color = '#f55';
              document.getElementById('profile-status').textContent = 'Error: ' + err.message;
            }
          });
        </script>
      </div>
    `);
  });

  reef.put("/profile", async (c) => {
    const body = await c.req.json();
    const current = readProfile();
    const updated: UserProfile = {
      name: typeof body.name === "string" ? body.name : current.name,
      timezone: typeof body.timezone === "string" ? body.timezone : current.timezone,
      location: typeof body.location === "string" ? body.location : current.location,
      preferences: typeof body.preferences === "string" ? body.preferences : current.preferences,
    };
    // Remove empty strings
    for (const key of Object.keys(updated) as Array<keyof UserProfile>) {
      if (updated[key] === "") delete updated[key];
    }
    writeProfile(updated);
    return c.json(updated);
  });

  // =========================================================================
  // File uploads
  // =========================================================================

  reef.get("/disk", async (c) => {
    try {
      const { execSync } = await import("node:child_process");
      const output = execSync("df -m / | tail -1", { encoding: "utf-8" });
      const parts = output.trim().split(/\s+/);
      const totalMib = parseInt(parts[1], 10) || 0;
      const usedMib = parseInt(parts[2], 10) || 0;
      const availMib = parseInt(parts[3], 10) || 0;
      return c.json({ totalMib, usedMib, availMib });
    } catch {
      return c.json({ error: "Could not read disk info" }, 500);
    }
  });

  reef.post("/disk/resize", async (c) => {
    const vmId = process.env.VERS_VM_ID;
    if (!vmId) return c.json({ error: "VERS_VM_ID not set" }, 400);

    const body = await c.req.json();
    const newSizeMib = body.fs_size_mib;
    if (!newSizeMib || typeof newSizeMib !== "number" || newSizeMib <= 0) {
      return c.json({ error: "fs_size_mib (positive integer) is required" }, 400);
    }

    try {
      const { VersClient } = await import("@hdresearch/pi-v/core");
      const client = new VersClient();
      await client.resizeDisk(vmId, newSizeMib);
      return c.json({ resized: true, vmId, fs_size_mib: newSizeMib });
    } catch (err: any) {
      return c.json({ error: err.message || "Resize failed" }, 500);
    }
  });

  reef.post("/upload", async (c) => {
    const uploadsDir = join(process.env.REEF_DATA_DIR ?? "data", "uploads");
    if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

    const contentType = c.req.header("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData();
      const results: Array<{ name: string; path: string; size: number }> = [];

      for (const [, value] of formData.entries()) {
        if (!(value instanceof File)) continue;
        const safeName = value.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const filePath = join(uploadsDir, `${Date.now()}-${safeName}`);
        const buffer = Buffer.from(await value.arrayBuffer());
        writeFileSync(filePath, buffer);
        results.push({ name: value.name, path: filePath, size: buffer.length });
      }

      return c.json({ files: results });
    }

    return c.json({ error: "Expected multipart/form-data" }, 400);
  });

  reef.get("/state", (c) => {
    return c.json({
      mode: "agent",
      activeTasks: tree.activeTasks(),
      totalTasks: tree.tasks.size,
      totalNodes: tree.size(),
      conversations: tree.tasks.size,
      services: Array.from(liveModules.keys()),
    });
  });

  // SSE heartbeat — keeps connections alive past Bun's idleTimeout
  setInterval(() => {
    for (const c of sseClients) {
      try {
        c.enqueue(`: ping\n\n`);
      } catch {
        sseClients.delete(c);
      }
    }
  }, 30_000);

  reef.get("/events", (_c) => {
    const stream = new ReadableStream({
      start(controller) {
        sseClients.add(controller);
        controller.enqueue(`: connected\n\n`);
      },
      cancel(controller) {
        sseClients.delete(controller);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Transfer-Encoding": "chunked",
      },
    });
  });

  const wrapper = new Hono();
  wrapper.route("/reef", reef);
  wrapper.route("/", serviceApp);

  return { app: wrapper, tree, piProcesses, liveModules, events, ctx, sseClients };
}

export async function startReef(config: ReefConfig = {}) {
  const { app, tree, piProcesses, liveModules, sseClients } = await createReef(config);
  const port = config.server?.port ?? parseInt(process.env.PORT ?? "3000", 10);

  console.log("  mode: agent");
  console.log("  services:");
  for (const mod of liveModules.values()) {
    if (mod.routes) console.log(`    /${mod.name} — ${mod.description || mod.name}`);
  }
  console.log(`    /reef — agent conversation + task submission`);

  const server = Bun.serve({ fetch: app.fetch, port, hostname: "::", idleTimeout: 120 });
  console.log(`\n  reef running on :${port}\n`);

  async function shutdown() {
    console.log("\n  shutting down...");
    for (const c of sseClients) {
      try {
        c.close();
      } catch {}
    }
    for (const mod of liveModules.values()) {
      if (mod.store?.flush) mod.store.flush();
      if (mod.store?.close) await mod.store.close();
    }
    server.stop();
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return { app, server, tree, piProcesses, liveModules };
}
