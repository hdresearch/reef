/**
 * Usage behaviors — accumulate tokens/cost across turns, post session summary,
 * track VM lifecycle, publish agent_stopped to feed with cost data.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { FleetClient } from "../../src/core/types.js";

export function registerBehaviors(pi: ExtensionAPI, client: FleetClient) {
  let sessionId = "";
  let model = "";
  let startedAt = "";
  let turns = 0;
  let tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let toolCalls: Record<string, number> = {};

  function reset() {
    startedAt = new Date().toISOString();
    turns = 0;
    tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    toolCalls = {};
  }

  pi.on("agent_start", async (_event, ctx) => {
    reset();
    sessionId = ctx.sessionManager.getSessionId();
    model = ctx.model?.id || "unknown";
  });

  pi.on("turn_end", async (event, ctx) => {
    turns++;
    model = ctx.model?.id || model;

    const msg = event.message as any;
    if (msg?.role === "assistant" && msg?.usage) {
      const u = msg.usage;
      tokens.input += u.input || 0;
      tokens.output += u.output || 0;
      tokens.cacheRead += u.cacheRead || 0;
      tokens.cacheWrite += u.cacheWrite || 0;
      tokens.total += u.totalTokens || 0;

      if (u.cost) {
        cost.input += u.cost.input || 0;
        cost.output += u.cost.output || 0;
        cost.cacheRead += u.cost.cacheRead || 0;
        cost.cacheWrite += u.cost.cacheWrite || 0;
        cost.total += u.cost.total || 0;
      }

      // Live token update to feed
      if (client.getBaseUrl()) {
        const tokensThisTurn = (u.input || 0) + (u.output || 0);
        client
          .api("POST", "/feed/events", {
            type: "token_update",
            agent: client.agentName,
            summary: `${tokensThisTurn} tokens`,
            detail: JSON.stringify({
              agent: client.agentName,
              tokensThisTurn,
              totalTokens: tokens.total,
              inputTokens: u.input || 0,
              outputTokens: u.output || 0,
              timestamp: Date.now(),
            }),
          })
          .catch(() => {});
      }
    }
  });

  // Count tool calls
  pi.on("tool_result", async (event) => {
    const name = event.toolName;
    toolCalls[name] = (toolCalls[name] || 0) + 1;

    // Track VM lifecycle from vers tool results
    if (!client.getBaseUrl() || event.isError) return;

    try {
      const text = event.content
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");

      if (name === "vers_vm_create" || name === "vers_vm_restore") {
        const vmIdMatch = text?.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
        if (vmIdMatch) {
          await client.api("POST", "/usage/vms", {
            vmId: vmIdMatch[1],
            role: (event.input as any)?.role || "worker",
            agent: client.agentName,
            commitId: (event.input as any)?.commitId,
            createdAt: new Date().toISOString(),
          });
        }
      } else if (name === "vers_vm_delete") {
        const vmId =
          (event.input as any)?.vmId ||
          text?.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/)?.[1];
        if (vmId) {
          await client.api("POST", "/usage/vms", {
            vmId,
            role: "worker",
            agent: client.agentName,
            createdAt: new Date().toISOString(),
            destroyedAt: new Date().toISOString(),
          });
        }
      } else if (name === "vers_vm_commit") {
        const inputVmId = (event.input as any)?.vmId;
        if (inputVmId) {
          const commitMatch = text?.match(/"commitId"\s*:\s*"([^"]+)"/);
          await client.api("POST", "/usage/vms", {
            vmId: inputVmId,
            role: "golden",
            agent: client.agentName,
            commitId: commitMatch?.[1],
            createdAt: new Date().toISOString(),
          });
        }
      }
    } catch {
      // best-effort
    }
  });

  // Post session summary + agent_stopped event on agent end
  pi.on("agent_end", async () => {
    if (!client.getBaseUrl()) return;

    const endedAt = new Date().toISOString();

    // Post session usage
    try {
      const roundedCost = {
        input: Math.round(cost.input * 1e6) / 1e6,
        output: Math.round(cost.output * 1e6) / 1e6,
        cacheRead: Math.round(cost.cacheRead * 1e6) / 1e6,
        cacheWrite: Math.round(cost.cacheWrite * 1e6) / 1e6,
        total: Math.round(cost.total * 1e6) / 1e6,
      };
      await client.api("POST", "/usage/sessions", {
        sessionId: sessionId || `session-${Date.now()}`,
        agent: client.agentName,
        parentAgent: process.env.VERS_PARENT_AGENT || null,
        model,
        tokens: { ...tokens },
        cost: roundedCost,
        turns,
        toolCalls: { ...toolCalls },
        startedAt: startedAt || endedAt,
        endedAt,
      });
    } catch {
      // best-effort
    }

    // Publish agent_stopped with cost data to feed
    try {
      const costStr = (Math.round(cost.total * 100) / 100).toFixed(2);
      await client.api("POST", "/feed/events", {
        agent: client.agentName,
        type: "agent_stopped",
        summary: `Agent ${client.agentName} finished (${turns} turns, ${tokens.total} tokens, $${costStr})`,
      });
    } catch {
      // best-effort
    }
  });
}
