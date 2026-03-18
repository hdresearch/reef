/**
 * Lieutenant runtime — manages the lifecycle of lieutenant pi processes.
 *
 * Bridges the persistent SQLite store with live RPC handles.
 */

import type { ServiceEventBus } from "../../src/core/events.js";
import {
  buildSystemPrompt,
  createVersVmFromCommit,
  deleteVersVm,
  getVersVmState,
  type RpcHandle,
  reconnectRemoteRpcAgent,
  setVersVmState,
  startLocalRpcAgent,
  startRemoteRpcAgent,
  waitForRemoteRpcSession,
  waitForRpcReady,
  waitForSshReady,
} from "./rpc.js";
import type { Lieutenant, LieutenantStore } from "./store.js";
import { ConflictError, NotFoundError, ValidationError } from "./store.js";

export interface LieutenantRuntimeOptions {
  events: ServiceEventBus;
  store: LieutenantStore;
  fetchImpl?: typeof fetch;
  getVmState?: typeof getVersVmState;
}

interface CreateParams {
  name: string;
  role: string;
  isLocal?: boolean;
  anthropicApiKey?: string;
  model?: string;
  commitId?: string;
}

export class LieutenantRuntime {
  private readonly handles = new Map<string, RpcHandle>();
  private readonly events: ServiceEventBus;
  private readonly store: LieutenantStore;
  private readonly fetchImpl: typeof fetch;
  private readonly getVmState: typeof getVersVmState;

  constructor(opts: LieutenantRuntimeOptions) {
    this.events = opts.events;
    this.store = opts.store;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.getVmState = opts.getVmState ?? getVersVmState;
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
      isLocal: lt.isLocal,
      address: lt.isLocal ? null : `${lt.vmId}.vm.vers.sh`,
      createdAt: lt.createdAt,
      parentVmId: process.env.VERS_VM_ID || null,
      ...extra,
    };
  }

  private remoteBaseUrl(lt: Lieutenant): string {
    return `https://${lt.vmId}.vm.vers.sh:3000`;
  }

  private remoteTaskId(name: string): string {
    return `lt-${name}`;
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.VERS_AUTH_TOKEN) {
      headers.Authorization = `Bearer ${process.env.VERS_AUTH_TOKEN}`;
    }
    return headers;
  }

  private async remoteRequest<T>(
    lt: Lieutenant,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; payload: T | null }> {
    const response = await this.fetchImpl(`${this.remoteBaseUrl(lt)}${path}`, {
      method,
      headers: this.authHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    const payload = text ? (JSON.parse(text) as T) : null;
    return { status: response.status, payload };
  }

  private extractRemoteOutput(task: any): string {
    const nodes = Array.isArray(task?.nodes) ? task.nodes : [];
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      if (node?.role === "assistant" && typeof node.content === "string" && node.content.trim()) {
        return node.content.trim();
      }
    }

    if (typeof task?.artifacts?.summary === "string" && task.artifacts.summary.trim()) {
      return task.artifacts.summary.trim();
    }

    return "";
  }

  private async waitForRemoteReef(lt: Lieutenant, timeoutMs = 60_000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const response = await this.fetchImpl(`${this.remoteBaseUrl(lt)}/health`);
        if (response.ok) return;
      } catch {
        // retry until timeout
      }
      await Bun.sleep(2_000);
    }

    throw new Error(`Timed out waiting for reef health on ${lt.vmId}`);
  }

  private async syncRemoteLieutenant(input: string | Lieutenant): Promise<Lieutenant | undefined> {
    const lt = typeof input === "string" ? this.store.getByName(input) : input;
    if (!lt || lt.isLocal) return lt;
    if (this.handles.get(lt.name)?.isAlive()) return lt;
    if (!lt.vmId) return lt;

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

    let taskPayload: any = null;
    try {
      const task = await this.remoteRequest<any>(
        lt,
        "GET",
        `/reef/tasks/${encodeURIComponent(this.remoteTaskId(lt.name))}`,
      );
      if (task.status === 404) {
        return this.store.update(lt.name, { status: "idle" });
      }
      if (task.status >= 400 || !task.payload) {
        return this.store.update(lt.name, { status: "error" });
      }
      taskPayload = task.payload;
    } catch {
      return this.store.update(lt.name, { status: "error" });
    }

    const taskStatus = taskPayload?.status;
    if (taskStatus === "running") {
      return this.store.update(lt.name, { status: "working" });
    }

    const nextStatus = taskStatus === "error" ? "error" : "idle";
    const output = this.extractRemoteOutput(taskPayload);
    const current = this.store.getByName(lt.name);
    const lastHistory = current?.outputHistory.at(-1) || "";

    if (output && output !== lastHistory) {
      this.store.update(lt.name, { status: nextStatus, lastOutput: output });
      this.store.rotateOutput(lt.name);
    } else {
      this.store.update(lt.name, { status: nextStatus });
    }

    return this.store.getByName(lt.name);
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
      isLocal: false,
      parentAgent,
    });

    await this.syncRemoteLieutenant(lt);
    return this.store.getByName(name)!;
  }

  async create(params: CreateParams): Promise<Lieutenant> {
    const { name, role, isLocal = false, commitId, anthropicApiKey, model } = params;
    this.ensureNameAvailable(name);

    const systemPrompt = buildSystemPrompt(name, role);
    const apiKey = anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ValidationError("ANTHROPIC_API_KEY is required. Pass anthropicApiKey or set it in the environment.");
    }

    this.store.create({
      name,
      role,
      isLocal,
      systemPrompt,
      model,
      parentAgent: process.env.VERS_AGENT_NAME,
    });

    try {
      if (isLocal) {
        const handle = await startLocalRpcAgent(name, {
          anthropicApiKey: apiKey,
          model,
          systemPrompt,
        });
        this.handles.set(name, handle);

        const ready = await waitForRpcReady(handle);
        if (!ready) throw new Error(`Local pi RPC failed to start for "${name}"`);

        this.store.update(name, { status: "idle", vmId: handle.vmId });
        this.installEventHandler(name);
      } else {
        if (!commitId) {
          throw new ValidationError("commitId is required for remote lieutenants");
        }

        const remote = await createVersVmFromCommit(commitId);
        this.store.update(name, { vmId: remote.vmId });
        await waitForSshReady(remote.vmId);

        const handle = await startRemoteRpcAgent(remote.vmId, {
          anthropicApiKey: apiKey,
          model,
          systemPrompt,
        });
        this.handles.set(name, handle);

        const ready = await waitForRpcReady(handle, 45_000);
        if (!ready) throw new Error(`Pi RPC failed to start on ${remote.vmId}`);

        this.store.update(name, { status: "idle" });
        this.installEventHandler(name);
      }

      const created = this.store.getByName(name)!;
      this.events.fire(
        "lieutenant:created",
        this.buildCreateEvent(created, { commitId, model, anthropicApiKeyProvided: !!anthropicApiKey }),
      );
      return created;
    } catch (err) {
      await this.cleanupFailedCreate(name);
      throw err;
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

    if (lt?.vmId && !lt.isLocal) {
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
  ): Promise<{ sent: boolean; mode: string; note?: string }> {
    const lt = this.store.getByName(name);
    if (!lt || lt.status === "destroyed") throw new NotFoundError(`Lieutenant '${name}' not found`);
    if (lt.status === "paused") throw new ValidationError(`Lieutenant '${name}' is paused. Resume it first.`);

    const handle = this.handles.get(name);
    if (!handle || !handle.isAlive()) {
      if (lt.isLocal) {
        throw new ValidationError(`No active RPC connection for '${name}'`);
      }

      const current = (await this.syncRemoteLieutenant(name)) || this.store.getByName(name);
      if (!current) throw new NotFoundError(`Lieutenant '${name}' not found`);
      if (current.status === "paused") {
        throw new ValidationError(`Lieutenant '${name}' is paused. Resume it first.`);
      }
      if (current.status === "working") {
        throw new ValidationError(
          `Lieutenant '${name}' is already working. Remote reef lieutenants do not support queued follow-ups or steer yet.`,
        );
      }

      let actualMode = mode || "prompt";
      let note: string | undefined;
      if (actualMode === "steer") {
        actualMode = "followUp";
        note = "steer is treated as a follow-up continuation for remote reef lieutenants";
      }

      const existingTask = await this.remoteRequest<any>(
        current,
        "GET",
        `/reef/tasks/${encodeURIComponent(this.remoteTaskId(name))}`,
      );
      const body: Record<string, string> = {
        task: message,
        taskId: this.remoteTaskId(name),
      };
      if (existingTask.status !== 404 && existingTask.payload?.leafId) {
        body.parentId = existingTask.payload.leafId;
      }

      const submitted = await this.remoteRequest<any>(current, "POST", "/reef/submit", body);
      if (submitted.status >= 400) {
        throw new ValidationError(`Remote reef submit failed for '${name}'`);
      }

      this.store.update(name, {
        status: "working",
        taskCount: current.taskCount + 1,
        lastOutput: "",
      });
      return { sent: true, mode: actualMode, note };
    }

    let actualMode = mode || "prompt";
    let note: string | undefined;

    if (lt.status === "working" && actualMode === "prompt") {
      actualMode = "followUp";
      note = "auto-queued as follow-up since lieutenant is working";
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
    if (lt.isLocal) throw new ValidationError(`Lieutenant '${name}' is local — pause/resume requires a VM`);
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
    if (lt.isLocal) throw new ValidationError(`Lieutenant '${name}' is local — pause/resume requires a VM`);
    if (lt.status !== "paused") {
      throw new ValidationError(`Lieutenant '${name}' is not paused (status: ${lt.status})`);
    }
    if (!lt.vmId) throw new ValidationError(`Lieutenant '${name}' has no VM attached`);

    await setVersVmState(lt.vmId, "Running");
    const existingHandle = this.handles.get(name);
    if (existingHandle?.reconnectTail) {
      await waitForRemoteRpcSession(lt.vmId);
      existingHandle.reconnectTail();
      this.store.update(name, { status: "idle" });
    } else if (existingHandle) {
      await waitForRemoteRpcSession(lt.vmId);
      const handle = await reconnectRemoteRpcAgent(lt.vmId);
      this.handles.set(name, handle);
      this.installEventHandler(name);
      this.store.update(name, { status: "idle" });
    } else {
      await this.waitForRemoteReef(lt);
      await this.syncRemoteLieutenant(name);
      const refreshed = this.store.getByName(name);
      if (refreshed && refreshed.status === "paused") {
        this.store.update(name, { status: "idle" });
      }
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

    if (!lt.isLocal && lt.vmId) {
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

    const detail = lt.isLocal
      ? `${name}: destroyed (local, ${lt.taskCount} tasks completed)`
      : `${name}: destroyed (VM ${lt.vmId.slice(0, 12)}, ${lt.taskCount} tasks completed)`;

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
      if (!lt.isLocal && lt.vmId) candidates.set(lt.name, lt);
    }

    const infraUrl = process.env.VERS_INFRA_URL;
    const authToken = process.env.VERS_AUTH_TOKEN;
    if (infraUrl && authToken) {
      try {
        const res = await fetch(`${infraUrl}/registry/vms?role=lieutenant`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (res.ok) {
          const data = (await res.json()) as { vms?: Array<Record<string, any>> };
          for (const vm of data.vms || []) {
            const name = vm.metadata?.agentId || vm.name;
            if (candidates.has(name)) continue;
            const lt = this.store.create({
              name,
              role: vm.metadata?.role || "recovered lieutenant",
              vmId: vm.id,
              isLocal: false,
            });
            candidates.set(name, lt);
          }
        }
      } catch {
        // Registry discovery is best-effort; fall back to the local store.
      }
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
    for (const lt of this.store.list()) {
      if (lt.isLocal) {
        this.store.destroy(lt.name);
      }
    }

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
