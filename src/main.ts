/**
 * Reef entrypoint — an agent with a server.
 *
 * In agent mode (VERS_COMMIT_ID + ANTHROPIC_API_KEY set):
 *   Tasks submitted via POST /reef/submit fork conversation branches,
 *   execute on Vers VMs, and merge results back to main.
 *
 * In service-only mode (no agent config):
 *   Runs as a normal service server — backwards compatible.
 *
 * Configure via env vars:
 *   SERVICES_DIR       — path to services directory (default: ./services)
 *   PORT               — server port (default: 3000)
 *   VERS_COMMIT_ID     — golden VM commit to fork branches from
 *   ANTHROPIC_API_KEY  — API key for branch agents
 *   PI_MODEL           — model for branch agents (default: claude-sonnet-4-20250514)
 *   VERS_API_KEY       — Vers platform API key
 *   VERS_BASE_URL      — Vers API base URL
 *   REEF_MAX_CONCURRENT — max concurrent branches (default: 5)
 *   REEF_SYSTEM_PROMPT  — system prompt for the agent
 */

import { startReef } from "./reef.js";

await startReef();
