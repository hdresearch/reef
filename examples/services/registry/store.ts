/**
 * Registry store — VM service discovery with heartbeat-based liveness.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// =============================================================================
// Types
// =============================================================================

export type VMRole = "infra" | "lieutenant" | "worker" | "golden" | "custom";
export type VMStatus = "running" | "paused" | "stopped";

export interface VMService {
  name: string;
  port: number;
  protocol?: string;
}

export interface VM {
  id: string;
  name: string;
  role: VMRole;
  status: VMStatus;
  address: string;
  services: VMService[];
  registeredBy: string;
  registeredAt: string;
  lastSeen: string;
  metadata?: Record<string, unknown>;
}

export interface RegisterInput {
  id: string;
  name: string;
  role: VMRole;
  address: string;
  services?: VMService[];
  registeredBy: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateInput {
  name?: string;
  status?: VMStatus;
  address?: string;
  services?: VMService[];
  metadata?: Record<string, unknown>;
}

export interface VMFilters {
  role?: VMRole;
  status?: VMStatus;
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

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

// =============================================================================
// Constants
// =============================================================================

const VALID_ROLES = new Set<string>(["infra", "lieutenant", "worker", "golden", "custom"]);
const VALID_STATUSES = new Set<string>(["running", "paused", "stopped"]);
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// Store
// =============================================================================

export class RegistryStore {
  private vms = new Map<string, VM>();
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath = "data/registry.json") {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.vms)) {
          for (const v of data.vms) this.vms.set(v.id, v);
        }
      }
    } catch {
      this.vms = new Map();
    }
  }

  private scheduleSave(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 100);
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data = JSON.stringify({ vms: Array.from(this.vms.values()) }, null, 2);
    writeFileSync(this.filePath, data, "utf-8");
  }

  private isStale(vm: VM): boolean {
    return Date.now() - new Date(vm.lastSeen).getTime() > STALE_THRESHOLD_MS;
  }

  register(input: RegisterInput): VM {
    if (!input.id?.trim()) throw new ValidationError("id is required");
    if (!input.name?.trim()) throw new ValidationError("name is required");
    if (!input.role || !VALID_ROLES.has(input.role)) throw new ValidationError(`invalid role: ${input.role}`);
    if (!input.address?.trim()) throw new ValidationError("address is required");
    if (!input.registeredBy?.trim()) throw new ValidationError("registeredBy is required");

    // Allow re-registration (upsert)
    const now = new Date().toISOString();
    const existing = this.vms.get(input.id);

    const vm: VM = {
      id: input.id.trim(),
      name: input.name.trim(),
      role: input.role,
      status: "running",
      address: input.address.trim(),
      services: input.services || existing?.services || [],
      registeredBy: input.registeredBy.trim(),
      registeredAt: existing?.registeredAt || now,
      lastSeen: now,
      metadata: input.metadata || existing?.metadata,
    };

    this.vms.set(vm.id, vm);
    this.scheduleSave();
    return vm;
  }

  get(id: string): VM | undefined {
    return this.vms.get(id);
  }

  list(filters?: VMFilters): VM[] {
    let results = Array.from(this.vms.values());

    if (filters?.role) results = results.filter((v) => v.role === filters.role);
    if (filters?.status) {
      if (filters.status === "running") {
        // Exclude stale VMs from "running" filter
        results = results.filter((v) => v.status === "running" && !this.isStale(v));
      } else {
        results = results.filter((v) => v.status === filters.status);
      }
    }

    results.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    return results;
  }

  update(id: string, input: UpdateInput): VM {
    const vm = this.vms.get(id);
    if (!vm) throw new NotFoundError("VM not found");

    if (input.status !== undefined && !VALID_STATUSES.has(input.status)) {
      throw new ValidationError(`invalid status: ${input.status}`);
    }

    if (input.name !== undefined) vm.name = input.name.trim();
    if (input.status !== undefined) vm.status = input.status;
    if (input.address !== undefined) vm.address = input.address.trim();
    if (input.services !== undefined) vm.services = input.services;
    if (input.metadata !== undefined) vm.metadata = input.metadata;

    vm.lastSeen = new Date().toISOString();
    this.vms.set(id, vm);
    this.scheduleSave();
    return vm;
  }

  deregister(id: string): boolean {
    const existed = this.vms.delete(id);
    if (existed) this.scheduleSave();
    return existed;
  }

  heartbeat(id: string): VM {
    const vm = this.vms.get(id);
    if (!vm) throw new NotFoundError("VM not found");

    vm.lastSeen = new Date().toISOString();
    vm.status = "running";
    this.vms.set(id, vm);
    this.scheduleSave();
    return vm;
  }

  discover(role: VMRole): VM[] {
    return Array.from(this.vms.values()).filter((v) => v.role === role && v.status === "running" && !this.isStale(v));
  }
}
