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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  child?: ChildProcess;
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

// Auto-populate profile from env vars on first boot if the store is empty.
// Set REEF_USER_NAME, REEF_USER_EMAIL, REEF_USER_TIMEZONE, REEF_USER_LOCATION
// in .env or at provision time. These seed the profile once; the UI panel
// can override afterward. Nothing is hardcoded.
function ensureProfileFromEnv(): void {
  const existing = readProfile();
  if (existing.name || existing.timezone || existing.location || existing.preferences) return;

  const name = process.env.REEF_USER_NAME;
  const email = process.env.REEF_USER_EMAIL;
  const tz = process.env.REEF_USER_TIMEZONE;
  const location = process.env.REEF_USER_LOCATION;

  if (!name && !email && !tz && !location) return;

  const profile: UserProfile = {};
  if (name) profile.name = name;
  if (tz) profile.timezone = tz;
  if (location) profile.location = location;
  // Combine email into preferences so agents know who to address
  const prefParts: string[] = [];
  if (email) prefParts.push(`Operator email: ${email}`);
  prefParts.push("See AGENTS.md for full standing orders.");
  profile.preferences = prefParts.join(" ");

  writeProfile(profile);
  console.log(`[reef] profile seeded from env: ${name || email || "anonymous"}`);
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

function buildScheduledWakePrompt(data: {
  checkId: string;
  kind: string;
  message: string;
  reason?: string | null;
  payload?: Record<string, unknown> | null;
}) {
  const lines = [
    "A scheduled check fired while root was idle.",
    "Treat this as a new bounded supervisory turn.",
    "",
    `Scheduled check ID: ${data.checkId}`,
    `Kind: ${data.kind}`,
    `Message: ${data.message}`,
  ];

  if (data.reason) lines.push(`Reason: ${data.reason}`);
  if (data.payload && Object.keys(data.payload).length > 0) {
    lines.push(`Payload: ${JSON.stringify(data.payload)}`);
  }

  lines.push(
    "",
    "Use current reef world state to decide whether action is needed. If no action is needed, say so briefly and conclude the turn.",
  );
  return lines.join("\n");
}

function pickScheduledWakeConversation(tree: ConversationTree): string | null {
  const candidates = tree
    .listTasks()
    .filter((task) => !task.info.closed)
    .sort((a, b) => b.info.lastActivityAt - a.info.lastActivityAt);
  return candidates[0]?.name || null;
}

let taskCounter = 0;
export const DEFAULT_ROOT_REEF_MODEL = "claude-opus-4-6";
const ROOT_REEF_PROVIDER = "vers";
const ANTHROPIC_PROVIDER = "anthropic";

function hasAnthropicFallbackKey() {
  return !!process.env.ANTHROPIC_API_KEY?.trim();
}

function resolveRootProvider(): "vers" | "anthropic" {
  if (process.env.REEF_MODEL_PROVIDER === ANTHROPIC_PROVIDER) return ANTHROPIC_PROVIDER;
  if (!process.env.LLM_PROXY_KEY?.trim() && hasAnthropicFallbackKey()) return ANTHROPIC_PROVIDER;
  return ROOT_REEF_PROVIDER;
}

export function isCreditExhaustedError(raw: string) {
  const normalized = raw.toLowerCase();
  return (
    (normalized.includes("429") && (normalized.includes("credit") || normalized.includes("quota"))) ||
    normalized.includes("no-credits") ||
    normalized.includes("no credits") ||
    normalized.includes("out of credits")
  );
}

export function isTransientProviderError(raw: string) {
  const normalized = raw.toLowerCase();
  return (
    normalized.includes("internal server error") ||
    normalized.includes("server error") ||
    normalized.includes("internal error") ||
    normalized.includes("service unavailable") ||
    normalized.includes("overloaded") ||
    normalized.includes("fetch failed") ||
    normalized.includes("connection error") ||
    normalized.includes("connection refused") ||
    normalized.includes("other side closed") ||
    normalized.includes("upstream connect") ||
    normalized.includes("reset before headers") ||
    normalized.includes("terminated") ||
    normalized.includes("retry delay") ||
    normalized.includes("too many requests") ||
    normalized.includes("rate limit") ||
    /\b(?:429|500|502|503|504)\b/.test(normalized) ||
    (normalized.includes("api_error") &&
      (normalized.includes("internal") || normalized.includes("server") || normalized.includes("overloaded")))
  );
}

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

interface Attachment {
  path: string;
  name: string;
  mimeType?: string;
}

function buildRpcMessage(prompt: string, attachments?: Attachment[]): string {
  const imageAttachments = (attachments || []).filter(
    (a) => (a.mimeType || "").startsWith("image/") || /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(a.name),
  );

  if (imageAttachments.length === 0) return prompt;

  // Punkin v1_rc5 RPC only accepts string messages (no multimodal content blocks).
  // Instruct the agent to use the Read tool to view attached images.
  const cwd = process.env.REEF_DIR ?? process.cwd();
  const imageInstructions = imageAttachments
    .map((a) => {
      const absPath = a.path.startsWith("/") ? a.path : join(cwd, a.path);
      return `[Attached image: ${a.name} — Use the Read tool on "${absPath}" to view it]`;
    })
    .join("\n");

  return `${imageInstructions}\n\n${prompt}`;
}

function spawnTask(
  prompt: string,
  treeContext: string,
  opts: {
    model?: string;
    attachments?: Attachment[];
    onChild?: (child: ChildProcess) => void;
    onEvent: (event: any) => void;
    onUsageStats?: (payload: {
      provider?: string | null;
      model?: string | null;
      stats: {
        sessionFile?: string;
        sessionId: string;
        userMessages: number;
        assistantMessages: number;
        toolCalls: number;
        toolResults: number;
        totalMessages: number;
        tokens: {
          input: number;
          output: number;
          cacheRead: number;
          cacheWrite: number;
          total: number;
        };
        cost: number;
      };
    }) => void;
    onDone: (output: string) => void;
    onError: (err: string) => void;
  },
): ChildProcess {
  const piPath = resolveAgentBinary();
  const cwd = process.env.REEF_DIR ?? process.cwd();
  const startupTimeoutMs = Math.max(1, Number.parseInt(process.env.REEF_TASK_STARTUP_TIMEOUT_MS ?? "8000", 10) || 8000);
  const maxStartupAttempts = Math.max(1, Number.parseInt(process.env.REEF_TASK_STARTUP_MAX_ATTEMPTS ?? "2", 10) || 2);
  let activeAttempt = 0;

  const startAttempt = (provider: "vers" | "anthropic"): ChildProcess => {
    activeAttempt += 1;
    const attemptId = activeAttempt;
    const child = spawn(piPath, ["--mode", "rpc", "--no-session", "--append-system-prompt", treeContext], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: {
        ...process.env,
        PI_PATH: process.env.PI_PATH || piPath,
        ...(opts.model ? { PI_MODEL: opts.model } : {}),
      },
    });

    opts.onChild?.(child);

    let lineBuf = "";
    let output = "";
    let prompted = false;
    let modelConfigured = !opts.model;
    let modelSelectionRequested = false;
    let autoRetryConfigured = false;
    let autoRetryRequested = false;
    let fallingBack = false;
    let finished = false;
    let startupReady = false;
    let requestCounter = 0;
    let lastUsageStatsPullAt = 0;
    let usageStatsInflight: Promise<void> | null = null;
    let lastUsageProvider: string | null = provider;
    let lastUsageModel: string | null = opts.model || null;
    const pending = new Map<
      string,
      {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    >();

    const readyCheck = setInterval(() => {
      try {
        child.stdin.write(`${JSON.stringify({ id: "ready-check", type: "get_state" })}\n`);
      } catch {
        clearInterval(readyCheck);
      }
    }, 1000);

    let startupTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (attemptId !== activeAttempt || fallingBack || finished || startupReady) return;

      clearInterval(readyCheck);
      rejectPending("RPC startup timed out before first response");

      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }

      if (attemptId < maxStartupAttempts) {
        opts.onEvent({
          type: "task_retry",
          reason: "startup_timeout",
          attempt: attemptId,
          nextAttempt: attemptId + 1,
        });
        startAttempt(provider);
        return;
      }

      finished = true;
      opts.onError(
        `pi startup timed out before first response after ${attemptId} attempt${attemptId === 1 ? "" : "s"}`,
      );
    }, startupTimeoutMs);

    const clearStartupTimeout = () => {
      if (!startupTimeout) return;
      clearTimeout(startupTimeout);
      startupTimeout = null;
    };

    const markStartupReady = () => {
      if (startupReady) return;
      startupReady = true;
      clearStartupTimeout();
    };

    const maybeFallbackToAnthropic = (raw: string) => {
      const reason = isCreditExhaustedError(raw)
        ? "credit_exhausted"
        : isTransientProviderError(raw)
          ? "transient_provider_error"
          : null;
      if (
        fallingBack ||
        attemptId !== activeAttempt ||
        provider !== ROOT_REEF_PROVIDER ||
        !hasAnthropicFallbackKey() ||
        !reason
      ) {
        return false;
      }

      fallingBack = true;
      clearInterval(readyCheck);
      process.env.REEF_MODEL_PROVIDER = ANTHROPIC_PROVIDER;
      opts.onEvent({
        type: "provider_fallback",
        from: ROOT_REEF_PROVIDER,
        to: ANTHROPIC_PROVIDER,
        reason,
      });
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      startAttempt(ANTHROPIC_PROVIDER);
      return true;
    };

    const rejectPending = (message: string) => {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timeout);
        entry.reject(new Error(message));
        pending.delete(id);
      }
    };

    const requestSessionStats = async (
      options: { force?: boolean; provider?: string | null; model?: string | null } = {},
    ) => {
      if (!opts.onUsageStats) return;
      if (child.killed) return;

      const now = Date.now();
      if (!options.force) {
        if (usageStatsInflight) return usageStatsInflight;
        if (now - lastUsageStatsPullAt < 5000) return;
      }

      const requestId = `usage-stats-${++requestCounter}`;
      const run = (async () => {
        try {
          const stats = await new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => {
              pending.delete(requestId);
              reject(new Error("Timed out waiting for get_session_stats response"));
            }, 5000);
            pending.set(requestId, { resolve, reject, timeout });
            child.stdin.write(`${JSON.stringify({ id: requestId, type: "get_session_stats" })}\n`);
          });
          lastUsageStatsPullAt = Date.now();
          opts.onUsageStats?.({
            provider: options.provider ?? lastUsageProvider ?? null,
            model: options.model ?? lastUsageModel ?? null,
            stats,
          });
        } catch {
          // Best effort: raw message-level usage remains available as fallback.
        } finally {
          if (usageStatsInflight === run) usageStatsInflight = null;
        }
      })();

      usageStatsInflight = run;
      return run;
    };

    async function handleEvent(event: any) {
      if (attemptId !== activeAttempt) return;
      markStartupReady();

      if (event.type === "response" && event.id && pending.has(event.id)) {
        const entry = pending.get(event.id)!;
        clearTimeout(entry.timeout);
        pending.delete(event.id);
        if (event.success === false)
          entry.reject(new Error(event.error || `RPC command ${event.command || event.id} failed`));
        else entry.resolve(event.data);
        return;
      }

      if (!prompted && event.type === "response" && event.command === "get_state") {
        if (!autoRetryConfigured && !autoRetryRequested) {
          autoRetryRequested = true;
          clearInterval(readyCheck);
          child.stdin.write(`${JSON.stringify({ id: "set-auto-retry", type: "set_auto_retry", enabled: true })}\n`);
          return;
        }

        if (!modelConfigured && !modelSelectionRequested && opts.model) {
          modelSelectionRequested = true;
          clearInterval(readyCheck);
          child.stdin.write(
            `${JSON.stringify({ id: "set-model", type: "set_model", provider, modelId: opts.model, thinkingLevel: "high" })}\n`,
          );
          return;
        }

        prompted = true;
        clearInterval(readyCheck);
        const rpcMessage = buildRpcMessage(prompt, opts.attachments);
        child.stdin.write(`${JSON.stringify({ type: "prompt", message: rpcMessage })}\n`);
      }

      if (!prompted && event.type === "response" && event.command === "set_auto_retry") {
        autoRetryConfigured = true;

        if (!modelConfigured && !modelSelectionRequested && opts.model) {
          modelSelectionRequested = true;
          child.stdin.write(
            `${JSON.stringify({ id: "set-model", type: "set_model", provider, modelId: opts.model, thinkingLevel: "high" })}\n`,
          );
          return;
        }

        prompted = true;
        const rpcMessage = buildRpcMessage(prompt, opts.attachments);
        child.stdin.write(`${JSON.stringify({ type: "prompt", message: rpcMessage })}\n`);
      }

      if (!prompted && event.type === "response" && event.command === "set_model") {
        modelConfigured = true;
        prompted = true;
        const rpcMessage = buildRpcMessage(prompt, opts.attachments);
        child.stdin.write(`${JSON.stringify({ type: "prompt", message: rpcMessage })}\n`);
      }

      opts.onEvent(event);

      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        output += event.assistantMessageEvent.delta;
      }

      if (event.type === "message_end" && event.message?.role === "assistant") {
        lastUsageProvider = event.message.provider || event.message.api || lastUsageProvider || null;
        lastUsageModel = event.message.model || lastUsageModel || null;
        void requestSessionStats({
          provider: lastUsageProvider,
          model: lastUsageModel,
        });
      }

      if ((event.type === "message_end" || event.type === "turn_end") && event.message?.errorMessage && !output) {
        const raw = event.message.errorMessage;
        if (maybeFallbackToAnthropic(raw)) return;
        if (isCreditExhaustedError(raw)) {
          output = "Error: No credits available on your Vers account and no alternate provider was available.";
        } else if (isTransientProviderError(raw)) {
          output =
            `Transient provider/backend failure after retries. Your prompt was not rejected, but this turn could not complete. ` +
            `Retry the request or send a short follow-up message to continue from the existing conversation context.\n\n` +
            `Provider error: ${raw}`;
        } else {
          output = `Error: ${raw}`;
        }
      }

      if (event.type === "agent_end") {
        if (finished) return;
        finished = true;
        clearStartupTimeout();
        await requestSessionStats({
          force: true,
          provider: lastUsageProvider,
          model: lastUsageModel,
        });
        child.kill("SIGTERM");
        opts.onDone(output);
      }
    }

    child.stdout.on("data", (data: Buffer) => {
      if (attemptId !== activeAttempt) return;
      lineBuf += data.toString();
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          void handleEvent(JSON.parse(line));
        } catch {
          /* not JSON */
        }
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      if (attemptId !== activeAttempt) return;
      const msg = data.toString().trim();
      if (msg) console.error(`  [pi] ${msg}`);
    });

    child.on("error", (err) => {
      clearInterval(readyCheck);
      clearStartupTimeout();
      rejectPending(`RPC process error: ${err.message}`);
      if (attemptId !== activeAttempt) return;
      if (finished) return;
      finished = true;
      opts.onError(`Failed to spawn pi: ${err.message}`);
    });

    child.on("close", (code) => {
      clearInterval(readyCheck);
      clearStartupTimeout();
      rejectPending(code && code !== 0 ? `RPC process exited with code ${code}` : "RPC process closed");
      if (attemptId !== activeAttempt || fallingBack) return;
      if (finished) return;
      if (code && code !== 0) {
        finished = true;
        opts.onError(`pi exited with code ${code}`);
      }
    });

    return child;
  };

  return startAttempt(resolveRootProvider());
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

  // =========================================================================
  // Operator presence — distinguish "waiting for answer" from "AFK"
  // =========================================================================
  let operatorLastSeen = 0; // epoch ms — updated on any UI interaction
  let operatorConnected = false; // true if at least one SSE client connected

  function updatePresence() {
    operatorLastSeen = Date.now();
  }

  function operatorPresence(): {
    connected: boolean;
    lastSeenMs: number;
    lastSeenAgo: string;
    status: "active" | "idle" | "away" | "offline";
  } {
    const ago = Date.now() - operatorLastSeen;
    const connected = sseClients.size > 0;
    const status = !connected
      ? ("offline" as const)
      : ago < 60_000
        ? ("active" as const)
        : ago < 300_000
          ? ("idle" as const)
          : ("away" as const);
    const agoStr =
      ago < 60_000
        ? `${Math.round(ago / 1000)}s`
        : ago < 3600_000
          ? `${Math.round(ago / 60_000)}m`
          : `${Math.round(ago / 3600_000)}h`;
    return { connected, lastSeenMs: operatorLastSeen, lastSeenAgo: agoStr, status };
  }
  const agentModel = config.agent?.model ?? DEFAULT_ROOT_REEF_MODEL;

  // Only add system prompt if tree is empty (fresh start)
  if (tree.size() === 0) {
    // v2: Load AGENTS.md as the system prompt
    let systemPrompt = config.agent?.systemPrompt ?? process.env.REEF_SYSTEM_PROMPT ?? "";
    if (!systemPrompt) {
      const { readParentAgentsMd } = await import("./core/agents-md.js");
      systemPrompt = readParentAgentsMd();
    }
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

  function launchTask(
    task: Task,
    taskId: string,
    userNode: import("./tree.js").TreeNode,
    treeContext: string,
    attachments?: Attachment[],
  ) {
    let lastToolNode: import("./tree.js").TreeNode | null = null;

    try {
      task.child = spawnTask(task.prompt, treeContext, {
        model: agentModel,
        attachments,
        onChild(child) {
          task.child = child;
        },
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

          if (event.type === "message_end" && event.message?.role === "assistant") {
            events.fire("usage:message", {
              agentId: process.env.VERS_VM_ID || "root",
              agentName: process.env.VERS_AGENT_NAME || "root-reef",
              taskId,
              message: event.message,
            });
          }

          broadcast({ taskId, ...event });
        },
        onUsageStats(payload) {
          events.fire("usage:stats", {
            agentId: process.env.VERS_VM_ID || "root",
            agentName: process.env.VERS_AGENT_NAME || "root-reef",
            taskId,
            provider: payload.provider || null,
            model: payload.model || null,
            stats: payload.stats,
          });
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

  async function submitPrompt(opts: {
    prompt: string;
    attachments?: Attachment[];
    conversationId?: string;
    parentId?: string | null;
  }) {
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
    // Include attestation provenance if available
    let attestationContext = "";
    try {
      const reg = (await import("./core/webauthn.js")).readRegistry() as any;
      if (reg.attestation) {
        attestationContext = `\n[operator attestation]\nAGENTS.md attested by operator at ${new Date(reg.attestation.signedAt).toISOString()}\nDocument hash: ${reg.attestation.documentHash}\nSigned by ${reg.attestation.signatures.length} passkey(s)\nThis task was dispatched from an attested fleet.`;
      } else if (reg.credentials?.length > 0) {
        attestationContext =
          "\n[operator attestation]\n⚠ Passkeys registered but AGENTS.md not yet attested. First-use trust (TOFU).";
      }
    } catch {}
    // Include operator presence so agents can decide wait vs proceed
    const presence = operatorPresence();
    const presenceContext = `[operator presence] status: ${presence.status}, last seen: ${presence.lastSeenAgo} ago${
      presence.status === "away" || presence.status === "offline"
        ? "\nOperator appears AFK. For plan approval: proceed with best judgment after signaling. Do not block indefinitely."
        : presence.status === "active"
          ? "\nOperator is active. Signal plans and wait briefly for steer before proceeding."
          : "\nOperator is idle. Signal plans; proceed if no response within 2 minutes."
    }`;

    const contextParts = [profile, presenceContext, attestationContext, tree.contextFor(userNode.id)].filter(Boolean);
    const context = contextParts.join("\n\n");
    launchTask(task, taskId, userNode, context, opts.attachments);

    return { taskId, userNode, continuing };
  }

  events.on("scheduled:fired", async (data: any) => {
    const rootAgentName = process.env.VERS_AGENT_NAME || "root-reef";
    if (!data || data.targetAgent !== rootAgentName) return;
    if (data.targetCategory === "resource_vm") return;

    const runningTasks = [...piProcesses.values()].filter((task) => task.status === "running");
    if (runningTasks.length > 0) {
      broadcast({
        type: "scheduled_attention_queued",
        targetAgent: rootAgentName,
        checkId: data.checkId,
        reason: "root already has a running turn",
      });
      return;
    }

    const prompt = buildScheduledWakePrompt({
      checkId: data.checkId,
      kind: data.kind,
      message: data.message,
      reason: data.reason || null,
      payload: data.payload || null,
    });
    const conversationId = pickScheduledWakeConversation(tree) || `scheduled-${data.checkId}`;

    try {
      const result = await submitPrompt({
        prompt,
        conversationId,
      });
      broadcast({
        type: "scheduled_attention_started",
        targetAgent: rootAgentName,
        checkId: data.checkId,
        conversationId: result.taskId,
        nodeId: result.userNode.id,
      });
    } catch (err: any) {
      broadcast({
        type: "scheduled_attention_error",
        targetAgent: rootAgentName,
        checkId: data.checkId,
        error: err?.message || String(err),
      });
    }
  });

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
    const attachments: Attachment[] = Array.isArray(body.attachments)
      ? body.attachments.filter((a: any) => a?.path && a?.name)
      : [];

    const result = await submitPrompt({
      prompt,
      attachments: attachments.length > 0 ? attachments : undefined,
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

    const attachments: Attachment[] = Array.isArray(body.attachments)
      ? body.attachments.filter((a: any) => a?.path && a?.name)
      : [];

    const result = await submitPrompt({ prompt, attachments: attachments.length > 0 ? attachments : undefined });
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

    const msgAttachments: Attachment[] = Array.isArray(body.attachments)
      ? body.attachments.filter((a: any) => a?.path && a?.name)
      : [];

    const result = await submitPrompt({
      prompt,
      attachments: msgAttachments.length > 0 ? msgAttachments : undefined,
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

  reef.post("/conversations/:id/stop", (c) => {
    const id = c.req.param("id");
    const task = piProcesses.get(id);
    if (!task) return c.json({ error: "not found" }, 404);
    if (task.status !== "running") return c.json({ error: "not running" }, 400);

    if (task.child && task.child.exitCode === null) {
      task.child.kill("SIGTERM");
    }
    task.status = "done";
    task.completedAt = Date.now();
    task.output += "\n\n[Stopped by user]";

    const assistantNode = tree.add(tree.getRef(id) ?? null, "assistant", task.output);
    tree.setRef(id, assistantNode.id);
    tree.completeTask(id, task.output);
    appendConversationLog(id, { type: "task_stopped", nodeId: assistantNode.id });
    broadcast({ taskId: id, conversationId: id, type: "task_done", output: task.output, stopped: true });

    return c.json({ stopped: true, taskId: id });
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
  // WebAuthn / Passkeys — multi-root principal identity
  // =========================================================================

  const webauthn = await import("./core/webauthn.js");

  /** List registered passkeys (public info only) */
  reef.get("/passkeys", (c) => {
    const creds = webauthn.listCredentials();
    return c.json({
      count: creds.length,
      credentials: creds.map((cr) => ({
        id: cr.id,
        providerHint: cr.providerHint,
        label: cr.label,
        deviceType: cr.deviceType || "unknown",
        backedUp: cr.backedUp ?? false,
        transports: cr.transports || [],
        registeredAt: cr.registeredAt,
      })),
      policy: webauthn.readRegistry().policy,
    });
  });

  /** Begin passkey registration — returns WebAuthn creation options */
  reef.post("/passkeys/register/start", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = body.name || readProfile().name || "Operator";
    const hint = body.hint; // "security-key" | "client-device" | "hybrid"
    const options = await webauthn.startRegistration(name, hint);
    return c.json(options);
  });

  /** Finish passkey registration — verifies attestation response */
  reef.post("/passkeys/register/finish", async (c) => {
    const body = await c.req.json();
    const { attestation, providerHint, label } = body;
    if (!attestation) return c.json({ error: "Missing attestation response" }, 400);
    const result = await webauthn.finishRegistration(attestation, providerHint, label);
    if (!result.verified) return c.json({ error: "Registration verification failed" }, 400);
    broadcast({ type: "passkey_registered", credentialId: result.credential?.id, label });
    return c.json({ verified: true, credential: { id: result.credential?.id, label } });
  });

  /** Begin passkey authentication — returns WebAuthn request options */
  reef.post("/passkeys/auth/start", async (c) => {
    const reg = webauthn.readRegistry();
    if (reg.credentials.length === 0) {
      return c.json({ error: "No passkeys registered — register one first" }, 400);
    }
    const options = await webauthn.startAuthentication();
    return c.json(options);
  });

  /** Finish passkey authentication — verifies assertion response */
  reef.post("/passkeys/auth/finish", async (c) => {
    const body = await c.req.json();
    if (!body.assertion) return c.json({ error: "Missing assertion response" }, 400);
    const result = await webauthn.finishAuthentication(body.assertion);
    if (!result.verified) return c.json({ error: "Authentication failed" }, 401);
    broadcast({ type: "passkey_authenticated", credentialId: result.credentialId });
    return c.json({ verified: true, credentialId: result.credentialId });
  });

  /** Rename a passkey */
  reef.patch("/passkeys/:id", async (c) => {
    const body = await c.req.json();
    if (!body.label || typeof body.label !== "string") return c.json({ error: "Missing label" }, 400);
    const result = webauthn.renameCredential(c.req.param("id"), body.label);
    if (!result.renamed) return c.json({ error: "not found" }, 404);
    return c.json(result);
  });

  /** Remove a passkey (requires at least 1 remaining) */
  reef.delete("/passkeys/:id", (c) => {
    const reg = webauthn.readRegistry();
    if (reg.credentials.length <= 1) {
      return c.json({ error: "Cannot remove last passkey" }, 400);
    }
    const result = webauthn.removeCredential(c.req.param("id"));
    return c.json(result);
  });

  // --- Attestation: cross-sign AGENTS.md with passkeys ---

  /** Preview what will be attested */
  reef.get("/passkeys/attest/preview", async (c) => {
    const { readParentAgentsMd } = await import("./core/agents-md.js");
    const agentsMd = readParentAgentsMd();
    const preview = webauthn.buildAttestationPreview(agentsMd);
    return c.json({ ...preview, document: agentsMd });
  });

  /** Start attestation — get auth challenge with document hash as challenge */
  reef.post("/passkeys/attest/start", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const documentHash = body.documentHash;
    if (!documentHash) return c.json({ error: "Missing documentHash" }, 400);

    // Use the document hash as the challenge so the signature binds to the document
    const reg = webauthn.readRegistry();
    const options = await webauthn.startAuthentication();
    // Override the challenge with our document hash
    options.challenge = documentHash;
    // Store the real challenge for verification
    reg.pendingChallenge = documentHash;
    webauthn.writeRegistry(reg);

    return c.json(options);
  });

  /** Store completed attestation */
  reef.post("/passkeys/attest/finish", async (c) => {
    const body = await c.req.json();
    const { documentHash, document, summary, signatures } = body;
    if (!documentHash || !signatures?.length) {
      return c.json({ error: "Missing documentHash or signatures" }, 400);
    }
    webauthn.storeAttestation(documentHash, document, summary, signatures);
    broadcast({ type: "attestation_updated", documentHash, sigCount: signatures.length });
    return c.json({ stored: true, sigCount: signatures.length });
  });

  /** Get current attestation status */
  reef.get("/passkeys/attest/status", (c) => {
    const reg = webauthn.readRegistry() as any;
    if (!reg.attestation) return c.json({ attested: false });
    return c.json({
      attested: true,
      documentHash: reg.attestation.documentHash,
      signedAt: reg.attestation.signedAt,
      sigCount: reg.attestation.signatures.length,
    });
  });

  /** Export principal registry (for baking into child AGENTS.md / trust tree) */
  reef.get("/passkeys/registry", (c) => {
    const reg = webauthn.readRegistry();
    return c.json(webauthn.exportableRegistry(reg));
  });

  /** Passkey management panel (served as HTML for iframe in UI) */
  reef.get("/passkeys/_panel", (c) => {
    const reg = webauthn.readRegistry();
    const creds = reg.credentials;
    const rows = creds
      .map((cr) => {
        const transports = (cr.transports || []).join(", ") || "—";
        const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
        return `<tr>
        <td><input class="pk-label-input" data-cred-id="${cr.id}" value="${esc(cr.label || "")}" placeholder="name this key" style="background:#1a1a1a;border:1px solid #333;color:#ccc;padding:2px 6px;border-radius:3px;font-family:inherit;font-size:12px;width:140px" /></td>
        <td>${cr.deviceType || "?"}</td>
        <td>${transports}</td>
        <td>${cr.backedUp ? "✓" : "✗"}</td>
        <td>${new Date(cr.registeredAt).toLocaleDateString()}</td>
        <td><button class="pk-revoke-btn" data-cred-id="${cr.id}" style="background:none;border:1px solid #555;color:#f55;padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px"${creds.length <= 1 ? " disabled" : ""}>revoke</button></td>
      </tr>`;
      })
      .join("");

    return c.html(`
      <div style="font-family:monospace;font-size:13px;color:#ccc">
        <div style="margin-bottom:12px;color:#888">
          Passkeys — multi-root operator identity (${creds.length} registered)
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:12px">
          <thead><tr style="color:#888;font-size:11px;text-align:left">
            <th>Name</th><th>Type</th><th>Transports</th><th>Backed up</th><th>Registered</th><th></th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="6" style="color:#555">No passkeys registered</td></tr>'}</tbody>
        </table>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="pk-register-btn" data-hint="client-device" data-label="Platform" style="background:#4f9;color:#000;border:none;padding:6px 16px;border-radius:4px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer">🔐 Platform (1Password / iCloud / Touch ID)</button>
          <button class="pk-register-btn" data-hint="security-key" data-label="Security Key" style="background:#4f9;color:#000;border:none;padding:6px 16px;border-radius:4px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer">🔑 Security Key (YubiKey / NFC)</button>
          <button class="pk-register-btn" data-hint="hybrid" data-label="Phone" style="background:#4f9;color:#000;border:none;padding:6px 16px;border-radius:4px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer">📱 Phone (QR scan)</button>
        </div>
        <div id="pk-status" style="color:#4f9;font-size:11px;min-height:16px;margin-top:8px"></div>

        ${
          creds.length > 0
            ? `
        <div style="margin-top:16px;padding-top:12px;border-top:1px solid #333">
          <div style="color:#888;font-size:11px;margin-bottom:8px">Fleet Attestation — sign AGENTS.md with your passkeys</div>
          ${
            (reg as any).attestation
              ? `
            <div style="color:#4f9;font-size:11px;margin-bottom:8px">
              ✓ Last attested: ${new Date((reg as any).attestation.signedAt).toLocaleString()}
              (${(reg as any).attestation.signatures.length} sig${(reg as any).attestation.signatures.length === 1 ? "" : "s"},
              hash: ${(reg as any).attestation.documentHash.slice(0, 16)}…)
            </div>
          `
              : `<div style="color:#f80;font-size:11px;margin-bottom:8px">⚠ No attestation yet — fleet children cannot verify your identity</div>`
          }
          <button id="pk-attest-btn" style="background:#f80;color:#000;border:none;padding:6px 16px;border-radius:4px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer">${(reg as any).attestation ? "Re-attest AGENTS.md" : "Attest AGENTS.md"}</button>
          <div id="pk-attest-preview" style="display:none;margin-top:8px;padding:8px;background:#111;border:1px solid #333;border-radius:4px;max-height:300px;overflow:auto;font-size:11px;color:#aaa"></div>
          <div id="pk-attest-status" style="color:#4f9;font-size:11px;min-height:16px;margin-top:4px"></div>
        </div>
        `
            : ""
        }
        <script>
          (async function() {
            const { startRegistration, startAuthentication } = await import('https://cdn.jsdelivr.net/npm/@simplewebauthn/browser/dist/bundle/index.js');

            const panelEl = document.getElementById('pk-status')?.closest('[data-api]');
            const api = panelEl?.dataset?.api || '';
            const status = () => document.getElementById('pk-status');

            document.querySelectorAll('.pk-register-btn').forEach(btn => {
              btn.addEventListener('click', async function() {
                const hint = this.dataset.hint;
                const label = this.dataset.label;
                try {
                  status().style.color = '#4f9';
                  status().textContent = 'Starting registration (' + label + ')...';

                  const optRes = await fetch(api + '/reef/passkeys/register/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: '${reg.operatorName || "Operator"}', hint }),
                  });
                  const options = await optRes.json();
                  if (!optRes.ok) throw new Error(options.error || 'Failed to get options');

                  status().textContent = 'Waiting for authenticator...';
                  const attestation = await startRegistration({ optionsJSON: options });

                  const verRes = await fetch(api + '/reef/passkeys/register/finish', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ attestation, label, providerHint: hint }),
                  });
                  const result = await verRes.json();
                  if (!verRes.ok) throw new Error(result.error || 'Verification failed');

                  status().textContent = 'Passkey registered!';
                  setTimeout(async () => {
                    try {
                      const r = await fetch(api + '/reef/passkeys/_panel');
                      if (r.ok) {
                        const html = await r.text();
                        const panel = document.getElementById('panel-passkeys');
                        if (panel) { panel.innerHTML = ''; if (typeof injectPanel === 'function') injectPanel(panel, html); else panel.innerHTML = html; }
                      }
                    } catch {}
                  }, 500);
                } catch (err) {
                  status().style.color = '#f55';
                  status().textContent = err.name === 'NotAllowedError'
                    ? 'Cancelled by user'
                    : 'Error: ' + err.message;
                }
              });
            });

            document.querySelectorAll('.pk-label-input').forEach(input => {
              const save = async (el) => {
                const id = el.dataset.credId;
                const label = el.value.trim();
                if (!label) return;
                await fetch(api + '/reef/passkeys/' + encodeURIComponent(id), {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ label }),
                }).catch(() => {});
              };
              input.addEventListener('blur', () => save(input));
              input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(input); input.blur(); } });
            });

            document.querySelectorAll('.pk-revoke-btn').forEach(btn => {
              btn.addEventListener('click', async function() {
                const id = this.dataset.credId;
                if (!confirm('Revoke this passkey?')) return;
                try {
                  const res = await fetch(api + '/reef/passkeys/' + encodeURIComponent(id), { method: 'DELETE' });
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error);
                  try {
                    const r = await fetch(api + '/reef/passkeys/_panel');
                    if (r.ok) {
                      const html = await r.text();
                      const panel = document.getElementById('panel-passkeys');
                      if (panel) { panel.innerHTML = ''; if (typeof injectPanel === 'function') injectPanel(panel, html); else panel.innerHTML = html; }
                    }
                  } catch {}
                } catch (err) {
                  status().style.color = '#f55';
                  status().textContent = 'Error: ' + err.message;
                }
              });
            });
            // --- Attestation ceremony ---
            const attestBtn = document.getElementById('pk-attest-btn');
            if (attestBtn) {
              attestBtn.addEventListener('click', async function() {
                const preview = document.getElementById('pk-attest-preview');
                const aStatus = document.getElementById('pk-attest-status');
                try {
                  aStatus.style.color = '#4f9';
                  aStatus.textContent = 'Loading preview...';

                  const preRes = await fetch(api + '/reef/passkeys/attest/preview');
                  const pre = await preRes.json();
                  if (!preRes.ok) throw new Error(pre.error || 'Failed to load preview');

                  // Show preview
                  preview.style.display = 'block';
                  preview.innerHTML = '<div style="margin-bottom:8px;padding:8px;background:#1a1a1a;border:1px solid #4f9;border-radius:4px">' +
                    '<pre style="white-space:pre-wrap;margin:0;color:#4f9">' + pre.summary.replace(/</g, '&lt;') + '</pre></div>' +
                    '<div style="margin-bottom:8px;font-size:11px;color:#888">Document hash: <code>' + pre.documentHash + '</code></div>' +
                    '<details open><summary style="cursor:pointer;color:#ccc;font-size:12px;margin-bottom:4px">AGENTS.md (full document — read before signing)</summary>' +
                    '<pre style="white-space:pre-wrap;margin:0;font-size:10px;max-height:400px;overflow:auto;padding:8px;background:#0a0a0a;border:1px solid #222;border-radius:4px">' +
                    pre.document.replace(/</g, '&lt;') +
                    '</pre></details>';

                  aStatus.textContent = 'Review above, then tap each passkey to sign...';

                  // Collect signatures from each registered passkey
                  const signatures = [];
                  const keysRes = await fetch(api + '/reef/passkeys');
                  const keysData = await keysRes.json();

                  for (let i = 0; i < keysData.credentials.length; i++) {
                    const cred = keysData.credentials[i];
                    aStatus.textContent = 'Tap passkey ' + (i + 1) + '/' + keysData.credentials.length + ' (' + (cred.label || cred.id.slice(0,8)) + ')...';

                    const startRes = await fetch(api + '/reef/passkeys/attest/start', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ documentHash: pre.documentHash }),
                    });
                    const options = await startRes.json();
                    if (!startRes.ok) throw new Error(options.error || 'Failed to start');

                    const assertion = await startAuthentication({ optionsJSON: options });
                    signatures.push({
                      credentialId: assertion.id,
                      clientDataJSON: assertion.response.clientDataJSON,
                      authenticatorData: assertion.response.authenticatorData,
                      signature: assertion.response.signature,
                    });
                  }

                  // Store
                  aStatus.textContent = 'Storing attestation...';
                  const storeRes = await fetch(api + '/reef/passkeys/attest/finish', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      documentHash: pre.documentHash,
                      document: pre.document,
                      summary: pre.summary,
                      signatures,
                    }),
                  });
                  const storeData = await storeRes.json();
                  if (!storeRes.ok) throw new Error(storeData.error || 'Failed to store');

                  aStatus.textContent = '✓ Attested with ' + signatures.length + ' signature(s)!';
                  preview.style.display = 'none';
                } catch (err) {
                  aStatus.style.color = '#f55';
                  aStatus.textContent = err.name === 'NotAllowedError'
                    ? 'Cancelled by user'
                    : 'Error: ' + err.message;
                }
              });
            }
          })();
        </script>
      </div>
    `);
  });

  // =========================================================================
  // Operator presence
  // =========================================================================

  /** Get operator presence status — agents call this to decide wait vs proceed */
  reef.get("/presence", (c) => {
    return c.json(operatorPresence());
  });

  /** UI heartbeat — called by the browser to indicate operator is active */
  reef.post("/presence/heartbeat", (c) => {
    updatePresence();
    return c.json({ ok: true });
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
      const results: Array<{ name: string; path: string; url: string; size: number }> = [];

      for (const [, value] of formData.entries()) {
        if (!(value instanceof File)) continue;
        const safeName = value.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const storedName = `${Date.now()}-${safeName}`;
        const filePath = join(uploadsDir, storedName);
        const buffer = Buffer.from(await value.arrayBuffer());
        writeFileSync(filePath, buffer);
        results.push({ name: value.name, path: filePath, url: `/reef/files/${storedName}`, size: buffer.length });
      }

      return c.json({ files: results });
    }

    return c.json({ error: "Expected multipart/form-data" }, 400);
  });

  // File serving — list and download uploaded files
  reef.get("/files", (c) => {
    const uploadsDir = join(process.env.REEF_DATA_DIR ?? "data", "uploads");
    if (!existsSync(uploadsDir)) return c.json({ files: [], count: 0 });

    const entries = readdirSync(uploadsDir);
    const files = entries.map((name) => {
      const filePath = join(uploadsDir, name);
      const stats = statSync(filePath);
      return { name, url: `/reef/files/${name}`, size: stats.size, uploadedAt: stats.mtimeMs };
    });

    return c.json({ files, count: files.length });
  });

  reef.get("/files/:filename", (c) => {
    const uploadsDir = join(process.env.REEF_DATA_DIR ?? "data", "uploads");
    const filename = c.req.param("filename");

    if (!filename || filename.includes("/") || filename.includes("..")) {
      return c.json({ error: "Invalid filename" }, 400);
    }

    const filePath = join(uploadsDir, filename);
    if (!existsSync(filePath)) {
      return c.json({ error: "File not found" }, 404);
    }

    const fileBuffer = readFileSync(filePath);
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    const mimeMap: Record<string, string> = {
      txt: "text/plain",
      md: "text/markdown",
      json: "application/json",
      js: "text/javascript",
      ts: "text/typescript",
      py: "text/x-python",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      pdf: "application/pdf",
      csv: "text/csv",
      html: "text/html",
      xml: "application/xml",
      zip: "application/zip",
    };
    const contentType = mimeMap[ext] || "application/octet-stream";

    return new Response(fileBuffer, {
      headers: { "Content-Type": contentType },
    });
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
        updatePresence();
        operatorConnected = true;
        controller.enqueue(`: connected\n\n`);
      },
      cancel(controller) {
        sseClients.delete(controller);
        operatorConnected = sseClients.size > 0;
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
  ensureProfileFromEnv();
  const { app, tree, piProcesses, liveModules, sseClients } = await createReef(config);
  const port = config.server?.port ?? parseInt(process.env.PORT ?? "3000", 10);

  console.log("  mode: agent");
  console.log("  services:");
  for (const mod of liveModules.values()) {
    if (mod.routes) console.log(`    /${mod.name} — ${mod.description || mod.name}`);
  }
  console.log(`    /reef — agent conversation + task submission`);

  const tlsCert = process.env.TLS_CERT;
  const tlsKey = process.env.TLS_KEY;
  const serverOpts: any = { fetch: app.fetch, port, hostname: "::", idleTimeout: 120 };
  if (tlsCert && tlsKey) {
    serverOpts.tls = { cert: Bun.file(tlsCert), key: Bun.file(tlsKey) };
    console.log("  tls: enabled");
  }
  const server = Bun.serve(serverOpts);
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
