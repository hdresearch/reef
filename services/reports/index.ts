import type { ServiceModule } from "../../src/core/types.js";
import { createRoutes } from "./routes.js";
import { ReportsStore } from "./store.js";

const store = new ReportsStore();

const reports: ServiceModule = {
  name: "reports",
  description: "Markdown reports",
  routes: createRoutes(store),
  store,

  routeDocs: {
    "POST /": {
      summary: "Create a report",
      body: {
        title: { type: "string", required: true, description: "Report title" },
        content: { type: "string", required: true, description: "Markdown content" },
        author: { type: "string", description: "Report author" },
        tags: { type: "string[]", description: "Tags for categorization" },
      },
      response: "The created report with ID and timestamp",
    },
    "GET /": {
      summary: "List reports (summaries without content)",
      query: {
        author: { type: "string", description: "Filter by author" },
        tag: { type: "string", description: "Filter by tag" },
      },
      response: "{ reports, count } — reports omit content field for lighter payload",
    },
    "GET /:id": {
      summary: "Get a report by ID (includes full content)",
      params: { id: { type: "string", required: true, description: "Report ID" } },
    },
    "GET /_panel": {
      summary: "HTML panel showing recent reports",
      response: "text/html",
    },
    "DELETE /:id": {
      summary: "Delete a report",
      params: { id: { type: "string", required: true, description: "Report ID" } },
    },
  },
};

export default reports;
