import type { ServiceModule } from "../src/core/types.js";
import { createRoutes } from "./routes.js";
import { LogStore } from "./store.js";
import { registerTools } from "./tools.js";

const store = new LogStore();

const log: ServiceModule = {
  name: "log",
  description: "Append-only work log",
  routes: createRoutes(store),
  registerTools,

  routeDocs: {
    "POST /": {
      summary: "Append a log entry",
      body: {
        content: { type: "string", required: true, description: "Log message" },
        agent: { type: "string", description: "Agent that created this entry" },
        tags: { type: "string[]", description: "Tags for categorization" },
      },
      response: "The created entry with ID and timestamp",
    },
    "GET /": {
      summary: "Query log entries by time range",
      query: {
        since: { type: "string", description: "ISO timestamp — entries after this time" },
        until: { type: "string", description: "ISO timestamp — entries before this time" },
        last: { type: "string", description: "Return last N entries (e.g. '10')" },
      },
      response: "{ entries, count }",
    },
    "GET /_panel": {
      summary: "HTML panel showing recent log entries",
      response: "text/html",
    },
    "GET /raw": {
      summary: "Query log entries as plain text",
      query: {
        since: { type: "string", description: "ISO timestamp — entries after this time" },
        until: { type: "string", description: "ISO timestamp — entries before this time" },
        last: { type: "string", description: "Return last N entries" },
      },
      response: "text/plain — formatted log entries",
    },
  },
};

export default log;
