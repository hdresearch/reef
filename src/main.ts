/**
 * Entrypoint — loads all service modules and starts the server.
 */

import { startServer } from "./core/server.js";
import board from "./services/board/index.js";
import feed from "./services/feed/index.js";
import registry from "./services/registry/index.js";
import log from "./services/log/index.js";
import ui from "./services/ui/index.js";

startServer({
  modules: [board, feed, registry, log, ui],
});
