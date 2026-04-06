/**
 * Pi extension entrypoint — discovers service modules and composes their
 * client-side code into a single extension that agents install.
 *
 * v2: Category-based service selection replaces the binary REEF_CHILD_AGENT flag.
 * Each VM category gets a specific set of services.
 */

import { dirname, join } from "node:path";
import { discoverServiceModules, filterClientModules } from "./core/discover.js";
import { createExtension } from "./core/extension.js";

/**
 * Resolve which services this agent should load based on its category.
 *
 * infra_vm (root): all services
 * lieutenant: agent-context, scheduled, signals, swarm, store, github, vm-tree
 * agent_vm: agent-context, scheduled, signals, swarm, store, github
 * swarm_vm: agent-context, scheduled, signals, swarm, store, github
 * resource_vm: none (not an agent)
 *
 * Backward compat: REEF_CHILD_AGENT=true without REEF_CATEGORY → treat as swarm_vm
 */
export function resolveClientServiceSelection(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const category =
    env.REEF_CATEGORY ||
    (env.VERS_AGENT_ROLE === "lieutenant" ? "lieutenant" : undefined) ||
    (env.REEF_CHILD_AGENT === "true" ? "swarm_vm" : undefined);

  if (!category) return undefined; // infra_vm / root: load all

  switch (category) {
    case "infra_vm":
      return undefined; // all services

    case "lieutenant":
      return ["agent-context", "scheduled", "signals", "swarm", "store", "github", "logs", "probe", "vm-tree"];

    case "agent_vm":
      return ["agent-context", "scheduled", "signals", "swarm", "store", "github", "logs", "probe"];

    case "swarm_vm":
      return ["agent-context", "scheduled", "signals", "swarm", "store", "github", "logs", "probe"];

    case "resource_vm":
      return []; // no agent, no services

    default:
      // Unknown category — fallback to child-safe set
      return ["agent-context", "scheduled", "signals", "swarm", "store", "github", "logs", "probe"];
  }
}

const servicesDir = process.env.SERVICES_DIR ?? join(dirname(import.meta.dir), "services");
const allModules = await discoverServiceModules(servicesDir, {
  includeNames: resolveClientServiceSelection(),
});
const clientModules = filterClientModules(allModules);

export default createExtension(clientModules);
