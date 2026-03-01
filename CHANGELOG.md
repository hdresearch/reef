# Changelog

## 0.3.0

### Agent-first architecture

Reef is now an agent with a server, not a server with an agent.

- **Event tree** (`src/tree.ts`) — every event is a node with a `parentId`. User prompts, tool calls, tool results, assistant responses, cron fires, service deploys — all in a single causal tree. Refs point to leaf nodes like git branches.
- **Per-task pi processes** (`src/reef.ts`) — each `POST /reef/submit` spawns a fresh `pi --mode rpc` process. Concurrent tasks run as concurrent processes. No long-lived agent.
- **Conversation continuation** — `POST /reef/submit` accepts `parentId` to reply to any node. The server walks ancestors for context.
- **Tree API** — `GET /reef/tree`, `GET /reef/tree/:id`, `GET /reef/tree/:id/path`, `GET /reef/tasks`
- **SSE events include tree coordinates** — every broadcast has `nodeId` and `parentId` so clients can build the tree live

### New services

- **KV store** (`services/store/`) — `GET/PUT/DELETE /store/:key`, TTL support, `reef_store_get`/`reef_store_put`/`reef_store_list` tools
- **Cron** (`services/cron/`) — pure TypeScript scheduling with cron expressions + simple intervals. Job types: agent (posts to `/reef/submit`), HTTP, exec

### Feed UI

- **Threaded feed** (`services/ui/`) — split-pane layout with activity feed + branch conversations
- `feedAdd(nodeId, parentId, tag, text)` — single primitive, renders actual tree
- Reddit-style CSS tree lines for visual nesting
- Branch panel streams full conversations with tool call details
- Conversation continuation from branch panel

### Agent tools

- `reef_task_list` / `reef_task_read` — inspect completed tasks
- `reef_store_get` / `reef_store_put` / `reef_store_list` — key-value storage

### Removed

- **Agent service** (`services/agent/`) — replaced entirely by `src/reef.ts`. The old `/agent/tasks` and `/agent/sessions` endpoints are gone. Use `POST /reef/submit` instead.
- **Branch/merge/loop** (`src/branch.ts`, `src/merge.ts`, `src/loop.ts`) — 1,361 lines of orchestration code. The agent orchestrates itself with tools.

### Developer experience

- **Biome linter** — `bun run lint`, `bun run lint:fix`, pre-commit hook
- **REEF_DATA_DIR** env var — configurable data directory (default: `data/`)
- **277 tests** across 19 files (up from 265)

## 0.2.0

- **Scaffold service** (`examples/services/scaffold/`) — generate structurally correct service module skeletons
  - `POST /scaffold/preview` — generate files, return without writing
  - `POST /scaffold/create` — generate, write to disk, optionally hot-load
  - Generates index.ts, store.ts, routes.ts, tools.ts, behaviors.ts, panel HTML, test file
- **Deploy endpoint** (`POST /services/deploy`) — validate, test, and load a service in one atomic operation
  - Four steps: validate → test → load → verify
  - Runs `bun test` on *.test.ts files; failing tests prevent loading
  - Returns structured step-by-step results
- **Seed provenance** — consolidated from standalone seeds service into installer + services manager
  - Installer: `seed` field on registry entries, `GET /installer/seeds` for seed-grouped view
  - Services manager: `POST /services/check` (capability pre-flight), `GET /services/conformance` (conformance manifest), `POST /services/seeds/register`, `PATCH /services/seeds/:hash`
- **Pi extension tools** — `reef_manifest` and `reef_deploy` registered on the services manager
  - Agents discover reef and deploy services without leaving the conversation
- **Vers VM extensions** — bundled vers-vm.ts and vers-vm-copy.ts from pi-v
  - Full VM lifecycle (create, branch, commit, restore), SSH routing, file transfer
  - Auto-discovered by pi alongside reef's service tools
- **Extension tests** — 28 tests covering FleetClient, discover, filterClientModules, createExtension
- Substrate capability computation extracted into shared helper
- 195 tests, 660 assertions across 15 files

## 0.1.6

- Remove board, feed, and ui from `services/` — they were shipping as defaults but belong in `examples/services/`
- `services/` now only contains core infrastructure: agent, docs, installer, services

## 0.1.5

- Move updater service to `examples/services/` (not core infrastructure)
- Split CI: tests run on every push to main, publish only triggers on `v*` tags
- Trusted publishing via OIDC — no npm tokens in CI

## 0.1.4

- Add updater service — auto-update reef from npm
  - `GET /updater/status` — current version, latest available, update history
  - `POST /updater/check` — check npm for newer version
  - `POST /updater/apply` — apply update and restart
  - Optional polling with `UPDATE_POLL_INTERVAL` (minutes)
  - Optional auto-apply with `UPDATE_AUTO_APPLY=true`
- 126 tests, 324 assertions

## 0.1.3

- Add READMEs to all example services (board, commits, feed, journal, log, registry, reports, ui, usage)

## 0.1.2

- Switch to npm trusted publishing via OIDC — no tokens needed
- Scope package under `@versdotsh/reef`

## 0.1.1

- Add GitHub Actions CI (test & publish on push to main)
- Add `.gitignore` for `data/` directory
- Add test harness (`src/core/testing.ts`) — `createTestHarness()` for isolated service testing
- Add tests for all example services (board, commits, feed, journal, log, registry, reports, usage)
- Add UI panels section and testing section to create-service skill
- 122 tests, 304 assertions

## 0.1.0

- Initial release
- Core: dynamic dispatch server, module discovery with topo-sort, bearer token auth
- Infrastructure services: agent, docs, installer, services manager
- Agent service: fire-and-forget tasks via `pi -p`, interactive sessions via `pi --mode rpc`, SSE streaming
- Installer: git clone, local symlink, fleet-to-fleet tarball install/update
- Docs service: auto-generated API docs from `routeDocs` metadata
- Services manager: list, reload, unload modules at runtime
- Example services: board, commits, feed, journal, log, registry, reports, ui, usage
- Dynamic panel system: services serve `GET /_panel` HTML fragments, UI discovers and injects them
- UI service: web dashboard with magic link auth, API proxy, chat interface
- Pi extension: `filterClientModules()` for client-side tool/behavior registration
- Create-service skill for teaching agents to write new modules
- 60 core tests
