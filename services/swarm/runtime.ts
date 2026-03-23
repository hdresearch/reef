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
}

export interface SwarmRuntimeOptions {
  events: ServiceEventBus;
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

function buildWorkerEnv(vmId: string, opts: { llmProxyKey?: string }): string {
  const versApiKey = process.env.VERS_API_KEY || loadVersKeyFromDisk();
  const exports = [
    opts.llmProxyKey
      ? `export LLM_PROXY_KEY='${escapeEnvValue(opts.llmProxyKey)}'`
      : process.env.LLM_PROXY_KEY
        ? `export LLM_PROXY_KEY='${escapeEnvValue(process.env.LLM_PROXY_KEY)}'`
        : "",
    opts.llmProxyKey
      ? `export ANTHROPIC_API_KEY='${escapeEnvValue(opts.llmProxyKey)}'`
      : process.env.LLM_PROXY_KEY
        ? `export ANTHROPIC_API_KEY='${escapeEnvValue(process.env.LLM_PROXY_KEY)}'`
        : "",
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
    "export REEF_CHILD_AGENT='true'",
    "export VERS_AGENT_ROLE='worker'",
    process.env.VERS_AGENT_NAME
      ? `export VERS_PARENT_AGENT='${escapeEnvValue(process.env.VERS_AGENT_NAME)}'`
      : "export VERS_PARENT_AGENT='reef'",
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
  let tailChild: ReturnType<typeof import("node:child_process").spawn> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let killed = false;
  let lineBuffer = "";
  let linesProcessed = skipExistingOutput ? -1 : 0;

  const { spawn } = require("node:child_process");

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
          handlers.emit(JSON.parse(line));
        } catch {
          // Ignore non-JSON output.
        }
      }
    });

    tailChild.on("close", () => {
      if (killed) return;
      lineBuffer = "";
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
    async kill() {
      killed = true;
      suspendTail();
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

export async function startWorkerRpcAgent(
  vmId: string,
  opts: { llmProxyKey?: string; model?: string },
): Promise<RpcHandle> {
  const sshBaseArgs = await versClient.sshArgs(vmId);
  const envExports = buildWorkerEnv(vmId, opts);

  await versClient.exec(vmId, buildPersistVmIdScript(vmId));
  await versClient.exec(vmId, buildPersistKeysScript(opts));

  const piCommand = `${resolveAgentBinary()} --mode rpc --no-session`;

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
    handle.send({ type: "set_model", provider: "vers", modelId: opts.model });
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
// Registry helpers — register/deregister swarm workers with the reef registry
// =============================================================================

async function registryPost(entry: {
  id: string;
  name: string;
  role: string;
  address: string;
  registeredBy: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const infraUrl = process.env.VERS_INFRA_URL || process.env.VERS_VM_REGISTRY_URL;
  const authToken = process.env.VERS_AUTH_TOKEN;
  if (!infraUrl || !authToken) return;
  try {
    await fetch(`${infraUrl}/registry/vms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn(`[swarm] registry post failed for ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function registryDelete(vmId: string): Promise<void> {
  const infraUrl = process.env.VERS_INFRA_URL || process.env.VERS_VM_REGISTRY_URL;
  const authToken = process.env.VERS_AUTH_TOKEN;
  if (!infraUrl || !authToken) return;
  try {
    await fetch(`${infraUrl}/registry/vms/${encodeURIComponent(vmId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* best effort */
  }
}

async function registryList(): Promise<
  Array<{
    id: string;
    name: string;
    role: string;
    address: string;
    registeredBy: string;
    metadata?: Record<string, unknown>;
  }>
> {
  const infraUrl = process.env.VERS_INFRA_URL || process.env.VERS_VM_REGISTRY_URL;
  const authToken = process.env.VERS_AUTH_TOKEN;
  if (!infraUrl || !authToken) return [];
  try {
    const res = await fetch(`${infraUrl}/registry/vms`, {
      method: "GET",
      headers: { Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    return Array.isArray(data) ? data : data.vms || [];
  } catch {
    return [];
  }
}

// =============================================================================
// Swarm Runtime
// =============================================================================

export class SwarmRuntime {
  private readonly agents = new Map<string, SwarmAgent>();
  private readonly handles = new Map<string, RpcHandle>();
  private readonly events: ServiceEventBus;
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

  // Watchdog timers per agent
  private readonly watchdogs = new Map<string, ReturnType<typeof setInterval>>();

  constructor(opts: SwarmRuntimeOptions) {
    this.events = opts.events;
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

  async spawn(params: SpawnParams): Promise<{ agents: SwarmAgent[]; messages: string[] }> {
    const resolved = await this.resolveCommitId(params.commitId);
    const llmProxyKey = params.llmProxyKey || process.env.LLM_PROXY_KEY || "";
    const model = params.model?.trim() || DEFAULT_SWARM_MODEL;
    if (!llmProxyKey) {
      throw new Error("LLM_PROXY_KEY is required to spawn swarm agents.");
    }

    let rootVmId = "";
    const messages: string[] = [];

    for (let i = 0; i < params.count; i++) {
      const label = params.labels?.[i] || `agent-${i + 1}`;

      try {
        // Restore VM from golden commit
        const { vmId } = await this.createVm(resolved.commitId);
        if (i === 0) rootVmId = vmId;

        // Wait for boot
        await this.waitForVm(vmId);

        // Inject identity
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

        // Start RPC agent
        const handle = await this.startHandle(vmId, { llmProxyKey, model });

        // Wait for RPC ready
        const ready = await this.waitForReady(handle, 45000);
        if (!ready) {
          await handle.kill();
          messages.push(`${label}: VM ${vmId.slice(0, 12)} booted but pi RPC failed to start`);
          continue;
        }

        // Create agent record
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

        // Lifecycle + events
        this.pushLifecycle(agent, {
          type: "spawned",
          timestamp: Date.now(),
          detail: `Spawned on VM ${vmId.slice(0, 12)}`,
          metadata: { vmId, commitId: resolved.commitId },
        });

        // Register in coordination registry
        await registryPost({
          id: vmId,
          name: label,
          role: "worker",
          address: `${vmId}.vm.vers.sh`,
          registeredBy: "reef-swarm",
          metadata: { agentId: label, commitId: resolved.commitId, parentSession: true },
        });

        messages.push(`${label}: VM ${vmId.slice(0, 12)} — ready`);
        this.events.fire("swarm:agent_spawned", { vmId, label, role: "worker", commitId: resolved.commitId });
        this.events.fire("reef:event", {
          type: "swarm_agent_spawned",
          source: "swarm",
          name: label,
          vmId,
        });
      } catch (err) {
        messages.push(`${label}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { agents: this.getAgents(), messages };
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

    const targetIds = agentIds || Array.from(this.agents.keys());
    const waiting = targetIds.filter((id) => {
      const a = this.agents.get(id);
      return a && (a.status === "working" || a.status === "idle");
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

          setTimeout(check, 2000);
        };
        check();
      });
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const timedOut = waiting.some((id) => {
      const a = this.agents.get(id);
      return a && a.status === "working";
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

    await registryDelete(agent.vmId);
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
    const entries = await registryList();
    const swarmEntries = entries.filter((e) => e.registeredBy === "reef-swarm" && e.metadata?.parentSession === true);

    if (swarmEntries.length === 0) return ["No swarm agents found in registry."];

    const settled = await Promise.allSettled(
      swarmEntries.map(async (entry): Promise<string> => {
        const vmId = entry.id;
        const label = (entry.metadata?.agentId as string) || entry.name;

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
