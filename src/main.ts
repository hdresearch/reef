/**
 * Server entrypoint — discovers service modules and starts the server.
 *
 * Configure via env vars:
 *   SERVICES_DIR  — path to services directory (default: ./services)
 *   PORT          — server port (default: 3000)
 */

import { startServer } from "./core/server.js";

await startServer();
