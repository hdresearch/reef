/**
 * Core types for the fleet services plugin system.
 *
 * A ServiceModule is the fundamental unit — it declares both server-side
 * routes and client-side pi extension behavior in one place.
 */

import type { Hono } from "hono";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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
}
