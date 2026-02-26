/**
 * Pi extension entrypoint — discovers service modules and composes their
 * client-side code into a single extension that agents install.
 *
 * This is the client half. The server half is src/main.ts.
 */

import { createExtension } from "./core/extension.js";
import { discoverServiceModules, filterClientModules } from "./core/discover.js";
import { DEFAULT_SERVICES_DIR } from "./core/server.js";

const servicesDir = process.env.SERVICES_DIR ?? DEFAULT_SERVICES_DIR;
const allModules = await discoverServiceModules(servicesDir);
const clientModules = filterClientModules(allModules);

export default createExtension(clientModules);
