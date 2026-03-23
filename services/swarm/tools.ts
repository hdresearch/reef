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
        return client.ok(`[${result.id}] (${result.status}):${warning}\n${result.output}`, {
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

        const agentResults = result.agents.map((a: any) => `=== ${a.id} [${a.status}] ===\n${a.output}\n`).join("\n");

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
}
