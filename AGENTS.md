# Reef Agent Architecture

Reef is an agent with a server — not a server with an agent.

## How It Works

When a task arrives via `POST /reef/submit`, reef spawns a **fresh pi process** in RPC mode. Pi loads all extensions (VM tools, store tools, deploy tools) and skills from `package.json` + `settings.json`. The agent does the work — writes files, runs tests, deploys services, manages VMs — then shuts down.

There is no long-lived agent process. Each task gets its own pi. Multiple tasks run concurrently as separate processes. When a task finishes, the process dies and reef captures the output.

## The Conversation Tree

`src/tree.ts` — the agent's memory. Every task appends to it:

```
[system] You are a reef agent...
[user]   Create an echo service...
[assistant] I created services/echo/index.ts with...
[user]   Store the build status...
[assistant] Done. Stored key "status" with...
```

Each new task's pi process gets the full tree as context via `--append-system-prompt`. The agent knows what it's already done.

## Tools

The agent has whatever tools its extensions provide. Right now:

- **bash, read, edit, write** — pi builtins
- **reef_manifest, reef_deploy** — discover and deploy services
- **reef_store_get, reef_store_put, reef_store_list** — key-value persistence
- **vers_vms, vers_vm_create, vers_vm_delete, vers_vm_commit, vers_vm_restore, vers_vm_branch, vers_vm_state, vers_vm_use, vers_vm_local** — Vers VM management
- **vers_vm_copy** — copy files between VMs and local
- **remind_me, reminders** — schedule future work

Because each task spawns a fresh pi, **new tools appear immediately**. Deploy a service with `registerTools` and the next task sees them.

## File Attachments

Users attach files (images, PDFs, documents) via the reef UI. Uploaded files are saved to `data/uploads/` and served at `/reef/files/<filename>`.

**Images:** You CAN view images. Use the Read tool on the file path — it renders images visually. When a message includes `[Attached image: ... — Use the Read tool on "..." to view it]`, always read the file to see the image before responding. Do not say you cannot view images.

**Text files:** Content is embedded directly in the prompt.

**Other files (PDFs, docx, etc.):** Saved to disk. Use bash to extract content (e.g., `pdftotext`, `python3`).

**Remote agents:** Lieutenants and swarm workers on other VMs can use `reef_files` to list available files and `reef_download` to fetch them to their local filesystem.

## Services

Services run on the Hono server and provide both HTTP routes and agent tools. The agent can build new services, deploy them, and immediately use their tools in the next task.

```
services/
  agent/      — spawn pi tasks (the old way, still works)
  cron/       — schedule recurring jobs
  docs/       — auto-generated API documentation
  installer/  — install services from git/local/fleet
  services/   — runtime module management + deploy
  store/      — key-value persistence
  ping/       — built by the agent
  echo/       — built by the agent
```

## Why No Orchestration Code

Previous iterations tried to build orchestration:
- A pipeline service (stages, gates, workspace transfer) — 500+ lines, failed for hours
- A branch executor (SSH, VM polling, merge queues) — 400+ lines, hung at 89% CPU

The current architecture: **0 lines of orchestration**. The agent has tools. It decides what to do. If it needs to parallelize, it uses `reef_swarm_spawn`. If it needs to decompose, it spawns sub-agents. The "orchestrator" is the agent's judgment, not our code.

## API

```
POST /reef/submit   {"task": "..."}  → spawns pi, returns task ID
GET  /reef/state                      → active tasks, conversation length, services
GET  /reef/tasks                      → all tasks with status
GET  /reef/tasks/:id                  → task detail with full output
GET  /reef/tree                       → conversation history
GET  /reef/events                     → SSE stream of real-time agent events
```

## Running

```bash
# Env vars
LLM_PROXY_KEY=...       # required (sk-vers-...)
VERS_AUTH_TOKEN=...     # auth for reef HTTP API
VERS_API_KEY=...        # for VM management tools

# Start
bun run src/main.ts
```

The root Reef task runner is pinned to `claude-opus-4-6-thinking`. Remote and local lieutenants default to the same model unless you override `model` at create time. Swarm workers default to `claude-sonnet-4-6`.

## Vers VM Operations

Reef agents run on [Vers](https://vers.sh) — a platform for instant-snapshot microVMs. VMs can be created, committed (snapshotted), restored, and branched like git commits.

### Golden Images

A golden image is a committed VM snapshot with everything pre-installed (bun, pi, reef, extensions, .env). Branch from it to get a ready-to-go agent VM in seconds.

```
Golden commit: a3483186-6e6c-4b7f-8003-b3a42e166399
  Has: bun 1.3.10, node 22, pi 0.55.3, reef + all services
```

### Spawning Work on Other VMs

The agent can delegate work to other VMs using swarm tools:

```
1. reef_swarm_spawn  — branch N VMs from golden commit, start pi on each
2. reef_swarm_task   — send a task to a specific agent
3. reef_swarm_wait   — block until agents finish, get results
4. reef_swarm_read   — read an agent's output
5. vers_vm_copy      — pull files from a remote VM back to this one
6. reef_swarm_teardown — delete all swarm VMs
```

Example — build a service on a separate VM:
```
reef_swarm_spawn(commitId: "a3483186...", count: 1, labels: ["builder"])
reef_swarm_task(agentId: "builder", task: "Build a cron service with tests")
reef_swarm_wait()
vers_vm_copy(src: "vm:<vmId>:/root/reef/services/cron/", dst: "/root/reef/services/cron/")
reef_swarm_teardown()
```

### Direct VM Management

For lower-level control:

```
vers_vm_create     — create a fresh root VM
vers_vm_restore    — restore from a commit (golden image)
vers_vm_use        — SSH into a VM (all bash/read/write go there)
vers_vm_local      — switch back to local execution
vers_vm_commit     — snapshot current VM state
vers_vm_branch     — fork a running VM
vers_vm_delete     — destroy a VM
vers_vm_copy       — copy files between VMs or local
```

### Known Vers Quirks

- **DNS breaks after restore**: run `echo "nameserver 8.8.8.8" > /etc/resolv.conf`
- **Bun fetch() hangs on VMs**: use `curl` via bash for external HTTP calls
- **2GB RAM limit**: heavy workloads (reef + agent + large builds) can OOM
- **PATH order matters**: system bins (`/usr/bin`) before bun (`/root/.bun/bin`) so real `node` and `pi` aren't shadowed
- **SSH flaky on first connect**: retry `vers_vm_use` if it fails the first time

## Philosophy: Build What You Need

Some tasks will seem impossibly large. That's fine. You are not limited to what exists — you build what you need.

If a task requires infrastructure you don't have, create it:
- **Need a git server?** Spawn a VM, install Gitea, configure it.
- **Need a database?** Spin up Postgres on a VM, write a service module that wraps it.
- **Need to process 10GB of data?** Spawn 10 VMs, partition the work, collect results.
- **Need a CI pipeline?** Write a service that watches repos and runs tests on branched VMs.
- **Need a web scraper?** Build one as a service, deploy it, use it from the next task.
- **Need to coordinate with other agents?** Use the store service for shared state, or build a message queue service.

### Don't Balk, Decompose

When a task is too big for one agent:

1. **Assess** — what does this actually require?
2. **Decompose** — break it into pieces that can run in parallel
3. **Spawn** — `reef_swarm_spawn` with one agent per piece
4. **Delegate** — `reef_swarm_task` each piece with clear instructions
5. **Collect** — `reef_swarm_wait` + `vers_vm_copy` to gather results
6. **Integrate** — merge the pieces together on this VM

You have functionally unlimited VMs. Each one is a full Linux machine with all your tools. Use them.

### The Self-Improvement Loop

You can extend reef itself:

1. **Discover** what exists: `reef_manifest`
2. **Build** a new service: write files with `write`, test with `bash`
3. **Deploy** it: `reef_deploy` — validates, tests, and loads it live
4. **Use it** immediately: the next task gets the new tools

Services you deploy become tools for future tasks. You are building the platform you run on.

### Examples of Complex Tasks You Can Handle

- "Set up a development environment for a Rust project with CI/CD"
  → Spawn a VM, install Rust toolchain, configure Gitea + webhook service, write test runner

- "Analyze this codebase and generate a technical report"
  → Spawn agents per module, each analyzes their part, collect and synthesize

- "Build a monitoring dashboard for our fleet"
  → Create a service that polls VM health, write a panel, deploy it

- "Migrate this database schema and backfill data"
  → Spawn a VM with the database, write migration scripts, run them, verify

- "Build and deploy a REST API from this OpenAPI spec"
  → Parse the spec, scaffold routes, implement handlers, test, deploy

Don't ask permission. Don't say "I can't." Figure out what tools you need and build them.
