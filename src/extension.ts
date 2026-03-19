/**
 * Pi extension entrypoint — discovers service modules and composes their
 * client-side code into a single extension that agents install.
 *
 * This is the client half. The server half is src/main.ts.
 */

import { discoverServiceModules, filterClientModules } from "./core/discover.js";
import { createExtension } from "./core/extension.js";
import { DEFAULT_SERVICES_DIR } from "./core/server.js";

const CHILD_SAFE_SERVICE_NAMES = ["agent-context"];

export function resolveClientServiceSelection(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  return env.REEF_CHILD_AGENT === "true" ? CHILD_SAFE_SERVICE_NAMES : undefined;
}

const servicesDir = process.env.SERVICES_DIR ?? DEFAULT_SERVICES_DIR;
const allModules = await discoverServiceModules(servicesDir, {
  includeNames: resolveClientServiceSelection(),
});
const clientModules = filterClientModules(allModules);

export default createExtension(clientModules);
