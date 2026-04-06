/**
 * Lieutenant runtime — manages the lifecycle of lieutenant pi processes.
 *
 * Bridges the persistent SQLite store with live RPC handles.
 */

import { existsSync, readFileSync } from "node:fs";
import { type ResolveGoldenCommitResult, resolveGoldenCommit, VersClient } from "@hdresearch/pi-v/core";
import { buildChildAgentsMd, readParentAgentsMd } from "../../src/core/agents-md.js";
import type { ServiceEventBus } from "../../src/core/events.js";
import type { VMTreeStore } from "../vm-tree/store.js";
import {
  buildSystemPrompt,
  createVersVmFromCommit,
  deleteVersVm,
  getVersVmState,
  type RpcHandle,
  reconnectRemoteRpcAgent,
  setVersVmState,
  startRemoteRpcAgent,
  waitForRemoteRpcSession,
  waitForRpcReady,
  waitForSshReady,
} from "./rpc.js";
import type { Lieutenant, LieutenantStore } from "./store.js";
import { ConflictError, NotFoundError, ValidationError } from "./store.js";

const versClient = new VersClient();

export interface LieutenantRuntimeOptions {
  events: ServiceEventBus;
  store: LieutenantStore;
  vmTreeStore?: VMTreeStore;
  fetchImpl?: typeof fetch;
  getVmState?: typeof getVersVmState;
  resolveCommitId?: (commitId?: string) => Promise<ResolveGoldenCommitResult>;
  waitForRemoteVm?: typeof waitForSshReady;
  waitForRemoteSession?: typeof waitForRemoteRpcSession;
  startRemoteHandle?: typeof startRemoteRpcAgent;
  reconnectRemoteHandle?: typeof reconnectRemoteRpcAgent;
}

interface CreateParams {
  name: string;
  role: string;
  llmProxyKey?: string;
  model?: string;
  commitId?: string;
  context?: string; // v2: situational context appended to inherited AGENTS.md
  directive?: string; // v2: hard guardrails (VERS_AGENT_DIRECTIVE)
  parentVmId?: string | null;
  spawnedBy?: string;
}

export const DEFAULT_LIEUTENANT_MODEL = "claude-opus-4-6";

function readProfileContext(): string {
  try {
    const storePath = "data/store.json";
    if (!existsSync(storePath)) return "";
    const store = JSON.parse(readFileSync(storePath, "utf-8"));
    const profile = store["reef:profile"]?.value;
    if (!profile) return "";
    const parts: string[] = [];
    if (profile.name) parts.push(`User name: ${profile.name}`);
    if (profile.timezone) parts.push(`Timezone: ${profile.timezone}`);
    if (profile.location) parts.push(`Location: ${profile.location}`);
    if (profile.preferences) parts.push(`Preferences: ${profile.preferences}`);
    return parts.length > 0 ? `[user profile]\n${parts.join("\n")}` : "";
  } catch {
    return "";
  }
}

export class LieutenantRuntime {
  private readonly handles = new Map<string, RpcHandle>();
  private readonly usageStatsInflight = new Map<string, Promise<void>>();
  private readonly usageStatsLastPulledAt = new Map<string, number>();
  private readonly events: ServiceEventBus;
  private readonly store: LieutenantStore;
  private readonly vmTreeStore?: VMTreeStore;
  private readonly fetchImpl: typeof fetch;
  private readonly getVmState: typeof getVersVmState;
  private readonly resolveCommitId: (commitId?: string) => Promise<ResolveGoldenCommitResult>;
  private readonly waitForRemoteVm: typeof waitForSshReady;
  private readonly waitForRemoteSession: typeof waitForRemoteRpcSession;
  private readonly startRemoteHandle: typeof startRemoteRpcAgent;
  private readonly reconnectRemoteHandle: typeof reconnectRemoteRpcAgent;

  constructor(opts: LieutenantRuntimeOptions) {
    this.events = opts.events;
    this.store = opts.store;
    this.vmTreeStore = opts.vmTreeStore;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.getVmState = opts.getVmState ?? getVersVmState;
    this.resolveCommitId = opts.resolveCommitId ?? ((commitId) => resolveGoldenCommit({ commitId, ensure: true }));
    this.waitForRemoteVm = opts.waitForRemoteVm ?? waitForSshReady;
    this.waitForRemoteSession = opts.waitForRemoteSession ?? waitForRemoteRpcSession;
    this.startRemoteHandle = opts.startRemoteHandle ?? startRemoteRpcAgent;
    this.reconnectRemoteHandle = opts.reconnectRemoteHandle ?? reconnectRemoteRpcAgent;
  }

  private ensureNameAvailable(name: string): void {
    const existing = this.store.getByName(name);
    if (existing && existing.status !== "destroyed") {
      throw new ConflictError(`Lieutenant '${name}' already exists. Destroy it first or use a different name.`);
    }
  }

  private buildCreateEvent(lt: Lieutenant, extra: Record<string, unknown> = {}) {
    return {
      name: lt.name,
      vmId: lt.vmId,
      role: lt.role,
      address: `${lt.vmId}.vm.vers.sh`,
      createdAt: lt.createdAt,
      parentVmId: ((extra.parentVmId as string | null | undefined) ?? process.env.VERS_VM_ID) || null,
      ...extra,
    };
  }

  private async reconnectLieutenantHandle(name: string, vmId: string): Promise<RpcHandle> {
    const existing = this.handles.get(name);
    if (existing?.isAlive()) {
      return existing;
    }

    const handle = await this.reconnectRemoteHandle(vmId);
    this.handles.set(name, handle);
    this.installEventHandler(name);
    return handle;
  }

  private async ensureRemoteHandle(name: string, lt: Lieutenant): Promise<RpcHandle> {
    if (!lt.vmId) throw new ValidationError(`Lieutenant '${name}' has no VM attached`);

    const existing = this.handles.get(name);
    if (existing?.isAlive()) {
      return existing;
    }

    await this.waitForRemoteSession(lt.vmId);
    return this.reconnectLieutenantHandle(name, lt.vmId);
  }

  private requestUsageSnapshot(
    name: string,
    lt: Lieutenant,
    options: { force?: boolean; provider?: string | null; model?: string | null; taskId?: string | null } = {},
  ): void {
    const handle = this.handles.get(name);
    if (!handle?.isAlive()) return;

    const now = Date.now();
    const lastPulledAt = this.usageStatsLastPulledAt.get(name) || 0;
    if (!options.force) {
      if (this.usageStatsInflight.has(name)) return;
      if (now - lastPulledAt < 5000) return;
    }

    const run = (async () => {
      try {
        const stats = await handle.getSessionStats();
        this.usageStatsLastPulledAt.set(name, Date.now());
        this.events.fire("usage:stats", {
          agentId: lt.vmId,
          agentName: lt.name,
          taskId: options.taskId || null,
          provider: options.provider || null,
          model: options.model || null,
          stats,
        });
      } catch {
        // Best effort: raw per-message usage still exists as a fallback.
      } finally {
        this.usageStatsInflight.delete(name);
      }
    })();

    this.usageStatsInflight.set(name, run);
  }

  private async syncRemoteLieutenant(input: string | Lieutenant): Promise<Lieutenant | undefined> {
    const lt = typeof input === "string" ? this.store.getByName(input) : input;
    if (!lt || !lt.vmId) return lt;

    const treeVm = this.vmTreeStore?.getVM(lt.vmId);
    if (treeVm) {
      if (treeVm.status === "destroyed" || treeVm.status === "rewound") {
        return this.store.update(lt.name, { status: "destroyed" });
      }
      if (treeVm.status === "stopped") {
        return this.store.update(lt.name, { status: "stopped" });
      }
      if (treeVm.status === "paused") {
        return this.store.update(lt.name, { status: "paused" });
      }
      if (treeVm.status === "error") {
        return this.store.update(lt.name, { status: "error" });
      }
    }

    try {
      const vmState = await this.getVmState(lt.vmId);
      if (vmState === "Paused" || vmState === "paused") {
        return this.store.update(lt.name, { status: "paused" });
      }
      if (vmState !== "Running" && vmState !== "running") {
        return this.store.update(lt.name, { status: "error" });
      }
    } catch {
      return this.store.update(lt.name, { status: "error" });
    }

    try {
      await this.ensureRemoteHandle(lt.name, lt);
      const nextStatus = lt.status === "working" ? "working" : "idle";
      return this.store.update(lt.name, { status: nextStatus });
    } catch {
      return this.store.update(lt.name, { status: "error" });
    }
  }

  async refresh(name: string): Promise<Lieutenant | undefined> {
    return this.syncRemoteLieutenant(name);
  }

  async refreshAll(): Promise<void> {
    for (const lt of this.store.list()) {
      await this.syncRemoteLieutenant(lt);
    }
  }

  async registerRemote(params: {
    name: string;
    role: string;
    vmId: string;
    parentAgent?: string;
  }): Promise<Lieutenant> {
    const { name, role, vmId, parentAgent } = params;
    this.ensureNameAvailable(name);

    const lt = this.store.create({
      name,
      role,
      vmId,
      parentAgent,
    });

    await this.syncRemoteLieutenant(lt);
    const registered = this.store.getByName(name)!;
    this.events.fire("lieutenant:created", this.buildCreateEvent(registered, { reconnected: true }));
    return registered;
  }

  async create(params: CreateParams): Promise<Lieutenant> {
    const { name, role, commitId, llmProxyKey, model } = params;
    this.ensureNameAvailable(name);

    const systemPrompt = buildSystemPrompt(name, role, readProfileContext());
    const resolvedLlmProxyKey = llmProxyKey || process.env.LLM_PROXY_KEY;
    const resolvedModel = model?.trim() || DEFAULT_LIEUTENANT_MODEL;
    if (!resolvedLlmProxyKey) {
      throw new ValidationError("LLM_PROXY_KEY is required. Set it in the environment or pass an override.");
    }

    this.store.create({
      name,
      role,
      systemPrompt,
      model: resolvedModel,
      parentAgent: process.env.VERS_AGENT_NAME,
    });

    let vmId: string | undefined;
    try {
      const resolvedCommit = await this.resolveCommitId(commitId);
      const remote = await createVersVmFromCommit(resolvedCommit.commitId);
      vmId = remote.vmId;
      this.store.update(name, { vmId });

      // Register in vm_tree immediately with status: creating
      try {
        this.vmTreeStore?.upsertVM({
          vmId,
          name,
          category: "lieutenant",
          parentId: (params.parentVmId ?? process.env.VERS_VM_ID) || null,
          context: params.context,
          directive: params.directive,
          model: resolvedModel,
          spawnedBy: params.spawnedBy || process.env.VERS_AGENT_NAME || "reef",
          discovery: {
            registeredVia: "lieutenant:create",
            agentLabel: name,
            reconnectKind: "lieutenant",
            commitId: resolved.commitId,
            roleHint: role,
          },
        });
      } catch (err) {
        console.warn(
          `  [lieutenant] vm_tree pre-register failed for ${name}: ${err instanceof Error ? err.message : err}`,
        );
      }

      await this.waitForRemoteVm(vmId);

      // v2: Build inherited AGENTS.md with context
      let agentsMd: string | undefined;
      try {
        const parentMd = readParentAgentsMd();
        const parentName = process.env.VERS_AGENT_NAME || "reef";
        agentsMd = buildChildAgentsMd(parentMd, parentName, params.context);
      } catch (err) {
        console.error(`  [lieutenant] AGENTS.md build failed for ${name}: ${err instanceof Error ? err.message : err}`);
        if (params.context) {
          throw new Error(`AGENTS.md injection failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      const handle = await this.startRemoteHandle(vmId, {
        name,
        llmProxyKey: resolvedLlmProxyKey,
        model: resolvedModel,
        systemPrompt,
        agentsMd,
        directive: params.directive,
        parentVmId: params.parentVmId || process.env.VERS_VM_ID || undefined,
        parentAgent: params.spawnedBy || process.env.VERS_AGENT_NAME || "reef",
      });
      this.handles.set(name, handle);

      const ready = await waitForRpcReady(handle, 45_000);
      if (!ready) throw new Error(`Pi RPC failed to start on ${vmId}`);

      // Validate AGENTS.md and env vars
      await this.validateInjection(vmId, name, {
        expectAgentsMd: !!params.context,
        expectedEnvVars: ["REEF_CATEGORY", "VERS_AGENT_NAME"],
      });

      this.store.update(name, { status: "idle" });
      this.installEventHandler(name);

      // Update vm_tree to running
      try {
        this.vmTreeStore?.updateVM(vmId, {
          status: "running",
          address: `${vmId}.vm.vers.sh`,
          rpcStatus: "connected",
        });
      } catch {
        /* event handlers also update */
      }

      const created = this.store.getByName(name)!;
      this.events.fire(
        "lieutenant:created",
        this.buildCreateEvent(created, {
          commitId: resolvedCommit.commitId,
          commitIdSource: resolvedCommit.source,
          model,
          llmProxyKeyProvided: !!llmProxyKey,
          parentVmId: (params.parentVmId ?? process.env.VERS_VM_ID) || null,
        }),
      );
      return created;
    } catch (err) {
      // Mark vm_tree as error before cleaning up
      if (vmId) {
        try {
          this.vmTreeStore?.updateVM(vmId, { status: "error" });
        } catch {
          /* ok */
        }
      }
      await this.cleanupFailedCreate(name);
      throw err;
    }
  }

  private async validateInjection(
    vmId: string,
    label: string,
    opts: { expectAgentsMd: boolean; expectedEnvVars: string[] },
  ): Promise<void> {
    const failures: string[] = [];

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
      console.warn(`  [lieutenant] ${label}: validation warnings: ${failures.join(", ")}`);
      if (failures.includes("AGENTS.md missing or empty")) {
        throw new Error(`Validation failed: ${failures.join(", ")}`);
      }
    }
  }

  private async cleanupFailedCreate(name: string): Promise<void> {
    const lt = this.store.getByName(name);
    const handle = this.handles.get(name);
    if (handle) {
      try {
        await handle.kill();
      } catch {
        // Ignore failed cleanup while unwinding create errors.
      }
      this.handles.delete(name);
    }

    if (lt?.vmId) {
      try {
        await deleteVersVm(lt.vmId);
      } catch {
        // Ignore cleanup failures; the user will see the original error.
      }
    }

    if (lt) {
      this.store.destroy(name);
    }
  }

  async send(
    name: string,
    message: string,
    mode?: "prompt" | "steer" | "followUp",
    postTaskDisposition?: "stay_idle" | "stop_when_done",
  ): Promise<{ sent: boolean; mode: string; note?: string }> {
    const lt = this.store.getByName(name);
    if (!lt || lt.status === "destroyed") throw new NotFoundError(`Lieutenant '${name}' not found`);
    const treeVm = lt.vmId ? this.vmTreeStore?.getVM(lt.vmId) : undefined;
    if (treeVm?.status === "destroyed" || treeVm?.status === "rewound") {
      this.store.update(name, { status: "destroyed" });
      throw new NotFoundError(`Lieutenant '${name}' not found`);
    }
    if (treeVm?.status === "stopped") {
      this.store.update(name, { status: "stopped" });
      throw new ValidationError(`Lieutenant '${name}' is stopped and is not a live task target.`);
    }
    if (treeVm?.status === "paused") {
      this.store.update(name, { status: "paused" });
      throw new ValidationError(`Lieutenant '${name}' is paused. Resume it first.`);
    }
    if (treeVm?.status === "error") {
      this.store.update(name, { status: "error" });
      throw new ValidationError(`Lieutenant '${name}' is in error state and is not a live task target.`);
    }
    if (lt.status === "stopped") {
      throw new ValidationError(`Lieutenant '${name}' is stopped and is not a live task target.`);
    }
    if (lt.status === "paused") throw new ValidationError(`Lieutenant '${name}' is paused. Resume it first.`);

    let handle = this.handles.get(name);
    if (!handle || !handle.isAlive()) {
      handle = await this.ensureRemoteHandle(name, lt);
    }
    if (!handle || !handle.isAlive()) {
      throw new ValidationError(`No active RPC connection for '${name}'`);
    }

    let actualMode = mode || "prompt";
    let note: string | undefined;

    if (lt.status === "working" && actualMode === "prompt") {
      actualMode = "followUp";
      note = "auto-queued as follow-up since lieutenant is working";
    }

    if (this.vmTreeStore && lt.vmId && postTaskDisposition) {
      this.vmTreeStore.updateVM(lt.vmId, { postTaskDisposition });
    }

    if (actualMode === "prompt") {
      this.store.update(name, { taskCount: lt.taskCount + 1, lastOutput: "" });
      handle.send({ type: "prompt", message });
    } else if (actualMode === "steer") {
      handle.send({ type: "steer", message });
    } else {
      handle.send({ type: "follow_up", message });
    }

    this.store.update(name, { lastActivityAt: new Date().toISOString() });
    return { sent: true, mode: actualMode, note };
  }

  async pause(name: string): Promise<{ paused: boolean }> {
    const lt = this.store.getByName(name);
    if (!lt || lt.status === "destroyed") throw new NotFoundError(`Lieutenant '${name}' not found`);
    if (lt.status === "paused") return { paused: true };
    if (lt.status === "working") {
      throw new ValidationError(`Lieutenant '${name}' is working. Wait for it to finish or steer it first.`);
    }
    if (!lt.vmId) throw new ValidationError(`Lieutenant '${name}' has no VM attached`);

    const handle = this.handles.get(name);
    handle?.suspendTail?.();

    await setVersVmState(lt.vmId, "Paused");
    this.store.update(name, { status: "paused" });
    this.events.fire("lieutenant:paused", this.buildCreateEvent(this.store.getByName(name)!));
    return { paused: true };
  }

  async resume(name: string): Promise<{ resumed: boolean }> {
    const lt = this.store.getByName(name);
    if (!lt || lt.status === "destroyed") throw new NotFoundError(`Lieutenant '${name}' not found`);
    if (lt.status !== "paused") {
      throw new ValidationError(`Lieutenant '${name}' is not paused (status: ${lt.status})`);
    }
    if (!lt.vmId) throw new ValidationError(`Lieutenant '${name}' has no VM attached`);

    await setVersVmState(lt.vmId, "Running");
    await this.waitForRemoteVm(lt.vmId);
    const existingHandle = this.handles.get(name);
    if (existingHandle?.reconnectTail) {
      await this.waitForRemoteSession(lt.vmId);
      existingHandle.reconnectTail();
      this.store.update(name, { status: "idle" });
    } else {
      await this.ensureRemoteHandle(name, lt);
      this.store.update(name, { status: "idle" });
    }
    this.events.fire("lieutenant:resumed", this.buildCreateEvent(this.store.getByName(name)!));
    return { resumed: true };
  }

  async destroy(name: string): Promise<{ destroyed: boolean; detail: string }> {
    const lt = this.store.getByName(name);
    if (!lt || lt.status === "destroyed") throw new NotFoundError(`Lieutenant '${name}' not found`);

    const handle = this.handles.get(name);
    if (handle) {
      try {
        await handle.kill();
      } catch {
        // Ignore shutdown races.
      }
      this.handles.delete(name);
    }

    if (lt.vmId) {
      try {
        if (lt.status === "paused") {
          await setVersVmState(lt.vmId, "Running");
        }
      } catch {
        // Continue to delete attempt regardless.
      }

      await deleteVersVm(lt.vmId);
    }

    this.store.destroy(name);
    this.events.fire("lieutenant:destroyed", this.buildCreateEvent(lt));

    const detail = `${name}: destroyed (VM ${lt.vmId.slice(0, 12)}, ${lt.taskCount} tasks completed)`;

    return { destroyed: true, detail };
  }

  async destroyAll(): Promise<string[]> {
    const results: string[] = [];
    for (const name of this.store.names()) {
      try {
        const result = await this.destroy(name);
        results.push(result.detail);
      } catch (err) {
        results.push(`${name}: failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return results;
  }

  async discover(): Promise<string[]> {
    const results: string[] = [];
    const candidates = new Map<string, Lieutenant>();

    for (const lt of this.store.list()) {
      if (lt.vmId) candidates.set(lt.name, lt);
    }

    const discovered = (this.vmTreeStore?.listVMs({ category: "lieutenant" }) || []).filter(
      (vm) => vm.status !== "destroyed" && vm.status !== "rewound",
    );
    for (const vm of discovered) {
      const name = vm.discovery?.agentLabel || vm.name;
      if (candidates.has(name)) continue;
      const lt = this.store.create({
        name,
        role: vm.discovery?.roleHint || "recovered lieutenant",
        vmId: vm.vmId,
      });
      candidates.set(name, lt);
    }

    for (const [name, candidate] of candidates) {
      try {
        const refreshed = await this.syncRemoteLieutenant(candidate);
        const status = refreshed?.status || candidate.status;
        results.push(`${name}: available (${status}, VM ${candidate.vmId.slice(0, 12)})`);
      } catch (err) {
        results.push(`${name}: discovery failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return results.length > 0 ? results : ["No lieutenants found"];
  }

  async rehydrate(): Promise<void> {
    const reconnectResults = await this.discover();
    const meaningfulResults = reconnectResults.filter((line) => !line.startsWith("No lieutenants"));
    if (meaningfulResults.length > 0) {
      console.error(`  [lieutenant] rehydrate: ${meaningfulResults.join("; ")}`);
    }
  }

  private installEventHandler(name: string): void {
    const handle = this.handles.get(name);
    if (!handle) return;

    handle.onEvent((event) => {
      const lt = this.store.getByName(name);
      if (!lt || lt.status === "destroyed") return;

      if (event.type === "agent_start") {
        this.store.update(name, { status: "working", lastOutput: "" });
        return;
      }

      if (event.type === "agent_end") {
        this.store.rotateOutput(name);
        this.store.update(name, { status: "idle" });

        const completed = this.store.getByName(name);
        this.requestUsageSnapshot(name, completed || lt, {
          force: true,
          model: completed?.model || lt.model || null,
        });
        const rawOutput = completed?.outputHistory.at(-1)?.trim() || lt.lastOutput.trim();
        const summary = rawOutput.length > 200 ? `...${rawOutput.slice(-200)}` : rawOutput;
        const hasError = /\b(error|failed|exception|fatal)\b/i.test(rawOutput.slice(-500));

        this.events.fire("lieutenant:completed", {
          ...this.buildCreateEvent(completed || lt),
          status: hasError ? "error" : "success",
          summary,
          taskCount: completed?.taskCount ?? lt.taskCount,
        });
        return;
      }

      if (event.type === "message_end" && event.message?.role === "assistant") {
        this.events.fire("usage:message", {
          agentId: lt.vmId,
          agentName: lt.name,
          taskId: null,
          message: event.message,
        });
        this.requestUsageSnapshot(name, lt, {
          provider: event.message.provider || event.message.api || null,
          model: event.message.model || lt.model || null,
        });
        return;
      }

      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        this.store.appendOutput(name, event.assistantMessageEvent.delta);
      }
    });
  }

  async shutdown(): Promise<void> {
    for (const [name, handle] of this.handles) {
      try {
        await handle.kill();
      } catch {
        console.error(`  [lieutenant] failed to kill handle for ${name}`);
      }
    }
    this.handles.clear();
  }
}
