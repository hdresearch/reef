/**
 * Swarm agent tools — the 7 tools agents use to manage worker swarms.
 *
 * Tools: reef_swarm_spawn, reef_swarm_task, reef_swarm_status,
 *        reef_swarm_read, reef_swarm_wait, reef_swarm_discover,
 *        reef_swarm_teardown
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { FleetClient } from "../../src/core/types.js";

export function registerTools(pi: ExtensionAPI, client: FleetClient) {
  pi.registerTool({
    name: "reef_swarm_spawn",
    label: "Spawn Worker Swarm",
    description: [
      "Branch N VMs from a golden commit and start pi coding agents on each.",
      "Each agent runs pi in RPC mode, ready to receive tasks.",
      "Workers default to claude-sonnet-4-6.",
    ].join(" "),
    parameters: Type.Object({
      commitId: Type.Optional(Type.String({ description: "Golden image commit ID (defaults to configured golden)" })),
      count: Type.Number({ description: "Number of worker agents to spawn" }),
      labels: Type.Optional(
        Type.Array(Type.String(), { description: "Labels for each agent (e.g., ['feature', 'tests', 'docs'])" }),
      ),
      llmProxyKey: Type.Optional(Type.String({ description: "Vers LLM proxy key override (sk-vers-...)" })),
      model: Type.Optional(Type.String({ description: "Model ID for agents (default: claude-sonnet-4-6)" })),
      context: Type.Optional(
        Type.String({ description: "Situational context appended to inherited AGENTS.md for all workers" }),
      ),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api<any>("POST", "/swarm/agents", {
          commitId: params.commitId,
          count: params.count,
          labels: params.labels,
          llmProxyKey: params.llmProxyKey,
          model: params.model,
          context: params.context,
        });
        return client.ok(
          `Spawned ${result.count} agent(s):\n${result.messages.join("\n")}\n\n${result.count} workers ready.`,
          { agents: result.agents },
        );
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "reef_swarm_task",
    label: "Send Task to Worker",
    description: "Send a task (prompt) to a specific swarm worker. The agent will begin working on it autonomously.",
    parameters: Type.Object({
      agentId: Type.String({ description: "Agent label/ID to send task to" }),
      task: Type.String({ description: "The task prompt to send" }),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        await client.api("POST", `/swarm/agents/${encodeURIComponent(params.agentId)}/task`, {
          task: params.task,
        });
        const taskPreview = params.task.length > 100 ? `${params.task.slice(0, 100)}...` : params.task;
        return client.ok(`Task sent to ${params.agentId}: "${taskPreview}"`, { agentId: params.agentId });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "reef_swarm_status",
    label: "Swarm Status",
    description: "Check the status of all workers in the swarm. Shows which are idle, working, done, or errored.",
    parameters: Type.Object({}),
    async execute() {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api<any>("GET", "/swarm/agents");
        return client.ok(result.summary, { agents: result.agents, count: result.count });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "reef_swarm_read",
    label: "Read Worker Output",
    description:
      "Read the latest text output from a specific swarm worker. Returns the agent's accumulated response text.",
    parameters: Type.Object({
      agentId: Type.String({ description: "Agent label/ID to read from" }),
      tail: Type.Optional(Type.Number({ description: "Number of characters from the end to return (default: all)" })),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const qs = params.tail ? `?tail=${params.tail}` : "";
        const result = await client.api<any>("GET", `/swarm/agents/${encodeURIComponent(params.agentId)}/read${qs}`);
        const warning = result.warning ? `\n${result.warning}\n` : "";
        const events = (result.lifecycle || [])
          .slice(-5)
          .map((e: any) => `  [${new Date(e.timestamp).toLocaleTimeString()}] ${e.type}: ${e.detail}`)
          .join("\n");
        const eventsSection = events ? `\nRecent events:\n${events}` : "";
        return client.ok(`[${result.id}] (${result.status}):${warning}${eventsSection}\n${result.output}`, {
          agentId: result.id,
          status: result.status,
          outputLength: result.outputLength,
        });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "reef_swarm_wait",
    label: "Wait for Workers",
    description:
      "Block until all workers (or specified workers) finish. Returns each agent's full text output. Use after dispatching tasks to collect results without polling.",
    parameters: Type.Object({
      agentIds: Type.Optional(
        Type.Array(Type.String(), { description: "Specific agent IDs to wait for (default: all working/idle agents)" }),
      ),
      timeoutSeconds: Type.Optional(Type.Number({ description: "Max seconds to wait (default: 300)" })),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api<any>("POST", "/swarm/wait", {
          agentIds: params.agentIds,
          timeoutSeconds: params.timeoutSeconds,
        });

        const agentResults = result.agents
          .map((a: any) => {
            const events = (a.lifecycle || [])
              .slice(-3)
              .map((e: any) => `  [${e.type}] ${e.detail}`)
              .join("\n");
            return `=== ${a.id} [${a.status}] ===\n${events ? `${events}\n` : ""}${a.output}\n`;
          })
          .join("\n");

        const header = result.timedOut
          ? `TIMED OUT after ${result.elapsed}s`
          : `All agents finished in ${result.elapsed}s`;

        return client.ok(`${header}\n\n${agentResults}`, { elapsed: result.elapsed, timedOut: result.timedOut });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "reef_swarm_discover",
    label: "Discover Swarm Workers",
    description:
      "Discover running swarm workers from the registry and reconnect to them. Use after session restart to recover swarm state.",
    parameters: Type.Object({}),
    async execute() {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api<any>("POST", "/swarm/discover");
        return client.ok(`Discovery results:\n${result.results.join("\n")}\n\n${result.summary}`, {
          results: result.results,
        });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  pi.registerTool({
    name: "reef_swarm_teardown",
    label: "Teardown Swarm",
    description: "Stop all swarm workers and delete their VMs.",
    parameters: Type.Object({}),
    async execute() {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api<any>("POST", "/swarm/teardown");
        return client.ok(`Swarm torn down:\n${result.results.join("\n")}`, {});
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  // reef_agent_spawn — spawn a single autonomous agent VM
  pi.registerTool({
    name: "reef_agent_spawn",
    label: "Spawn Agent VM",
    description: [
      "Spawn a single autonomous agent VM that runs independently and signals when done.",
      "Unlike swarm workers, agent VMs own their lifecycle — they decide what to do based on",
      "their inherited AGENTS.md + context, and signal done/blocked/failed to their parent.",
      "",
      "Your full AGENTS.md is inherited by the agent. Provide context to tell it what to do.",
      "The agent VM can spawn its own sub-agents (more agent VMs, swarms, resource VMs).",
      "",
      "Pick model and effort based on task complexity. Default: sonnet/medium.",
    ].join("\n"),
    parameters: Type.Object({
      name: Type.String({ description: "Agent name (must be unique in the fleet)" }),
      task: Type.String({ description: "The task for this agent to execute autonomously" }),
      context: Type.Optional(Type.String({ description: "Situational context appended to inherited AGENTS.md" })),
      directive: Type.Optional(Type.String({ description: "Hard guardrails (VERS_AGENT_DIRECTIVE)" })),
      model: Type.Optional(Type.String({ description: "LLM model (default: claude-sonnet-4-6)" })),
      commitId: Type.Optional(Type.String({ description: "Golden image commit (default: auto-resolved)" })),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        // Spawn as a 1-worker swarm with agent_vm category
        const spawnResult = await client.api<any>("POST", "/swarm/agents", {
          count: 1,
          labels: [params.name],
          model: params.model || "claude-sonnet-4-6",
          commitId: params.commitId,
          context: params.context,
          category: "agent_vm",
          directive: params.directive,
        });

        const agent = spawnResult.agents?.[0];
        if (!agent) return client.err("Failed to spawn agent VM");

        // Send the task — agent VMs always get an initial task
        await client.api("POST", `/swarm/agents/${params.name}/task`, { task: params.task });

        const lines = [
          `Agent VM "${params.name}" spawned on ${agent.vmId?.slice(0, 12)}`,
          `Task: ${params.task.slice(0, 100)}${params.task.length > 100 ? "..." : ""}`,
          params.context ? `Context: ${params.context.slice(0, 80)}...` : "",
          "The agent runs autonomously. Check reef_inbox for its signals.",
        ].filter(Boolean);

        return client.ok(lines.join("\n"), { agent, vmId: agent.vmId, name: params.name });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  // reef_resource_spawn — spawn a bare metal VM
  pi.registerTool({
    name: "reef_resource_spawn",
    label: "Spawn Resource VM",
    description: [
      "Spawn a bare metal Vers VM for infrastructure (database, build server, test runner).",
      "No agent stack, no punkin, no AGENTS.md — just a Linux box.",
      "You own it. SSH into it via vers_vm_use to configure it.",
      "It gets cleaned up when you are torn down.",
    ].join("\n"),
    parameters: Type.Object({
      name: Type.String({ description: "Resource VM name (must be unique)" }),
      commitId: Type.Optional(Type.String({ description: "Image commit to restore from (default: golden image)" })),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      let vmId: string | undefined;
      try {
        // Resolve commit ID
        const commitId = params.commitId || process.env.VERS_GOLDEN_COMMIT_ID;
        if (!commitId) {
          return client.err("No commit ID provided and VERS_GOLDEN_COMMIT_ID not set.");
        }

        // Step 1: Create VM via vers API
        const createResult = await client.api<any>("POST", "/vers/vm/from_commit", { commitId });
        vmId = createResult?.vmId || createResult?.id;
        if (!vmId) return client.err("Failed to create resource VM — no vmId returned.");

        // Step 2: Register in vm_tree as running once Vers has returned the VM id.
        await client.api("POST", "/vm-tree/vms", {
          vmId,
          name: params.name,
          category: "resource_vm",
          parentId: process.env.VERS_VM_ID,
          status: "running",
          address: `${vmId}.vm.vers.sh`,
          lastHeartbeat: Date.now(),
        });

        return client.ok(
          `Resource VM "${params.name}" created.\nVM ID: ${vmId}\nSSH: vers_vm_use with vmId ${vmId}\nAddress: ${vmId}.vm.vers.sh`,
          { vmId, name: params.name, address: `${vmId}.vm.vers.sh` },
        );
      } catch (e: any) {
        // Cleanup: mark error + delete leaked VM
        if (vmId) {
          try {
            await client.api("PATCH", `/vm-tree/vms/${vmId}`, { status: "error" });
          } catch {
            /* ok */
          }
          try {
            await client.api("DELETE", `/vers/vm/${vmId}`);
          } catch {
            /* ok */
          }
        }
        return client.err(e.message);
      }
    },
  });
}
