/**
 * Swarm runtime — manages the lifecycle of swarm worker pi processes.
 *
 * Reuses lieutenant's RPC infrastructure (VersClient, SSH, FIFO/tmux pattern)
 * with worker-specific env and model defaults.
 */

import {
  loadVersKeyFromDisk,
  type ResolveGoldenCommitResult,
  resolveAgentBinary,
  resolveGoldenCommit,
  VersClient,
} from "@hdresearch/pi-v/core";
import { buildAgentsMdWriteScript, buildChildAgentsMd, readParentAgentsMd } from "../../src/core/agents-md.js";
import type { ServiceEventBus } from "../../src/core/events.js";
import {
  buildPersistKeysScript,
  buildPersistVmIdScript,
  createVersVmFromCommit,
  deleteVersVm,
  type RpcHandle,
  waitForRpcReady,
  waitForSshReady,
} from "../lieutenant/rpc.js";
import type { VMCategory, VMTreeStore } from "../vm-tree/store.js";

// =============================================================================
// Types
// =============================================================================

export interface AgentEvent {
  type: "spawned" | "task_sent" | "completed" | "error" | "watchdog_alert" | "destroyed";
  timestamp: number;
  detail: string;
  metadata?: Record<string, unknown>;
}

export interface SwarmAgent {
  id: string;
  vmId: string;
  label: string;
  status: "starting" | "idle" | "working" | "done" | "error";
  task?: string;
  lastOutput: string;
  events: string[];
  lifecycle: AgentEvent[];
  lastActivityAt: number;
  taskStartedAt?: number;
  createdAt: number;
}

export interface SpawnParams {
  commitId?: string;
  count: number;
  labels?: string[];
  llmProxyKey?: string;
  model?: string;
  context?: string; // v2: situational context appended to inherited AGENTS.md
  category?: string; // v2: override category (default: swarm_vm, agent_vm for reef_agent_spawn)
  directive?: string; // v2: hard guardrails (VERS_AGENT_DIRECTIVE)
  effort?: string; // v2: thinking effort level (low, medium, high)
  parentVmId?: string | null;
  spawnedBy?: string;
}

// =============================================================================
// Spawn result types
// =============================================================================

export type SpawnStepName =
  | "resolve_commit"
  | "create_vm"
  | "register_vm_tree"
  | "wait_ssh"
  | "inject_identity"
  | "copy_agents_md"
  | "start_rpc"
  | "wait_rpc_ready"
  | "validate"
  | "baseline_snapshot";

export type AgentSpawnResult =
  | { ok: true; vmId: string; name: string }
  | { ok: false; error: string; step: SpawnStepName; vmId?: string };

export interface SpawnResult {
  results: AgentSpawnResult[];
  agents: SwarmAgent[];
  messages: string[];
}

export interface SwarmRuntimeOptions {
  events: ServiceEventBus;
  vmTreeStore?: VMTreeStore;
  resolveCommitId?: (commitId?: string) => Promise<ResolveGoldenCommitResult>;
  createVm?: typeof createVersVmFromCommit;
  deleteVm?: typeof deleteVersVm;
  waitForVm?: typeof waitForSshReady;
  startHandle?: typeof startWorkerRpcAgent;
  reconnectHandle?: typeof reconnectWorkerRpcAgent;
  waitForReady?: typeof waitForRpcReady;
}

export const DEFAULT_SWARM_MODEL = "claude-sonnet-4-6";

// =============================================================================
// Worker RPC — builds on lieutenant's RPC infra with worker-specific env
// =============================================================================

const versClient = new VersClient();

function escapeEnvValue(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function buildWorkerEnv(
  vmId: string,
  label: string,
  opts: { llmProxyKey?: string; directive?: string; category?: string; parentVmId?: string; parentAgent?: string },
): string {
  const versApiKey = process.env.VERS_API_KEY || loadVersKeyFromDisk();
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || opts.llmProxyKey || process.env.LLM_PROXY_KEY || "";
  const exports = [
    opts.llmProxyKey
      ? `export LLM_PROXY_KEY='${escapeEnvValue(opts.llmProxyKey)}'`
      : process.env.LLM_PROXY_KEY
        ? `export LLM_PROXY_KEY='${escapeEnvValue(process.env.LLM_PROXY_KEY)}'`
        : "",
    anthropicApiKey ? `export ANTHROPIC_API_KEY='${escapeEnvValue(anthropicApiKey)}'` : "",
    versApiKey ? `export VERS_API_KEY='${escapeEnvValue(versApiKey)}'` : "",
    process.env.VERS_BASE_URL ? `export VERS_BASE_URL='${escapeEnvValue(process.env.VERS_BASE_URL)}'` : "",
    process.env.VERS_INFRA_URL ? `export VERS_INFRA_URL='${escapeEnvValue(process.env.VERS_INFRA_URL)}'` : "",
    process.env.VERS_AUTH_TOKEN ? `export VERS_AUTH_TOKEN='${escapeEnvValue(process.env.VERS_AUTH_TOKEN)}'` : "",
    process.env.VERS_GOLDEN_COMMIT_ID
      ? `export VERS_GOLDEN_COMMIT_ID='${escapeEnvValue(process.env.VERS_GOLDEN_COMMIT_ID)}'`
      : "",
    `export VERS_VM_ID='${escapeEnvValue(vmId)}'`,
    process.env.PI_PATH ? `export PI_PATH='${escapeEnvValue(process.env.PI_PATH)}'` : "",
    process.env.PUNKIN_BIN ? `export PUNKIN_BIN='${escapeEnvValue(process.env.PUNKIN_BIN)}'` : "",
    `export PI_VERS_HOME='${escapeEnvValue(process.env.PI_VERS_HOME || "/root/pi-vers")}'`,
    `export SERVICES_DIR='${escapeEnvValue(process.env.SERVICES_DIR || "/root/reef/services-active")}'`,
    // v2: category-based identity
    `export REEF_CATEGORY='${escapeEnvValue(opts.category || "swarm_vm")}'`,
    `export VERS_AGENT_NAME='${escapeEnvValue(label)}'`,
    opts.parentVmId || process.env.VERS_VM_ID
      ? `export REEF_PARENT_VM_ID='${escapeEnvValue(opts.parentVmId || process.env.VERS_VM_ID || "")}'`
      : "",
    opts.parentVmId || process.env.VERS_VM_ID
      ? `export REEF_ROOT_VM_ID='${escapeEnvValue(process.env.REEF_ROOT_VM_ID || process.env.VERS_VM_ID || "")}'`
      : "",
    opts.directive ? `export VERS_AGENT_DIRECTIVE='${escapeEnvValue(opts.directive)}'` : "",
    opts.parentAgent || process.env.VERS_AGENT_NAME
      ? `export VERS_PARENT_AGENT='${escapeEnvValue(opts.parentAgent || process.env.VERS_AGENT_NAME || "")}'`
      : "export VERS_PARENT_AGENT='reef'",
    process.env.REEF_MODEL_PROVIDER
      ? `export REEF_MODEL_PROVIDER='${escapeEnvValue(process.env.REEF_MODEL_PROVIDER)}'`
      : "",
    "export GIT_EDITOR=true",
  ]
    .filter(Boolean)
    .join("; ");

  return exports;
}

const RPC_DIR = "/tmp/pi-rpc";
const RPC_IN = `${RPC_DIR}/in`;
const RPC_OUT = `${RPC_DIR}/out`;
const RPC_ERR = `${RPC_DIR}/err`;

type EventHandler = (event: any) => void;

function createHandlerSet() {
  const handlers = new Set<EventHandler>();
  return {
    emit(event: any) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          console.error(`[swarm-rpc] handler failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
    subscribe(handler: EventHandler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}

function createRemoteHandle(vmId: string, sshBaseArgs: string[], skipExistingOutput: boolean): RpcHandle {
  const handlers = createHandlerSet();
  const pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }
  >();
  let tailChild: ReturnType<typeof import("node:child_process").spawn> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let killed = false;
  let lineBuffer = "";
  let linesProcessed = skipExistingOutput ? -1 : 0;
  let requestCounter = 0;

  const { spawn } = require("node:child_process");

  const rejectPending = (message: string) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timeout);
      entry.reject(new Error(message));
      pending.delete(id);
    }
  };

  const startTail = () => {
    if (killed) return;

    const tailArg = linesProcessed < 0 ? "-n 0" : `-n +${Math.max(linesProcessed + 1, 1)}`;
    tailChild = spawn("ssh", [...sshBaseArgs, `tail -f ${tailArg} ${RPC_OUT}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (linesProcessed < 0) linesProcessed = 0;

    tailChild.stdout.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";

      for (const line of lines) {
        linesProcessed++;
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event?.type === "response" && typeof event.id === "string" && pending.has(event.id)) {
            const entry = pending.get(event.id)!;
            clearTimeout(entry.timeout);
            pending.delete(event.id);
            if (event.success === false) {
              entry.reject(new Error(event.error || `${event.command || "rpc"} failed`));
            } else {
              entry.resolve(event.data);
            }
          }
          handlers.emit(event);
        } catch {
          // Ignore non-JSON output.
        }
      }
    });

    tailChild.on("close", () => {
      if (killed) return;
      lineBuffer = "";
      rejectPending(`RPC tail closed for VM ${vmId}`);
      reconnectTimer = setTimeout(() => startTail(), 3000);
    });
  };

  const suspendTail = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (tailChild) {
      try {
        tailChild.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      tailChild = null;
    }
  };

  startTail();

  return {
    send(cmd: object) {
      if (killed) return;
      const writer = spawn("ssh", [...sshBaseArgs, `cat > ${RPC_IN}`], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      writer.stdin.write(`${JSON.stringify(cmd)}\n`);
      writer.stdin.end();
    },
    onEvent(handler: EventHandler) {
      return handlers.subscribe(handler);
    },
    getSessionStats() {
      if (killed) return Promise.reject(new Error(`RPC handle for VM ${vmId} is closed`));
      const id = `usage-stats-${vmId}-${++requestCounter}`;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for get_session_stats from VM ${vmId}`));
        }, 15000);
        pending.set(id, { resolve, reject, timeout });
        const writer = spawn("ssh", [...sshBaseArgs, `cat > ${RPC_IN}`], {
          stdio: ["pipe", "ignore", "ignore"],
        });
        writer.stdin.write(`${JSON.stringify({ id, type: "get_session_stats" })}\n`);
        writer.stdin.end();
      });
    },
    async kill() {
      killed = true;
      suspendTail();
      rejectPending(`RPC handle for VM ${vmId} was killed`);
      try {
        await versClient.exec(
          vmId,
          `tmux kill-session -t pi-rpc 2>/dev/null || true
tmux kill-session -t pi-keeper 2>/dev/null || true
rm -rf ${RPC_DIR}`,
        );
      } catch {
        /* VM may already be gone */
      }
    },
    vmId,
    isAlive() {
      return !killed;
    },
    reconnectTail() {
      suspendTail();
      startTail();
    },
    suspendTail,
  };
}

function resolveModelProvider(): "vers" | "anthropic" {
  if (process.env.REEF_MODEL_PROVIDER === "anthropic") return "anthropic";
  if (!process.env.LLM_PROXY_KEY && process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "vers";
}

export async function startWorkerRpcAgent(
  vmId: string,
  opts: {
    llmProxyKey?: string;
    model?: string;
    label?: string;
    directive?: string;
    category?: string;
    effort?: string;
    parentVmId?: string;
    parentAgent?: string;
  },
): Promise<RpcHandle> {
  const sshBaseArgs = await versClient.sshArgs(vmId);
  const envExports = buildWorkerEnv(vmId, opts.label || `worker-${vmId.slice(0, 8)}`, opts);

  await versClient.exec(vmId, buildPersistVmIdScript(vmId));
  await versClient.exec(vmId, buildPersistKeysScript(opts));

  // v2: Check if AGENTS.md was copied, add --system-prompt flag if so
  let agentsMdFlag = "";
  try {
    const check = await versClient.exec(vmId, "test -f /root/.pi/agent/AGENTS.md && echo yes || echo no");
    if (check.stdout.trim() === "yes") {
      agentsMdFlag = "--system-prompt /root/.pi/agent/AGENTS.md";
    }
  } catch {
    /* best effort */
  }
  const piCommand = `${resolveAgentBinary()} --mode rpc --no-session ${agentsMdFlag}`.trim();

  const startScript = `
set -e
mkdir -p ${RPC_DIR}
rm -f ${RPC_IN} ${RPC_OUT} ${RPC_ERR}
mkfifo ${RPC_IN}
touch ${RPC_OUT} ${RPC_ERR}
tmux kill-session -t pi-keeper 2>/dev/null || true
tmux kill-session -t pi-rpc 2>/dev/null || true
tmux new-session -d -s pi-keeper "sleep infinity > ${RPC_IN}"
tmux new-session -d -s pi-rpc "${envExports}; cd /root/workspace; ${piCommand} < ${RPC_IN} >> ${RPC_OUT} 2>> ${RPC_ERR}"
sleep 1
tmux has-session -t pi-rpc 2>/dev/null && echo daemon_started || echo daemon_failed
`;

  const result = await versClient.exec(vmId, startScript);
  if (!result.stdout.includes("daemon_started")) {
    throw new Error(`Failed to start worker pi RPC on ${vmId}: ${result.stderr || result.stdout}`);
  }

  const handle = createRemoteHandle(vmId, sshBaseArgs, false);
  if (opts.model) {
    const setModelMsg: any = { type: "set_model", provider: resolveModelProvider(), modelId: opts.model };
    if (opts.effort) setModelMsg.thinkingLevel = opts.effort;
    handle.send(setModelMsg);
  }
  return handle;
}

export async function reconnectWorkerRpcAgent(vmId: string): Promise<RpcHandle> {
  const sshBaseArgs = await versClient.sshArgs(vmId);
  const result = await versClient.exec(vmId, "tmux has-session -t pi-rpc 2>/dev/null && echo ok || echo gone");
  if (!result.stdout.includes("ok")) {
    throw new Error(`Pi RPC session not found on worker VM ${vmId}`);
  }
  return createRemoteHandle(vmId, sshBaseArgs, true);
}

// =============================================================================
// Swarm Runtime
// =============================================================================

export class SwarmRuntime {
  private readonly agents = new Map<string, SwarmAgent>();
  private readonly handles = new Map<string, RpcHandle>();
  private readonly usageStatsInflight = new Map<string, Promise<void>>();
  private readonly usageStatsLastPulledAt = new Map<string, number>();
  private readonly events: ServiceEventBus;
  private readonly vmTreeStore?: VMTreeStore;
  private readonly resolveCommitId: (commitId?: string) => Promise<ResolveGoldenCommitResult>;
  private readonly createVm: typeof createVersVmFromCommit;
  private readonly deleteVm: typeof deleteVersVm;
  private readonly waitForVm: typeof waitForSshReady;
  private readonly startHandle: typeof startWorkerRpcAgent;
  private readonly reconnectHandle: typeof reconnectWorkerRpcAgent;
  private readonly waitForReady: typeof waitForRpcReady;

  // Activity timeout — auto-transition "working" → "done" after silence
  private readonly activityChecker: ReturnType<typeof setInterval>;
  private static readonly ACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
  private static readonly ACTIVITY_CHECK_INTERVAL_MS = 30 * 1000;

  // Orphan cleanup timer
  private orphanTimer?: ReturnType<typeof setInterval>;

  // Watchdog timers per agent
  private readonly watchdogs = new Map<string, ReturnType<typeof setInterval>>();

  constructor(opts: SwarmRuntimeOptions) {
    this.events = opts.events;
    this.vmTreeStore = opts.vmTreeStore;
    this.resolveCommitId = opts.resolveCommitId ?? ((id) => resolveGoldenCommit({ commitId: id, ensure: true }));
    this.createVm = opts.createVm ?? createVersVmFromCommit;
    this.deleteVm = opts.deleteVm ?? deleteVersVm;
    this.waitForVm = opts.waitForVm ?? waitForSshReady;
    this.startHandle = opts.startHandle ?? startWorkerRpcAgent;
    this.reconnectHandle = opts.reconnectHandle ?? reconnectWorkerRpcAgent;
    this.waitForReady = opts.waitForReady ?? waitForRpcReady;

    // Activity timeout checker
    this.activityChecker = setInterval(() => {
      const now = Date.now();
      for (const [id, agent] of this.agents) {
        if (agent.status !== "working") continue;
        const silentMs = now - agent.lastActivityAt;
        if (silentMs >= SwarmRuntime.ACTIVITY_TIMEOUT_MS) {
          console.error(
            `[swarm] Agent '${id}' silent for ${Math.round(silentMs / 1000)}s while "working" — auto-transitioning to "done"`,
          );
          agent.status = "done";
          this.clearWatchdog(id);
          this.pushLifecycle(agent, {
            type: "watchdog_alert",
            timestamp: Date.now(),
            detail: `Silent for ${Math.round(silentMs / 1000)}s, auto-completed`,
            metadata: { silentMs },
          });
          this.events.fire("swarm:agent_completed", {
            vmId: agent.vmId,
            label: id,
            task: agent.task,
            outputLength: agent.lastOutput.length,
            elapsed: Math.round(silentMs / 1000),
          });
          this.events.fire("reef:event", {
            type: "swarm_watchdog_alert",
            source: "swarm",
            name: id,
            vmId: agent.vmId,
          });
        }
      }
    }, SwarmRuntime.ACTIVITY_CHECK_INTERVAL_MS);

    if (this.activityChecker.unref) this.activityChecker.unref();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle helpers
  // ---------------------------------------------------------------------------

  private pushLifecycle(agent: SwarmAgent, event: AgentEvent): void {
    agent.lifecycle.push(event);
    if (agent.lifecycle.length > 50) agent.lifecycle.shift();
  }

  private requestUsageSnapshot(
    agent: SwarmAgent,
    options: { force?: boolean; provider?: string | null; model?: string | null; taskId?: string | null } = {},
  ): void {
    const handle = this.handles.get(agent.id);
    if (!handle?.isAlive()) return;

    const now = Date.now();
    const lastPulledAt = this.usageStatsLastPulledAt.get(agent.id) || 0;
    if (!options.force) {
      if (this.usageStatsInflight.has(agent.id)) return;
      if (now - lastPulledAt < 5000) return;
    }

    const run = (async () => {
      try {
        const stats = await handle.getSessionStats();
        this.usageStatsLastPulledAt.set(agent.id, Date.now());
        this.events.fire("usage:stats", {
          agentId: agent.vmId,
          agentName: agent.label,
          taskId: options.taskId || null,
          provider: options.provider || null,
          model: options.model || null,
          stats,
        });
      } catch {
        // Best effort; raw message usage remains available for fallback/detail.
      } finally {
        this.usageStatsInflight.delete(agent.id);
      }
    })();

    this.usageStatsInflight.set(agent.id, run);
  }

  private wireAgentEvents(agent: SwarmAgent, handle: RpcHandle): void {
    handle.onEvent((event) => {
      agent.events.push(JSON.stringify(event));
      if (agent.events.length > 200) agent.events.shift();
      agent.lastActivityAt = Date.now();

      if (event.type === "agent_start") {
        agent.status = "working";
      } else if (event.type === "agent_end") {
        const elapsed = agent.taskStartedAt ? Math.round((Date.now() - agent.taskStartedAt) / 1000) : 0;
        agent.status = "done";
        this.clearWatchdog(agent.id);
        this.requestUsageSnapshot(agent, { force: true });
        this.pushLifecycle(agent, {
          type: "completed",
          timestamp: Date.now(),
          detail: `Completed (${agent.lastOutput.length} chars, ${elapsed}s)`,
          metadata: { outputLength: agent.lastOutput.length, elapsed },
        });
        this.events.fire("swarm:agent_completed", {
          vmId: agent.vmId,
          label: agent.label,
          task: agent.task,
          outputLength: agent.lastOutput.length,
          elapsed,
        });
        this.events.fire("reef:event", {
          type: "swarm_agent_completed",
          source: "swarm",
          name: agent.label,
          vmId: agent.vmId,
        });
      } else if (event.type === "message_end" && event.message?.role === "assistant") {
        this.events.fire("usage:message", {
          agentId: agent.vmId,
          agentName: agent.label,
          taskId: null,
          message: event.message,
        });
        this.requestUsageSnapshot(agent, {
          provider: event.message.provider || event.message.api || null,
          model: event.message.model || null,
        });
      } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        agent.lastOutput += event.assistantMessageEvent.delta;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getAgents(): SwarmAgent[] {
    return Array.from(this.agents.values());
  }

  getAgent(id: string): SwarmAgent | undefined {
    return this.agents.get(id);
  }

  summary(): string {
    if (this.agents.size === 0) return "No agents in swarm.";
    const lines: string[] = [];
    for (const [id, a] of this.agents) {
      const task = a.task ? ` — ${a.task.slice(0, 60)}` : "";
      lines.push(`  ${id} [${a.status}] (${a.vmId.slice(0, 12)})${task}`);
    }
    return `Swarm (${this.agents.size} agents):\n${lines.join("\n")}`;
  }

  async spawn(params: SpawnParams): Promise<SpawnResult> {
    const resolved = await this.resolveCommitId(params.commitId);
    const llmProxyKey = params.llmProxyKey || process.env.LLM_PROXY_KEY || "";
    const model = params.model?.trim() || DEFAULT_SWARM_MODEL;
    if (!llmProxyKey) {
      throw new Error("LLM_PROXY_KEY is required to spawn agents. Add credits to your Vers account at vers.sh.");
    }

    let rootVmId = "";
    const messages: string[] = [];
    const results: AgentSpawnResult[] = [];
    const category = (params.category || "swarm_vm") as VMCategory;

    for (let i = 0; i < params.count; i++) {
      const label = params.labels?.[i] || `agent-${i + 1}`;
      let vmId: string | undefined;
      let currentStep: SpawnStepName = "create_vm";
      const spawnStart = Date.now();

      try {
        // Step 1: Create VM
        currentStep = "create_vm";
        const created = await this.createVm(resolved.commitId);
        vmId = created.vmId;
        if (i === 0) rootVmId = vmId;

        // Step 2: Register in vm_tree immediately (status: creating)
        currentStep = "register_vm_tree";
        try {
          this.vmTreeStore?.upsertVM({
            vmId,
            name: label,
            category,
            parentId: (params.parentVmId ?? process.env.VERS_VM_ID) || null,
            context: params.context,
            directive: params.directive,
            model,
            effort: params.effort,
            spawnedBy: params.spawnedBy || process.env.VERS_AGENT_NAME || "reef",
            discovery: {
              registeredVia: "swarm:spawn",
              agentLabel: label,
              parentSession: true,
              reconnectKind: category === "agent_vm" ? "agent_vm" : "swarm",
              commitId: resolved.commitId,
            },
          });
        } catch (err) {
          console.warn(
            `  [swarm] vm_tree pre-register failed for ${label}: ${err instanceof Error ? err.message : err}`,
          );
        }

        // Step 3: Wait for SSH
        currentStep = "wait_ssh";
        await this.waitForVm(vmId);

        // Step 4: Inject identity
        currentStep = "inject_identity";
        const identity = JSON.stringify({
          vmId,
          agentId: label,
          rootVmId,
          parentVmId: "local",
          depth: 1,
          maxDepth: 50,
          maxVms: 20,
          createdAt: new Date().toISOString(),
        });
        await versClient.exec(
          vmId,
          `mkdir -p /root/.swarm && cat > /root/.swarm/identity.json << 'IDENTITY_EOF'\n${identity}\nIDENTITY_EOF`,
        );

        if (i === 0) {
          await versClient.exec(vmId, `mkdir -p /root/.swarm/status && echo '{"vms":[]}' > /root/.swarm/registry.json`);
        }

        // Step 5: Copy parent's AGENTS.md with inherited context
        currentStep = "copy_agents_md";
        try {
          const parentMd = readParentAgentsMd();
          const parentName = process.env.VERS_AGENT_NAME || "reef";
          const childMd = buildChildAgentsMd(parentMd, parentName, params.context);
          await versClient.execScript(vmId, buildAgentsMdWriteScript(childMd));
        } catch (err) {
          console.error(`  [swarm] AGENTS.md copy failed for ${label}: ${err instanceof Error ? err.message : err}`);
          // Non-fatal unless context was explicitly provided
          if (params.context) {
            throw new Error(`AGENTS.md injection failed: ${err instanceof Error ? err.message : err}`);
          }
        }

        // Step 6: Start RPC agent
        currentStep = "start_rpc";
        const handle = await this.startHandle(vmId, {
          llmProxyKey,
          model,
          label,
          directive: params.directive,
          category: params.category,
          effort: params.effort,
          parentVmId: params.parentVmId || process.env.VERS_VM_ID || undefined,
          parentAgent: params.spawnedBy || process.env.VERS_AGENT_NAME || "reef",
        });

        // Step 7: Wait for RPC ready
        currentStep = "wait_rpc_ready";
        const ready = await this.waitForReady(handle, 45000);
        if (!ready) {
          await handle.kill();
          throw new Error("pi RPC failed to start within 45s");
        }

        // Step 8: Validate injection
        currentStep = "validate";
        await this.validateInjection(vmId, label, {
          expectAgentsMd: !!params.context,
          expectedEnvVars: ["REEF_CATEGORY", "VERS_AGENT_NAME"],
        });

        // === Success path ===

        // Update vm_tree to running
        try {
          this.vmTreeStore?.updateVM(vmId, {
            status: "running",
            address: `${vmId}.vm.vers.sh`,
            rpcStatus: "connected",
          });
        } catch {
          /* event handlers also update this */
        }

        // Create in-memory agent record
        const agent: SwarmAgent = {
          id: label,
          vmId,
          label,
          status: "idle",
          lastOutput: "",
          events: [],
          lifecycle: [],
          lastActivityAt: Date.now(),
          createdAt: Date.now(),
        };

        this.wireAgentEvents(agent, handle);
        this.agents.set(label, agent);
        this.handles.set(label, handle);

        this.pushLifecycle(agent, {
          type: "spawned",
          timestamp: Date.now(),
          detail: `Spawned on VM ${vmId.slice(0, 12)} (${Date.now() - spawnStart}ms)`,
          metadata: { vmId, commitId: resolved.commitId, durationMs: Date.now() - spawnStart },
        });

        // Fire events (notification-only — vm_tree already updated directly)
        this.events.fire("swarm:agent_spawned", {
          vmId,
          label,
          role: "worker",
          commitId: resolved.commitId,
          category,
          context: params.context,
          parentVmId: (params.parentVmId ?? process.env.VERS_VM_ID) || null,
          spawnedBy: params.spawnedBy || process.env.VERS_AGENT_NAME || "reef",
        });
        this.events.fire("swarm:agent_ready", { vmId, label });

        // Baseline snapshot — best effort
        currentStep = "baseline_snapshot";
        try {
          const commit = await versClient.commit(vmId);
          const cid = (commit as any)?.commitId || (commit as any)?.commit_id || (commit as any)?.id;
          if (cid) {
            const baselineId = cid;
            this.events.fire("swarm:agent_baseline", { vmId, label, commitId: baselineId });
            try {
              this.vmTreeStore?.updateVM(vmId, { baselineCommit: baselineId });
            } catch {
              /* ok */
            }
          }
        } catch {
          /* baseline snapshot is insurance, not critical */
        }

        this.events.fire("reef:event", {
          type: "swarm_agent_spawned",
          source: "swarm",
          name: label,
          vmId,
        });

        results.push({ ok: true, vmId, name: label });
        messages.push(`${label}: VM ${vmId.slice(0, 12)} — ready (${Date.now() - spawnStart}ms)`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);

        // Cleanup: mark vm_tree as error and delete the leaked VM
        if (vmId) {
          try {
            this.vmTreeStore?.updateVM(vmId, { status: "error" });
          } catch {
            /* ok */
          }
          try {
            await this.deleteVm(vmId);
          } catch {
            /* VM may not exist */
          }
          console.error(`  [swarm] ${label}: spawn failed at ${currentStep}, VM ${vmId.slice(0, 12)} cleaned up`);
        }

        results.push({ ok: false, error: errorMsg, step: currentStep, vmId });
        messages.push(`${label}: FAILED at ${currentStep} — ${errorMsg}`);
      }
    }

    return { results, agents: this.getAgents(), messages };
  }

  // ---------------------------------------------------------------------------
  // Step validation — verify AGENTS.md and env vars landed on child VM
  // ---------------------------------------------------------------------------

  private async validateInjection(
    vmId: string,
    label: string,
    opts: { expectAgentsMd: boolean; expectedEnvVars: string[] },
  ): Promise<void> {
    const failures: string[] = [];

    // Check AGENTS.md exists and is non-empty
    if (opts.expectAgentsMd) {
      try {
        const result = await versClient.exec(
          vmId,
          "test -f /root/.pi/agent/AGENTS.md && wc -c < /root/.pi/agent/AGENTS.md || echo 0",
        );
        const bytes = parseInt(String(result?.stdout ?? result).trim(), 10) || 0;
        if (bytes === 0) {
          failures.push("AGENTS.md missing or empty");
        }
      } catch {
        failures.push("AGENTS.md validation failed (SSH error)");
      }
    }

    // Batch-check env vars in a single SSH call
    if (opts.expectedEnvVars.length > 0) {
      try {
        const checkScript = opts.expectedEnvVars.map((v) => `echo "${v}=\${${v}:+SET}"`).join("; ");
        const result = await versClient.exec(vmId, `bash -l -c '${checkScript}'`);
        const output = String(result?.stdout ?? result);
        for (const envVar of opts.expectedEnvVars) {
          if (!output.includes(`${envVar}=SET`)) {
            failures.push(`${envVar} not set`);
          }
        }
      } catch {
        failures.push("env var validation failed (SSH error)");
      }
    }

    if (failures.length > 0) {
      console.warn(`  [swarm] ${label}: validation warnings: ${failures.join(", ")}`);
      // Hard-fail only if AGENTS.md is missing when context was provided
      if (failures.includes("AGENTS.md missing or empty")) {
        throw new Error(`Validation failed: ${failures.join(", ")}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Orphan cleanup — sweep VMs stuck in "creating" status
  // ---------------------------------------------------------------------------

  async cleanupOrphans(): Promise<{ cleaned: string[]; errors: string[] }> {
    if (!this.vmTreeStore) return { cleaned: [], errors: [] };

    const cutoff = Date.now() - 5 * 60 * 1000;
    const allVMs = this.vmTreeStore.listVMs({ status: "creating" as any });
    const orphans = allVMs.filter(
      (vm) =>
        vm.createdAt < cutoff &&
        vm.parentId !== null &&
        vm.category !== "infra_vm" &&
        vm.vmId !== process.env.VERS_VM_ID,
    );

    const cleaned: string[] = [];
    const errors: string[] = [];

    for (const vm of orphans) {
      try {
        // Delete the actual Vers VM (may already be gone)
        try {
          await this.deleteVm(vm.vmId);
        } catch {
          /* VM may not exist */
        }

        // Mark as error in vm_tree
        this.vmTreeStore.updateVM(vm.vmId, { status: "error" });

        // Remove from in-memory maps if present
        for (const [id, agent] of this.agents) {
          if (agent.vmId === vm.vmId) {
            this.agents.delete(id);
            this.handles.delete(id);
            break;
          }
        }

        cleaned.push(
          `${vm.name} (${vm.vmId.slice(0, 12)}): stuck creating since ${new Date(vm.createdAt).toISOString()}`,
        );
      } catch (err) {
        errors.push(`${vm.name}: cleanup failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (cleaned.length > 0) {
      console.log(`  [swarm] Orphan cleanup: cleaned ${cleaned.length} stuck VM(s)`);
    }

    return { cleaned, errors };
  }

  startOrphanCleanup(): void {
    if (this.orphanTimer) return;
    this.orphanTimer = setInterval(
      async () => {
        try {
          await this.cleanupOrphans();
        } catch (err) {
          console.error(`  [swarm] Orphan cleanup error: ${err instanceof Error ? err.message : err}`);
        }
      },
      5 * 60 * 1000,
    );
    if (this.orphanTimer.unref) this.orphanTimer.unref();
  }

  sendTask(agentId: string, task: string): void {
    const agent = this.agents.get(agentId);
    if (!agent)
      throw new NotFoundError(`Agent '${agentId}' not found. Available: ${Array.from(this.agents.keys()).join(", ")}`);

    const handle = this.handles.get(agentId);
    if (!handle) throw new Error(`No RPC handle for agent '${agentId}'`);

    agent.task = task;
    agent.status = "working";
    agent.lastOutput = "";
    agent.lastActivityAt = Date.now();
    agent.taskStartedAt = Date.now();

    handle.send({ type: "prompt", message: task });
    this.startWatchdog(agentId);

    this.pushLifecycle(agent, {
      type: "task_sent",
      timestamp: Date.now(),
      detail: `Task: ${task.slice(0, 80)}`,
      metadata: { task },
    });
    this.events.fire("swarm:agent_task_sent", { vmId: agent.vmId, label: agentId, task });
    this.events.fire("reef:event", {
      type: "swarm_task_sent",
      source: "swarm",
      name: agentId,
      prompt: task.slice(0, 120),
      vmId: agent.vmId,
    });
  }

  readOutput(agentId: string, tail?: number): { agent: SwarmAgent; output: string; warning?: string } {
    const agent = this.agents.get(agentId);
    if (!agent) throw new NotFoundError(`Agent '${agentId}' not found.`);

    let output = agent.lastOutput || "(no output yet)";
    if (tail && output.length > tail) {
      output = `...${output.slice(-tail)}`;
    }

    let warning: string | undefined;
    if (agent.status === "working") {
      const silentMinutes = Math.round((Date.now() - agent.lastActivityAt) / 60000);
      if (silentMinutes >= 2) {
        warning = `No activity for ${silentMinutes} minute${silentMinutes !== 1 ? "s" : ""} — may be stuck`;
      }
    }

    return { agent, output, warning };
  }

  async wait(
    agentIds?: string[],
    timeoutSeconds = 300,
    signal?: AbortSignal,
  ): Promise<{
    elapsed: number;
    timedOut: boolean;
    agents: Array<{ id: string; status: string; output: string; lifecycle: AgentEvent[] }>;
  }> {
    const timeout = timeoutSeconds * 1000;
    const startTime = Date.now();

    const targetIds =
      agentIds ||
      Array.from(this.agents.values())
        .filter((a) => a.status === "starting" || a.status === "working")
        .map((a) => a.id);
    const waiting = targetIds.filter((id) => {
      const a = this.agents.get(id);
      return a && (a.status === "starting" || a.status === "working");
    });

    if (waiting.length > 0) {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (signal?.aborted) {
            resolve();
            return;
          }

          const allDone = waiting.every((id) => {
            const a = this.agents.get(id);
            return !a || a.status === "done" || a.status === "error";
          });

          if (allDone || Date.now() - startTime > timeout) {
            resolve();
            return;
          }

          setTimeout(check, 250);
        };
        check();
      });
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const timedOut = waiting.some((id) => {
      const a = this.agents.get(id);
      return a && (a.status === "starting" || a.status === "working");
    });

    const agents = targetIds.map((id) => {
      const a = this.agents.get(id);
      return {
        id,
        status: a?.status || "unknown",
        output: a?.lastOutput || "(no output)",
        lifecycle: a?.lifecycle.slice(-10) || [],
      };
    });

    return { elapsed, timedOut, agents };
  }

  async destroy(agentId: string): Promise<string> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new NotFoundError(`Agent '${agentId}' not found.`);

    this.clearWatchdog(agentId);

    const handle = this.handles.get(agentId);
    if (handle) {
      try {
        await handle.kill();
      } catch {
        /* ignore */
      }
      this.handles.delete(agentId);
    }

    this.pushLifecycle(agent, {
      type: "destroyed",
      timestamp: Date.now(),
      detail: `Destroyed VM ${agent.vmId.slice(0, 12)}`,
    });

    this.events.fire("swarm:agent_destroyed", { vmId: agent.vmId, label: agentId });
    this.events.fire("reef:event", {
      type: "swarm_agent_destroyed",
      source: "swarm",
      name: agentId,
      vmId: agent.vmId,
    });

    try {
      await this.deleteVm(agent.vmId);
      this.agents.delete(agentId);
      return `${agentId}: VM ${agent.vmId.slice(0, 12)} deleted`;
    } catch (err) {
      this.agents.delete(agentId);
      return `${agentId}: failed to delete VM — ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async destroyAll(): Promise<string[]> {
    const results: string[] = [];
    for (const id of Array.from(this.agents.keys())) {
      results.push(await this.destroy(id));
    }
    return results;
  }

  async discover(): Promise<string[]> {
    const entries = (this.vmTreeStore?.listVMs() || []).filter((vm) => {
      if (vm.status === "destroyed" || vm.status === "rewound") return false;
      return (
        vm.discovery?.parentSession === true &&
        (vm.discovery?.reconnectKind === "swarm" || vm.discovery?.reconnectKind === "agent_vm")
      );
    });

    if (entries.length === 0) return ["No swarm agents found in vm-tree."];

    const settled = await Promise.allSettled(
      entries.map(async (entry): Promise<string> => {
        const vmId = entry.vmId;
        const label = entry.discovery?.agentLabel || entry.name;

        if (this.agents.has(label)) return `${label}: already connected`;

        const handle = await this.reconnectHandle(vmId);
        const probeOk = await this.waitForReady(handle, 15000);

        if (!probeOk) {
          await handle.kill();
          return `${label}: VM ${vmId.slice(0, 12)} — RPC probe failed, skipping`;
        }

        const agent: SwarmAgent = {
          id: label,
          vmId,
          label,
          status: "idle",
          lastOutput: "",
          events: [],
          lifecycle: [],
          lastActivityAt: Date.now(),
          createdAt: Date.now(),
        };

        this.wireAgentEvents(agent, handle);
        this.agents.set(label, agent);
        this.handles.set(label, handle);

        this.pushLifecycle(agent, {
          type: "spawned",
          timestamp: Date.now(),
          detail: `Reconnected to VM ${vmId.slice(0, 12)}`,
          metadata: { vmId, reconnected: true },
        });
        this.events.fire("swarm:agent_reconnected", { vmId, label, role: "worker" });
        this.events.fire("reef:event", {
          type: "swarm_agent_reconnected",
          source: "swarm",
          name: label,
          vmId,
        });

        return `${label}: VM ${vmId.slice(0, 12)} — reconnected`;
      }),
    );

    return settled.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      const label = (swarmEntries[i].metadata?.agentId as string) || swarmEntries[i].name;
      return `${label}: reconnect failed — ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`;
    });
  }

  async shutdown(): Promise<void> {
    clearInterval(this.activityChecker);
    if (this.orphanTimer) {
      clearInterval(this.orphanTimer);
      this.orphanTimer = undefined;
    }
    for (const [id] of this.watchdogs) {
      this.clearWatchdog(id);
    }
    for (const handle of this.handles.values()) {
      try {
        await handle.kill();
      } catch {
        /* ignore */
      }
    }
    this.handles.clear();
  }

  // ---------------------------------------------------------------------------
  // Watchdog — detect stuck agents via SSH file size check
  // ---------------------------------------------------------------------------

  private static readonly WATCHDOG_INTERVAL_MS = 30 * 1000;
  private static readonly WATCHDOG_SILENT_THRESHOLD_MS = 3 * 60 * 1000;

  private startWatchdog(agentId: string) {
    this.clearWatchdog(agentId);

    const agent = this.agents.get(agentId);
    const handle = this.handles.get(agentId);
    if (!agent || !handle) return;

    let lastKnownFileSize = -1;
    let fileStaleSince = 0;

    const timer = setInterval(async () => {
      if (agent.status !== "working") {
        this.clearWatchdog(agentId);
        return;
      }

      try {
        const sizeResult = await versClient.exec(handle.vmId, `stat -c%s ${RPC_OUT} 2>/dev/null || echo 0`);
        const currentSize = parseInt(sizeResult.stdout.trim(), 10) || 0;

        if (lastKnownFileSize === -1) {
          lastKnownFileSize = currentSize;
          fileStaleSince = Date.now();
          return;
        }

        if (currentSize !== lastKnownFileSize) {
          lastKnownFileSize = currentSize;
          fileStaleSince = Date.now();
          return;
        }

        const staleDuration = Date.now() - fileStaleSince;
        if (staleDuration < SwarmRuntime.WATCHDOG_SILENT_THRESHOLD_MS) return;

        const aliveCheck = await versClient.exec(
          handle.vmId,
          "tmux has-session -t pi-rpc 2>/dev/null && echo alive || echo dead",
        );

        if (aliveCheck.stdout.includes("dead")) {
          console.error(`[swarm] Agent '${agentId}' pi-rpc session is dead — marking as error`);
          agent.status = "error";
          this.pushLifecycle(agent, {
            type: "error",
            timestamp: Date.now(),
            detail: "pi-rpc session dead",
            metadata: { lastActivityAt: agent.lastActivityAt },
          });
          this.events.fire("swarm:agent_error", {
            vmId: agent.vmId,
            label: agentId,
            reason: "rpc_session_dead",
            lastActivityAt: agent.lastActivityAt,
          });
          this.events.fire("reef:event", {
            type: "swarm_agent_error",
            source: "swarm",
            name: agentId,
            error: "pi-rpc session dead",
            vmId: agent.vmId,
          });
        } else {
          console.error(
            `[swarm] Agent '${agentId}' pi alive but silent for ${Math.round(staleDuration / 1000)}s — marking as done`,
          );
          agent.status = "done";
          this.pushLifecycle(agent, {
            type: "watchdog_alert",
            timestamp: Date.now(),
            detail: `Silent for ${Math.round(staleDuration / 1000)}s, auto-completed`,
            metadata: { staleDurationMs: staleDuration },
          });
          this.events.fire("swarm:agent_completed", {
            vmId: agent.vmId,
            label: agentId,
            task: agent.task,
            outputLength: agent.lastOutput.length,
            elapsed: Math.round(staleDuration / 1000),
          });
          this.events.fire("reef:event", {
            type: "swarm_watchdog_alert",
            source: "swarm",
            name: agentId,
            vmId: agent.vmId,
          });
        }
        this.clearWatchdog(agentId);
      } catch (err) {
        console.error(
          `[swarm] watchdog check failed for '${agentId}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, SwarmRuntime.WATCHDOG_INTERVAL_MS);

    if (timer.unref) timer.unref();
    this.watchdogs.set(agentId, timer);
  }

  private clearWatchdog(agentId: string) {
    const timer = this.watchdogs.get(agentId);
    if (timer) {
      clearInterval(timer);
      this.watchdogs.delete(agentId);
    }
  }
}

// =============================================================================
// Errors
// =============================================================================

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
