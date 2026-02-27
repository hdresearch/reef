# Changelog

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
