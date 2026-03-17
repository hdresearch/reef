/**
 * Lieutenant runtime — manages the lifecycle of lieutenant pi processes.
 *
 * Bridges the store (persistent state) with RPC handles (live processes).
 * Handles creation, messaging, pause/resume, destruction, and discovery.
 */

import type { ServiceEventBus } from "../../src/core/events.js";
import type { RpcHandle } from "./rpc.js";
import { buildSystemPrompt, startLocalRpcAgent, waitForRpcReady } from "./rpc.js";
import type { LieutenantStore, Lieutenant } from "./store.js";
import { NotFoundError, ValidationError } from "./store.js";

export interface LieutenantRuntimeOptions {
  events: ServiceEventBus;
  store: LieutenantStore;
}

export class LieutenantRuntime {
  private handles = new Map<string, RpcHandle>();
  private events: ServiceEventBus;
  private store: LieutenantStore;

  constructor(opts: LieutenantRuntimeOptions) {
    this.events = opts.events;
    this.store = opts.store;
  }

  // =========================================================================
  // Create
  // =========================================================================

  async create(params: {
    name: string;
    role: string;
    isLocal?: boolean;
    model?: string;
    commitId?: string;
  }): Promise<Lieutenant> {
    const { name, role, isLocal = true, model } = params;
    const systemPrompt = buildSystemPrompt(name, role);

    // Create DB record
    const lt = this.store.create({
      name,
      role,
      isLocal,
      systemPrompt,
      model,
      parentAgent: process.env.VERS_AGENT_NAME,
    });

    if (isLocal) {
      // Spawn local pi process
      const handle = await startLocalRpcAgent(name, { systemPrompt, model });
      this.handles.set(name, handle);

      // Wait for RPC readiness
      const ready = await waitForRpcReady(handle);
      if (!ready) {
        await handle.kill();
        this.handles.delete(name);
        this.store.destroy(name);
        throw new Error(`Local pi RPC failed to start for "${name}"`);
      }

      // Set model if specified
      if (model) {
        handle.send({ type: "set_model", provider: "anthropic", modelId: model });
      }

      this.store.update(name, { status: "idle" });
      this.installEventHandler(name);

      this.events.fire("lieutenant:created", { name, vmId: lt.vmId, role, isLocal: true });
    } else {
      // Remote mode — VM-based lieutenant
      // The actual VM provisioning is handled by pi-vers (vers-vm.ts).
      // Reef stores the state; the caller is responsible for providing vmId
      // after VM creation and starting the RPC connection.
      this.store.update(name, { status: "idle" });
      this.events.fire("lieutenant:created", {
        name,
        vmId: lt.vmId,
        role,
        isLocal: false,
        commitId: params.commitId,
      });
    }

    return this.store.getByName(name)!;
  }

  // =========================================================================
  // Send message
  // =========================================================================

  async send(
    name: string,
    message: string,
    mode?: "prompt" | "steer" | "followUp",
  ): Promise<{ sent: boolean; mode: string; note?: string }> {
    const lt = this.store.getByName(name);
    if (!lt) throw new NotFoundError(`Lieutenant '${name}' not found`);
    if (lt.status === "paused") throw new ValidationError(`Lieutenant '${name}' is paused. Resume it first.`);
    if (lt.status === "destroyed") throw new NotFoundError(`Lieutenant '${name}' has been destroyed`);

    const handle = this.handles.get(name);
    if (!handle || !handle.isAlive()) {
      throw new ValidationError(`No active RPC connection for '${name}'`);
    }

    let actualMode = mode || "prompt";
    let note: string | undefined;

    // Auto-select mode based on lieutenant state
    if (lt.status === "working" && actualMode === "prompt") {
      actualMode = "followUp";
      note = "auto-queued as follow-up since lieutenant is working";
    }

    if (actualMode === "prompt") {
      this.store.update(name, { taskCount: lt.taskCount + 1 });
      this.store.update(name, { lastOutput: "" });
      handle.send({ type: "prompt", message });
    } else if (actualMode === "steer") {
      handle.send({ type: "steer", message });
    } else if (actualMode === "followUp") {
      handle.send({ type: "follow_up", message });
    }

    this.store.update(name, { lastActivityAt: new Date().toISOString() });

    return { sent: true, mode: actualMode, note };
  }

  // =========================================================================
  // Pause / Resume
  // =========================================================================

  async pause(name: string): Promise<{ paused: boolean }> {
    const lt = this.store.getByName(name);
    if (!lt) throw new NotFoundError(`Lieutenant '${name}' not found`);
    if (lt.isLocal) throw new ValidationError(`Lieutenant '${name}' is local — pause/resume requires a VM`);
    if (lt.status === "paused") return { paused: true };
    if (lt.status === "working") {
      throw new ValidationError(`Lieutenant '${name}' is working. Wait for it to finish or steer it first.`);
    }

    // For remote VMs, the actual pause is done via Vers API (pi-vers handles this).
    // We just update state here.
    this.store.update(name, { status: "paused" });
    this.events.fire("lieutenant:paused", { name, vmId: lt.vmId });
    return { paused: true };
  }

  async resume(name: string): Promise<{ resumed: boolean }> {
    const lt = this.store.getByName(name);
    if (!lt) throw new NotFoundError(`Lieutenant '${name}' not found`);
    if (lt.isLocal) throw new ValidationError(`Lieutenant '${name}' is local — pause/resume requires a VM`);
    if (lt.status !== "paused") {
      throw new ValidationError(`Lieutenant '${name}' is not paused (status: ${lt.status})`);
    }

    // For remote VMs, the actual resume is done via Vers API (pi-vers handles this).
    // We update state and reconnect RPC.
    this.store.update(name, { status: "idle" });
    this.events.fire("lieutenant:resumed", { name, vmId: lt.vmId });
    return { resumed: true };
  }

  // =========================================================================
  // Destroy
  // =========================================================================

  async destroy(name: string): Promise<{ destroyed: boolean; detail: string }> {
    const lt = this.store.getByName(name);
    if (!lt) throw new NotFoundError(`Lieutenant '${name}' not found`);

    // Kill RPC handle
    const handle = this.handles.get(name);
    if (handle) {
      try {
        await handle.kill();
      } catch {
        /* ignore */
      }
      this.handles.delete(name);
    }

    this.store.destroy(name);
    this.events.fire("lieutenant:destroyed", { name, vmId: lt.vmId, isLocal: lt.isLocal });

    const detail = lt.isLocal
      ? `${name}: destroyed (local, ${lt.taskCount} tasks completed)`
      : `${name}: destroyed (VM ${lt.vmId.slice(0, 12)}, ${lt.taskCount} tasks completed)`;

    return { destroyed: true, detail };
  }

  async destroyAll(): Promise<string[]> {
    const names = this.store.names();
    const results: string[] = [];
    for (const name of names) {
      try {
        const result = await this.destroy(name);
        results.push(result.detail);
      } catch (e) {
        results.push(`${name}: failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return results;
  }

  // =========================================================================
  // Discover — reconnect to lieutenants from registry
  // =========================================================================

  async discover(): Promise<string[]> {
    // Check registry for lieutenant VMs
    const infraUrl = process.env.VERS_INFRA_URL;
    const authToken = process.env.VERS_AUTH_TOKEN;
    if (!infraUrl || !authToken) return ["No VERS_INFRA_URL or VERS_AUTH_TOKEN configured"];

    try {
      const res = await fetch(`${infraUrl}/registry/vms?role=lieutenant`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) return [`Registry query failed: HTTP ${res.status}`];

      const data = (await res.json()) as { vms: any[]; count: number };
      const results: string[] = [];

      for (const vm of data.vms || []) {
        const name = vm.metadata?.agentId || vm.name;
        if (this.store.getByName(name)?.status !== "destroyed" && this.store.getByName(name)) {
          results.push(`${name}: already tracked`);
          continue;
        }

        // Re-create as a tracked lieutenant
        this.store.create({
          name,
          role: vm.metadata?.role || "recovered lieutenant",
          vmId: vm.id,
          isLocal: false,
        });
        this.store.update(name, { status: vm.status === "paused" ? "paused" : "idle" });
        results.push(`${name}: discovered (VM ${vm.id.slice(0, 12)}, ${vm.status})`);
      }

      return results.length > 0 ? results : ["No lieutenants found in registry"];
    } catch (e) {
      return [`Discovery failed: ${e instanceof Error ? e.message : String(e)}`];
    }
  }

  // =========================================================================
  // Event handler installation — wires pi events to store updates
  // =========================================================================

  private installEventHandler(name: string): void {
    const handle = this.handles.get(name);
    if (!handle) return;

    handle.onEvent((event) => {
      const lt = this.store.getByName(name);
      if (!lt) return;

      if (event.type === "agent_start") {
        this.store.update(name, { status: "working" });
        this.store.update(name, { lastOutput: "" });
      } else if (event.type === "agent_end") {
        // Rotate output to history before clearing
        this.store.rotateOutput(name);
        this.store.update(name, { status: "idle" });

        // Broadcast completion
        const rawOutput = lt.lastOutput.trim();
        const summary = rawOutput.length > 200 ? `...${rawOutput.slice(-200)}` : rawOutput;
        const hasError = /\b(error|failed|exception|fatal)\b/i.test(rawOutput.slice(-500));

        this.events.fire("lieutenant:completed", {
          name: lt.name,
          role: lt.role,
          status: hasError ? "error" : "success",
          summary,
          taskCount: lt.taskCount,
        });
      } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        this.store.appendOutput(name, event.assistantMessageEvent.delta);
      }
    });
  }

  // =========================================================================
  // Accessors
  // =========================================================================

  getHandle(name: string): RpcHandle | undefined {
    return this.handles.get(name);
  }

  hasHandle(name: string): boolean {
    return this.handles.has(name);
  }

  async shutdown(): Promise<void> {
    for (const [name, handle] of this.handles) {
      try {
        await handle.kill();
      } catch {
        /* ignore */
      }
    }
    this.handles.clear();
  }
}
