/**
 * Core types for the reef plugin system.
 *
 * A ServiceModule is the fundamental unit — it declares both server-side
 * routes and client-side pi extension behavior in one place.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Hono } from "hono";
import type { ServiceEventBus } from "./events.js";

// =============================================================================
// Tool result types (matching pi's expected shape)
// =============================================================================

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  details?: Record<string, unknown>;
  isError?: boolean;
}

// =============================================================================
// FleetClient — injected into every service's client-side code
// =============================================================================

export interface FleetClient {
  /** Make an authenticated API call to the fleet server */
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;

  /** Get the base URL, or null if not configured */
  getBaseUrl(): string | null;

  /** This agent's name (from VERS_AGENT_NAME or fallback) */
  readonly agentName: string;

  /** This agent's VM ID, if set */
  readonly vmId: string | undefined;

  /** This agent's role (from VERS_AGENT_ROLE or "worker") */
  readonly agentRole: string;

  /** Build a successful tool result */
  ok(text: string, details?: Record<string, unknown>): ToolResult;

  /** Build an error tool result */
  err(text: string): ToolResult;

  /** Build a "no URL configured" error result */
  noUrl(): ToolResult;
}

// =============================================================================
// Widget contribution — services add lines to the composite status widget
// =============================================================================

export interface WidgetContribution {
  /** Lines to contribute to the status widget */
  getLines(client: FleetClient): Promise<string[]>;
}

// =============================================================================
// ServiceContext — passed to modules during server-side initialization
// =============================================================================

export interface ServiceContext {
  /** Server-side event bus for inter-module communication */
  events: ServiceEventBus;

  /** Get another module's store by service name. Returns undefined if not found. */
  getStore<T = unknown>(serviceName: string): T | undefined;

  /** All currently loaded modules (read-only view). */
  getModules(): ServiceModule[];

  /** Get a loaded module by name. */
  getModule(name: string): ServiceModule | undefined;

  /**
   * Load or reload a module from a directory under the services dir.
   * Returns the module name and whether it was added or updated.
   */
  loadModule(dirName: string): Promise<{ name: string; action: "added" | "updated" }>;

  /** Unload a module by name. Flushes and closes its store. */
  unloadModule(name: string): Promise<void>;

  /** The resolved services directory path. */
  servicesDir: string;
}

// =============================================================================
// ServiceModule — the plugin interface
// =============================================================================

export interface ServiceModule {
  /** Unique name, used as route prefix: /board, /feed, etc. */
  name: string;

  /** Human-readable description */
  description?: string;

  // --- Server side ---

  /** Hono routes, mounted at /{name}/* (or root if mountAtRoot is true) */
  routes?: Hono;

  /** Mount routes at / instead of /{name}/. Used for UI, webhooks, etc. */
  mountAtRoot?: boolean;

  /** Whether routes need bearer auth. Default: true */
  requiresAuth?: boolean;

  /** Store handle for graceful shutdown (flush pending writes, close connections) */
  store?: {
    flush?(): void;
    close?(): Promise<void>;
  };

  /**
   * Server-side initialization hook. Called after all modules are loaded,
   * so you can subscribe to events or look up other modules' stores.
   */
  init?(ctx: ServiceContext): void;

  // --- Client side (pi extension) ---

  /** Register tools the LLM can call */
  registerTools?(pi: ExtensionAPI, client: FleetClient): void;

  /** Register automatic behaviors (event handlers, timers) */
  registerBehaviors?(pi: ExtensionAPI, client: FleetClient): void;

  /** Contribute lines to the composite status widget */
  widget?: WidgetContribution;

  // --- Metadata ---

  /** Services this module depends on (for load ordering) */
  dependencies?: string[];

  /**
   * Seed capabilities this module provides to the substrate.
   * Uses the capability taxonomy from the Seed Specification (§4).
   *
   * When a module is loaded, its capabilities are aggregated into the
   * manifest's substrate declaration. Agents checking whether a seed
   * can germinate here inspect this.
   *
   * @example
   * capabilities: ["agent.spawn", "agent.communicate", "agent.lifecycle"]
   */
  capabilities?: string[];

  /**
   * Route documentation. Keyed by "METHOD /path" (path relative to module root).
   * Used by the docs service to generate API documentation.
   *
   * @example
   * routeDocs: {
   *   "POST /tasks": {
   *     summary: "Create a task",
   *     body: {
   *       title: { type: "string", required: true, description: "Task title" },
   *       assignee: { type: "string", description: "Agent or user to assign to" },
   *     },
   *     response: "The created task object with generated ID and timestamps",
   *   },
   *   "GET /tasks": {
   *     summary: "List tasks with optional filters",
   *     query: {
   *       status: { type: "string", description: "open | in_progress | in_review | blocked | done" },
   *     },
   *   },
   * }
   */
  routeDocs?: Record<string, RouteDocs>;
}

// =============================================================================
// Route documentation types
// =============================================================================

export interface ParamDoc {
  type: string;
  required?: boolean;
  description?: string;
}

export interface RouteDocs {
  /** Short description of what this endpoint does */
  summary: string;
  /** Longer explanation, usage notes, or examples */
  detail?: string;
  /** URL path parameters (e.g. :id) */
  params?: Record<string, ParamDoc>;
  /** Query string parameters */
  query?: Record<string, ParamDoc>;
  /** Request body fields (for POST/PATCH/PUT) */
  body?: Record<string, ParamDoc>;
  /** Description of the response */
  response?: string;
}
