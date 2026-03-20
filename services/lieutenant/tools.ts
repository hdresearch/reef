/**
 * Lieutenant agent tools — the 8 tools agents use to manage lieutenants.
 *
 * Ports: reef_lt_create, reef_lt_send, reef_lt_read, reef_lt_status,
 *        reef_lt_pause, reef_lt_resume, reef_lt_destroy, reef_lt_discover
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { FleetClient } from "../../src/core/types.js";

function registerNamedTool(
  pi: ExtensionAPI,
  names: string[],
  spec: Omit<Parameters<ExtensionAPI["registerTool"]>[0], "name">,
) {
  for (const name of names) {
    pi.registerTool({ ...spec, name });
  }
}

export function registerTools(pi: ExtensionAPI, client: FleetClient) {
  registerNamedTool(pi, ["reef_lt_create"], {
    label: "Create Lieutenant",
    description: [
      "Spawn a persistent agent session (lieutenant).",
      "Lieutenants persist across tasks, accumulate context, and support multi-turn interaction.",
      "Remote mode is the default and uses the explicit commitId, configured env golden, or root Reef golden commit.",
      "Remote lieutenants are agent VMs running punkin + pi-vers + the root Reef extension, not standalone Reef nodes.",
      "Set local=true to run as a local subprocess instead.",
    ].join(" "),
    parameters: Type.Object({
      name: Type.String({ description: "Short name for this lieutenant (e.g., 'infra', 'billing')" }),
      role: Type.String({ description: "Role description — becomes the lieutenant's system prompt context" }),
      local: Type.Optional(
        Type.Boolean({ description: "Run locally as a subprocess instead of on a VM (default: false)" }),
      ),
      model: Type.Optional(Type.String({ description: "Model ID (e.g., claude-sonnet-4-20250514)" })),
      commitId: Type.Optional(
        Type.String({
          description: "Golden image commit ID for VM creation (optional if a default golden is configured)",
        }),
      ),
      llmProxyKey: Type.Optional(Type.String({ description: "Vers LLM proxy key override (sk-vers-...)" })),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api<any>("POST", "/lieutenant/lieutenants", {
          name: params.name,
          role: params.role,
          local: params.local ?? false,
          model: params.model,
          commitId: params.commitId,
          llmProxyKey: params.llmProxyKey,
        });
        const loc = result.isLocal ? "[local]" : `[VM: ${result.vmId}]`;
        return client.ok(
          [`Lieutenant "${result.name}" is ready ${loc}.`, `  Role: ${result.role}`, `  Status: ${result.status}`].join(
            "\n",
          ),
          { lieutenant: result },
        );
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  registerNamedTool(pi, ["reef_lt_send"], {
    label: "Send to Lieutenant",
    description: [
      "Send a message to a lieutenant. Modes:",
      "  'prompt' (default when idle) — start a new task",
      "  'steer' — interrupt current work and redirect",
      "  'followUp' — queue message for after current task finishes",
    ].join("\n"),
    parameters: Type.Object({
      name: Type.String({ description: "Lieutenant name" }),
      message: Type.String({ description: "The message to send" }),
      mode: Type.Optional(
        Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("followUp")], {
          description: "Message mode (default: prompt, auto-selects followUp if busy)",
        }),
      ),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api<any>(
          "POST",
          `/lieutenant/lieutenants/${encodeURIComponent(params.name)}/send`,
          {
            message: params.message,
            mode: params.mode,
          },
        );
        const msg = params.message;
        const preview = msg.length > 120 ? `${msg.slice(0, 120)}...` : msg;
        const note = result.note ? ` (${result.note})` : "";
        return client.ok(`Sent to ${params.name} (${result.mode})${note}: "${preview}"`);
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  registerNamedTool(pi, ["reef_lt_read"], {
    label: "Read Lieutenant Output",
    description:
      "Read output from a lieutenant. Shows current response if working, or last completed response if idle.",
    parameters: Type.Object({
      name: Type.String({ description: "Lieutenant name" }),
      tail: Type.Optional(Type.Number({ description: "Characters from end (default: all)" })),
      history: Type.Optional(
        Type.Number({ description: "Number of previous responses to include (default: 0, max: 20)" }),
      ),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const qs = new URLSearchParams();
        if (params.tail) qs.set("tail", String(params.tail));
        if (params.history) qs.set("history", String(params.history));
        const query = qs.toString();
        const result = await client.api<any>(
          "GET",
          `/lieutenant/lieutenants/${encodeURIComponent(params.name)}/read${query ? `?${query}` : ""}`,
        );
        return client.ok(`[${result.name}] (${result.status}, ${result.taskCount} tasks):\n\n${result.output}`, {
          name: result.name,
          status: result.status,
          taskCount: result.taskCount,
          outputLength: result.outputLength,
          historyCount: result.historyCount,
        });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  registerNamedTool(pi, ["reef_lt_status"], {
    label: "Lieutenant Status",
    description: "Overview of all lieutenants: status, role, task count, last activity.",
    parameters: Type.Object({}),
    async execute() {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api<any>("GET", "/lieutenant/lieutenants");
        if (result.count === 0) {
          return client.ok("No lieutenants active.");
        }
        const lines = result.lieutenants.map((lt: any) => {
          const icon =
            lt.status === "working"
              ? "~"
              : lt.status === "idle"
                ? "*"
                : lt.status === "paused"
                  ? "||"
                  : lt.status === "error"
                    ? "X"
                    : "o";
          const location = lt.isLocal ? "local" : `VM: ${lt.vmId.slice(0, 12)}`;
          return [
            `${icon} ${lt.name} [${lt.status}]`,
            `  Role: ${lt.role}`,
            `  ${location}`,
            `  Tasks: ${lt.taskCount}`,
            `  Last active: ${lt.lastActivityAt}`,
          ].join("\n");
        });
        return client.ok(lines.join("\n\n"), { lieutenants: result.lieutenants });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  registerNamedTool(pi, ["reef_lt_pause"], {
    label: "Pause Lieutenant",
    description:
      "Pause a lieutenant's VM. Preserves full state (memory + disk). Can be resumed later. Only works for remote (VM) lieutenants.",
    parameters: Type.Object({
      name: Type.String({ description: "Lieutenant name" }),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        await client.api("POST", `/lieutenant/lieutenants/${encodeURIComponent(params.name)}/pause`);
        return client.ok(`Lieutenant "${params.name}" paused. Use reef_lt_resume to wake it.`);
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  registerNamedTool(pi, ["reef_lt_resume"], {
    label: "Resume Lieutenant",
    description: "Resume a paused lieutenant. VM resumes from exact state including the pi session.",
    parameters: Type.Object({
      name: Type.String({ description: "Lieutenant name" }),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        await client.api("POST", `/lieutenant/lieutenants/${encodeURIComponent(params.name)}/resume`);
        return client.ok(`Lieutenant "${params.name}" resumed. Ready for tasks.`);
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  registerNamedTool(pi, ["reef_lt_destroy"], {
    label: "Destroy Lieutenant",
    description: "Tear down a lieutenant — kills pi process, removes from tracking. Pass name='*' to destroy all.",
    parameters: Type.Object({
      name: Type.String({ description: "Lieutenant name, or '*' for all" }),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        if (params.name === "*") {
          const result = await client.api<any>("POST", "/lieutenant/lieutenants/destroy-all");
          return client.ok(result.results.join("\n") || "No lieutenants to destroy.");
        }
        const result = await client.api<any>("DELETE", `/lieutenant/lieutenants/${encodeURIComponent(params.name)}`);
        return client.ok(result.detail);
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  registerNamedTool(pi, ["reef_lt_discover"], {
    label: "Discover Lieutenants",
    description:
      "Discover running lieutenants from the registry and reconnect to them. Use after session restart to recover lieutenant state.",
    parameters: Type.Object({}),
    async execute() {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api<any>("POST", "/lieutenant/lieutenants/discover");
        return client.ok(`Discovery results:\n${result.results.join("\n")}`);
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });
}
