/**
 * FleetClient — shared HTTP client + identity for all service modules.
 *
 * Injected into every service's registerTools/registerBehaviors so they
 * don't manage HTTP or identity themselves.
 */

import type { FleetClient, ToolResult } from "./types.js";

export function createFleetClient(): FleetClient {
  const agentName = process.env.VERS_AGENT_NAME || `agent-${process.pid}`;
  const vmId = process.env.VERS_VM_ID || undefined;
  const agentRole = process.env.VERS_AGENT_ROLE || "worker";

  function getBaseUrl(): string | null {
    return process.env.VERS_INFRA_URL || null;
  }

  async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const base = getBaseUrl();
    if (!base) throw new Error("VERS_INFRA_URL not set");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    const token = process.env.VERS_AUTH_TOKEN;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!res.ok) {
      const msg =
        typeof data === "object" && data !== null && "error" in (data as Record<string, unknown>)
          ? (data as { error: string }).error
          : text;
      throw new Error(`${method} ${path} (${res.status}): ${msg}`);
    }

    return data as T;
  }

  function ok(text: string, details?: Record<string, unknown>): ToolResult {
    return {
      content: [{ type: "text", text }],
      details: details ?? {},
    };
  }

  function err(text: string): ToolResult {
    return {
      content: [{ type: "text", text: `Error: ${text}` }],
      isError: true,
    };
  }

  function noUrl(): ToolResult {
    return {
      content: [
        {
          type: "text",
          text: "Error: VERS_INFRA_URL environment variable is not set.\n\nSet it to the base URL of your reef instance, e.g.:\n  export VERS_INFRA_URL=http://localhost:4200",
        },
      ],
      isError: true,
    };
  }

  return {
    api,
    getBaseUrl,
    agentName,
    vmId,
    agentRole,
    ok,
    err,
    noUrl,
  };
}
