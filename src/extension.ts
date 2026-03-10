/**
 * Pi extension entrypoint — discovers service modules and composes their
 * client-side code into a single extension that agents install.
 *
 * This is the client half. The server half is src/main.ts.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverServiceModules, filterClientModules } from "./core/discover.js";
import { createExtension } from "./core/extension.js";
import { DEFAULT_SERVICES_DIR } from "./core/server.js";

// Resolve services dir relative to the package root, not CWD.
// This file is at <package>/src/extension.ts, so package root is one level up.
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const defaultServicesDir = resolve(packageRoot, "services");

const servicesDir =
  process.env.SERVICES_DIR ?? (existsSync(defaultServicesDir) ? defaultServicesDir : DEFAULT_SERVICES_DIR);
const allModules = await discoverServiceModules(servicesDir);
const clientModules = filterClientModules(allModules);

export default createExtension(clientModules);
