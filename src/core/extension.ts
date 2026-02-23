/**
 * Extension — composes all service modules into a single pi extension.
 *
 * Each module registers its own tools and behaviors. The extension loader
 * creates the shared FleetClient and wires up the composite status widget.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ServiceModule, WidgetContribution } from "./types.js";
import { createFleetClient } from "./client.js";

export function createExtension(modules: ServiceModule[]) {
  return function (pi: ExtensionAPI) {
    const client = createFleetClient();

    // Let each module register its tools and behaviors
    for (const mod of modules) {
      mod.registerTools?.(pi, client);
      mod.registerBehaviors?.(pi, client);
    }

    // Composite widget from all contributing modules
    const widgetContributions: Array<{ name: string; widget: WidgetContribution }> =
      modules
        .filter((m) => m.widget)
        .map((m) => ({ name: m.name, widget: m.widget! }));

    let widgetTimer: ReturnType<typeof setInterval> | null = null;

    async function updateWidget(ctx: {
      ui: { setWidget: (id: string, lines: string[]) => void };
    }) {
      if (!client.getBaseUrl()) return;

      const allLines: string[] = [];
      const base = client.getBaseUrl();
      allLines.push(`--- Fleet Services --- ${base}/ui`);

      for (const { widget } of widgetContributions) {
        try {
          const lines = await widget.getLines(client);
          allLines.push(...lines);
        } catch {
          // Best effort — skip failing widgets
        }
      }

      if (allLines.length > 1) {
        ctx.ui.setWidget("fleet-services", allLines);
      }
    }

    pi.on("session_start", async (_event, ctx) => {
      if (!client.getBaseUrl()) return;
      updateWidget(ctx);
      widgetTimer = setInterval(() => updateWidget(ctx), 30_000);
    });

    pi.on("session_shutdown", async () => {
      if (widgetTimer) {
        clearInterval(widgetTimer);
        widgetTimer = null;
      }
    });
  };
}
