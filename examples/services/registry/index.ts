/**
 * Registry service module — VM service discovery for agent fleets.
 */

import type { ServiceModule, FleetClient } from "../src/core/types.js";
import { RegistryStore } from "./store.js";
import { createRoutes } from "./routes.js";
import { registerTools } from "./tools.js";
import { registerBehaviors } from "./behaviors.js";

const store = new RegistryStore();

const registry: ServiceModule = {
  name: "registry",
  description: "VM service discovery",
  routes: createRoutes(store),
  store,
  registerTools,
  registerBehaviors,

  widget: {
    async getLines(client: FleetClient) {
      try {
        const res = await client.api<{ vms: { status: string }[]; count: number }>(
          "GET",
          "/registry/vms",
        );
        const running = res.vms.filter((v) => v.status === "running").length;
        return [`Registry: ${res.count} VMs (${running} running)`];
      } catch {
        return [];
      }
    },
  },
};

export default registry;
