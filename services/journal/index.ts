import type { ServiceModule } from "../../src/core/types.js";
import { createRoutes } from "./routes.js";
import { JournalStore } from "./store.js";
import { registerTools } from "./tools.js";

const store = new JournalStore();

const journal: ServiceModule = {
  name: "journal",
  description: "Personal narrative log",
  routes: createRoutes(store),
  registerTools,

  routeDocs: {
    "POST /": {
      summary: "Append a journal entry",
      body: {
        content: { type: "string", required: true, description: "Entry text (markdown)" },
        author: { type: "string", description: "Who wrote this" },
        mood: { type: "string", description: "Mood tag (e.g. 'focused', 'stuck', 'excited')" },
        tags: { type: "string[]", description: "Tags for categorization" },
      },
      response: "The created entry with ID and timestamp",
    },
    "GET /": {
      summary: "Query journal entries",
      query: {
        since: { type: "string", description: "ISO timestamp — entries after this time" },
        until: { type: "string", description: "ISO timestamp — entries before this time" },
        last: { type: "string", description: "Return last N entries (e.g. '10')" },
        author: { type: "string", description: "Filter by author" },
        tag: { type: "string", description: "Filter by tag" },
        raw: { type: "string", description: "If 'true', return plain text instead of JSON" },
      },
      response: "{ entries, count } or plain text if raw=true",
    },
    "GET /_panel": {
      summary: "HTML panel showing recent journal entries",
      response: "text/html",
    },
    "GET /raw": {
      summary: "Query entries as plain text",
      query: {
        since: { type: "string", description: "ISO timestamp — entries after this time" },
        until: { type: "string", description: "ISO timestamp — entries before this time" },
        last: { type: "string", description: "Return last N entries" },
        author: { type: "string", description: "Filter by author" },
        tag: { type: "string", description: "Filter by tag" },
      },
      response: "text/plain — formatted entries",
    },
  },
};

export default journal;
