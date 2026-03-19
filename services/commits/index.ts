import type { ServiceModule } from "../../src/core/types.js";
import { type EnsureGoldenResult, ensureGoldenCommit } from "./golden.js";
import { createRoutes } from "./routes.js";
import { CommitStore } from "./store.js";

export function createCommitsService(
  options: {
    ensureGolden?: (options?: { force?: boolean; label?: string }) => Promise<EnsureGoldenResult>;
    store?: CommitStore;
  } = {},
): ServiceModule {
  const store = options.store || new CommitStore();

  return {
    name: "commits",
    description: "VM snapshot ledger — tracks golden images and checkpoints",
    routes: createRoutes(store, options.ensureGolden || ((opts) => ensureGoldenCommit(store, opts))),
    store: {
      close: () => {
        store.close();
        return Promise.resolve();
      },
    },
    capabilities: ["vm.snapshot", "vm.golden"],
    routeDocs: {
      "POST /": {
        summary: "Record a VM snapshot commit",
        body: {
          commitId: { type: "string", required: true, description: "Vers commit ID" },
          vmId: { type: "string", required: true, description: "Source VM ID" },
          label: { type: "string", description: "Human-readable label" },
          agent: { type: "string", description: "Agent that created the snapshot" },
          tags: { type: "string[]", description: "Tags such as golden or checkpoint" },
        },
        response: "The recorded commit",
      },
      "GET /": {
        summary: "List recorded commits",
        query: {
          tag: { type: "string", description: "Filter by tag" },
          agent: { type: "string", description: "Filter by agent" },
          label: { type: "string", description: "Filter by label" },
          vmId: { type: "string", description: "Filter by VM ID" },
        },
        response: "{ commits, count }",
      },
      "GET /current/golden": {
        summary: "Get the current default golden commit if one is known",
        response: "{ commitId, source, record? }",
      },
      "POST /ensure-golden": {
        summary: "Return the current golden commit, creating one from a fresh child-agent VM if needed",
        body: {
          force: { type: "boolean", description: "Force creation even if a golden commit already exists" },
          label: { type: "string", description: "Optional label for the created golden record" },
        },
        response: "{ commitId, created, source, vmId?, record? }",
      },
      "GET /:id": {
        summary: "Get a commit by commitId",
        params: { id: { type: "string", required: true, description: "Commit ID" } },
      },
      "DELETE /:id": {
        summary: "Delete a recorded commit by commitId",
        params: { id: { type: "string", required: true, description: "Commit ID" } },
      },
      "GET /_panel": {
        summary: "HTML dashboard showing recent commits and the current golden commit",
        response: "text/html",
      },
    },
  };
}

export default createCommitsService();
