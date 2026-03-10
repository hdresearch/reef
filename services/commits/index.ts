import type { ServiceModule } from "../../src/core/types.js";
import { createRoutes } from "./routes.js";
import { CommitStore } from "./store.js";

const store = new CommitStore();

const commits: ServiceModule = {
  name: "commits",
  description: "VM snapshot ledger",
  routes: createRoutes(store),
  store: {
    close: () => {
      store.close();
      return Promise.resolve();
    },
  },

  routeDocs: {
    "POST /": {
      summary: "Record a VM snapshot commit",
      body: {
        commitId: { type: "string", required: true, description: "Vers commit ID" },
        vmId: { type: "string", required: true, description: "Source VM ID" },
        tag: { type: "string", description: "Label (e.g. 'golden', 'checkpoint')" },
        agent: { type: "string", description: "Agent that created this commit" },
        label: { type: "string", description: "Human-readable label" },
        notes: { type: "string", description: "Additional notes" },
      },
      response: "The recorded commit with generated ID and timestamp",
    },
    "GET /": {
      summary: "List commits with optional filters",
      query: {
        tag: { type: "string", description: "Filter by tag" },
        agent: { type: "string", description: "Filter by agent" },
        label: { type: "string", description: "Filter by label" },
        vmId: { type: "string", description: "Filter by source VM ID" },
        since: { type: "string", description: "ISO timestamp — only commits after this time" },
      },
      response: "{ commits, count }",
    },
    "GET /:id": {
      summary: "Get a commit by ID",
      params: { id: { type: "string", required: true, description: "Commit record ID" } },
    },
    "GET /_panel": {
      summary: "HTML panel showing recent commits",
      response: "text/html",
    },
    "DELETE /:id": {
      summary: "Delete a commit record",
      params: { id: { type: "string", required: true, description: "Commit record ID" } },
    },
  },
};

export default commits;
