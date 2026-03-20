# GitHub Observability Fleet — Exploration

**Date:** 2026-03-20
**Author:** reef agent
**Branch:** `exploration/github-observability-fleet`
**Status:** Exploration / RFC

---

## What Are We Building?

A **generic GitHub observability module** for reef that:
1. Monitors a configurable set of GitHub repos via PAT
2. Surfaces commits on open branches, PRs, comments, and issues
3. Runs as a fleet of lightweight agent VMs (or cron jobs on the reef server)
4. Provides a **dashboard** showing fleet health + GitHub activity — structured observability, not raw logs

The goal is to answer "what's happening across our repos right now?" at a glance, and to have agents that can react to repo activity (triage issues, review PRs, flag stale branches, etc.).

---

## Current State of the Repos

Snapshot from initial API exploration:

| Repo | Branches | Open PRs | Open Issues | Last Activity |
|------|----------|----------|-------------|---------------|
| `vers-landing` | 100+ | 1 | 27 | 2026-02-05 |
| `vers-docs` | 100+ | 75 | 78 | 2026-03-19 |
| `pi-vers` | 14 | 2 | 7 | recent |
| `reef` | 13 | 0 | 2 | 2026-03-20 |
| `punkin-pi` | 11 | 2 | 2 | 2026-03-16 |

**Observations:**
- `vers-docs` is _drowning_ — 75 open PRs, 78 open issues. This is the highest-value target for automated triage.
- `vers-landing` has 100+ branches (likely stale) and 27 issues but only 1 PR — dead or paused project.
- The active repos (`pi-vers`, `reef`, `punkin-pi`) are manageable but would benefit from commit tracking and PR monitoring.

---

## Architecture Options

### Option A: Reef Service + Cron (Server-Side Polling)

A single reef `ServiceModule` called `github-watch` that:
- Stores a list of watched repos + PAT in reef store
- Uses the existing **cron service** to schedule polling jobs (e.g., every 5m)
- Polls GitHub REST API for each repo: branches, PRs, issues, comments, events
- Stores snapshots in a local JSON/SQLite store
- Diffs snapshots to detect _changes_ (new PR, new comment, closed issue, new commit)
- Emits reef events (`github-watch:new_pr`, `github-watch:new_comment`, etc.)
- Exposes a `/_panel` dashboard

**Pros:**
- Simple. One service, no fleet needed for basic monitoring.
- Low resource usage — just HTTP polling from the reef VM.
- Rate limit friendly: 5000 req/hr, 6 repos × 4 endpoints × 12/hr = ~288 req/hr.

**Cons:**
- Can't _do_ anything with the data autonomously (no agent reasoning).
- Just a dashboard, not a fleet.

### Option B: Fleet of Agent VMs (One Per Repo or Per Concern)

Spawn lieutenant agents from the golden image, each watching a subset:

```
github-fleet/
├── triage-agent      — watches vers-docs issues, auto-labels, suggests closures
├── pr-reviewer       — watches PRs across all repos, posts review summaries
├── branch-janitor    — finds stale branches, proposes cleanup
├── commit-tracker    — watches pushes to open branches, summarizes daily
└── dashboard-agent   — aggregates data from others, maintains dashboard state
```

Each agent runs a polling loop (or is triggered by cron), uses the GitHub API, and reports back to reef.

**Pros:**
- Agents can _reason_ about what they find (e.g., "this PR has been open 30 days with no review").
- Parallelized — each agent works independently.
- Can take action (post comments, label issues, etc.) with user approval.

**Cons:**
- VM overhead for what might be a simple polling job.
- Agents cost tokens — Claude calls for every observation cycle.
- Harder to coordinate across agents.

### Option C: Hybrid — Service for Data, Fleet for Action

**This is the one I'd recommend.**

```
┌──────────────────────────────────────────────────────┐
│                    Reef Server                        │
│                                                       │
│  ┌─────────────────┐    ┌──────────────────────────┐ │
│  │  github-watch    │    │  fleet-dashboard         │ │
│  │  (service)       │    │  (service)               │ │
│  │                  │    │                          │ │
│  │  • polls repos   │───▶│  • aggregates activity   │ │
│  │  • detects Δs    │    │  • shows fleet status    │ │
│  │  • emits events  │    │  • shows github state    │ │
│  │  • stores state  │    │  • /_panel dashboard     │ │
│  └─────────────────┘    └──────────────────────────┘ │
│          │                                            │
│          │ reef events                                │
│          ▼                                            │
│  ┌─────────────────┐                                 │
│  │  cron            │                                 │
│  │  • schedules     │                                 │
│  │    polling jobs   │                                 │
│  └─────────────────┘                                 │
└──────────┬───────────────────────────────────────────┘
           │ triggers (via cron or event)
           ▼
  ┌─────────────────────────────────────────┐
  │         Lieutenant Agents               │
  │                                         │
  │  ┌───────────┐  ┌───────────────────┐  │
  │  │ triage    │  │ pr-review         │  │
  │  │           │  │                   │  │
  │  │ reacts to │  │ reacts to         │  │
  │  │ new issues│  │ new/updated PRs   │  │
  │  └───────────┘  └───────────────────┘  │
  │                                         │
  │  ┌───────────┐  ┌───────────────────┐  │
  │  │ branch    │  │ digest            │  │
  │  │ janitor   │  │                   │  │
  │  │           │  │ daily summary     │  │
  │  │ weekly    │  │ across all repos  │  │
  │  └───────────┘  └───────────────────┘  │
  └─────────────────────────────────────────┘
```

**Layer 1 — `github-watch` service (always running on reef):**
- Polls GitHub API on a schedule (cron job, every 5 minutes)
- Stores normalized snapshots: branches, PRs, issues, comments
- Diffs against previous snapshot → emits change events
- Exposes REST API: `GET /github-watch/repos`, `GET /github-watch/activity`, etc.
- Cheap: no LLM tokens, just HTTP + JSON

**Layer 2 — `fleet-dashboard` service (always running on reef):**
- Subscribes to `github-watch:*` events
- Also shows lieutenant/fleet status from the registry
- Single `/_panel` with two views: GitHub activity + fleet health
- Pure server-side, no agents needed

**Layer 3 — Lieutenant agents (spawned on demand or persistent):**
- Only spin up when there's _work_ to do (new issue to triage, PR to review)
- Or run on a schedule (daily digest, weekly branch cleanup)
- Each agent gets context from the `github-watch` API, reasons about it, takes action
- Report results back to reef

---

## The `github-watch` Service Module

### Data Model

```typescript
interface WatchedRepo {
  owner: string;          // "hdresearch"
  name: string;           // "reef"
  watchBranches: boolean;
  watchPRs: boolean;
  watchIssues: boolean;
  watchComments: boolean;
}

interface RepoSnapshot {
  repo: string;           // "hdresearch/reef"
  timestamp: string;
  branches: BranchInfo[];
  pullRequests: PRInfo[];
  issues: IssueInfo[];
  recentEvents: EventInfo[];
}

interface ActivityEvent {
  id: string;
  repo: string;
  type: "new_pr" | "pr_updated" | "pr_merged" | "pr_closed"
      | "new_issue" | "issue_closed" | "new_comment"
      | "new_branch" | "branch_deleted" | "push";
  title: string;
  author: string;
  url: string;
  timestamp: string;
  details: Record<string, unknown>;
}
```

### API Surface

```
GET  /github-watch/repos              — list watched repos + summary stats
POST /github-watch/repos              — add a repo to watch
DELETE /github-watch/repos/:owner/:name — stop watching

GET  /github-watch/activity           — recent activity feed (all repos)
GET  /github-watch/activity/:owner/:name — activity for one repo

GET  /github-watch/snapshot/:owner/:name — latest full snapshot
GET  /github-watch/stats              — aggregate stats (PRs open, issues open, etc.)

POST /github-watch/poll               — trigger an immediate poll (vs waiting for cron)

GET  /github-watch/_panel             — dashboard HTML
```

### Polling Strategy

GitHub REST API rate limit: **5,000 requests/hour** with PAT.

Per repo per poll cycle:
- `GET /repos/:owner/:repo/branches` — 1 req (paginated if >100)
- `GET /repos/:owner/:repo/pulls?state=open` — 1 req
- `GET /repos/:owner/:repo/issues?state=open` — 1 req
- `GET /repos/:owner/:repo/events` — 1 req (last 30 events)
- `GET /repos/:owner/:repo/issues/comments?sort=updated` — 1 req (recent comments)

**5 requests × 6 repos = 30 requests per poll cycle.**

At every 5 minutes: 30 × 12 = **360 req/hr** → well within limits.

For repos with 100+ branches (vers-docs, vers-landing), we'd paginate but cache — branches don't change often.

### Storage

SQLite makes more sense than JSON here because:
- We're storing time-series data (activity events over time)
- We need queries: "show me all open PRs older than 7 days" or "activity in the last hour"
- Aggregate stats across repos

```sql
CREATE TABLE repos (
  id TEXT PRIMARY KEY,    -- "hdresearch/reef"
  owner TEXT,
  name TEXT,
  config TEXT,            -- JSON: what to watch
  last_polled_at TEXT
);

CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  repo_id TEXT,
  type TEXT,              -- new_pr, push, new_issue, etc.
  title TEXT,
  author TEXT,
  url TEXT,
  timestamp TEXT,
  details TEXT,           -- JSON
  FOREIGN KEY (repo_id) REFERENCES repos(id)
);

CREATE TABLE snapshots (
  repo_id TEXT,
  type TEXT,              -- branches, prs, issues
  data TEXT,              -- JSON array
  fetched_at TEXT,
  PRIMARY KEY (repo_id, type)
);

CREATE INDEX idx_activity_repo ON activity(repo_id, timestamp);
CREATE INDEX idx_activity_type ON activity(type, timestamp);
```

---

## Fleet & Agent Task Observability Dashboard

This is separate from log viewing. The question is: **"what are my agents doing, what have they found, and what's the state of the world?"**

### What It Shows

```
┌─────────────────────────────────────────────────────────────────┐
│  GitHub Observability Fleet                              ⟳ 30s │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─ FLEET STATUS ──────────────────────────────────────────┐   │
│  │                                                          │   │
│  │  Agents: 4 active  │  Tasks today: 12  │  Errors: 0     │   │
│  │                                                          │   │
│  │  triage-agent    🟢 idle      last: 2m ago   tasks: 5    │   │
│  │  pr-reviewer     🟡 working   current: reviewing #42     │   │
│  │  branch-janitor  🟢 idle      last: 1h ago   tasks: 2    │   │
│  │  digest-agent    ⏸️  paused    next: 6:00 PM             │   │
│  │                                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─ GITHUB ACTIVITY (last 24h) ────────────────────────────┐   │
│  │                                                          │   │
│  │  vers-docs    ████████████████████  47 events            │   │
│  │  punkin-pi    ██████                12 events            │   │
│  │  reef         ████                   8 events            │   │
│  │  pi-vers      ██                     4 events            │   │
│  │  vers-landing                        0 events            │   │
│  │                                                          │   │
│  │  Recent:                                                 │   │
│  │  🔀 PR #16 merged: "Codex/reef pivers runtime..."  reef │   │
│  │  💬 Comment on #42 by @nsluss              vers-docs     │   │
│  │  🟢 New issue #79: "SDK type exports..."   vers-docs     │   │
│  │  📌 Push to branch fix/auth-flow           pi-vers       │   │
│  │                                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─ ATTENTION NEEDED ──────────────────────────────────────┐   │
│  │                                                          │   │
│  │  ⚠️  75 open PRs on vers-docs (oldest: 45 days)         │   │
│  │  ⚠️  27 open issues on vers-landing (no activity 43d)   │   │
│  │  📋 PR #3 on punkin-pi: no review for 11 days           │   │
│  │  🌿 42 stale branches on vers-docs (no commits >30d)    │   │
│  │                                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─ AGENT TASK HISTORY ────────────────────────────────────┐   │
│  │                                                          │   │
│  │  12:30  triage-agent   ✅ Labeled 3 issues on vers-docs │   │
│  │  12:25  pr-reviewer    ✅ Reviewed PR #16 on reef        │   │
│  │  11:00  branch-janitor ✅ Flagged 12 stale branches      │   │
│  │  10:30  triage-agent   ✅ Closed 2 duplicate issues      │   │
│  │  09:00  digest-agent   ✅ Posted daily summary            │   │
│  │                                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Key Differences from Log Observability

| Logs | Task Observability |
|------|--------------------|
| Raw stdout/stderr | Structured task outcomes |
| "What happened technically" | "What was accomplished" |
| Debug-oriented | Status/decision-oriented |
| Per-agent | Cross-fleet aggregate |
| Scroll and search | Glanceable dashboard |
| Ephemeral | Persistent (stored in reef) |

### Data Sources for the Dashboard

The dashboard aggregates from multiple reef services:

1. **Registry** (`GET /registry/vms`) — which agents exist, their status, roles
2. **Lieutenant** (`GET /lieutenant/lieutenants`) — agent task state, output
3. **github-watch** (`GET /github-watch/activity`, `/stats`) — repo activity
4. **Cron** (`GET /cron/jobs`, `/runs`) — scheduled job execution
5. **Store** — any agent-reported results stored as KV pairs

This means the **fleet-dashboard is a read-only aggregator** — it doesn't own data, it assembles views from other services.

---

## Module Design: Making It Generic

The `github-watch` service should be **repo-agnostic** — you configure it with:

```json
{
  "pat_key": "github_pat",           // reef store key holding the PAT
  "repos": [
    "hdresearch/vers-landing",
    "hdresearch/vers-docs",
    "hdresearch/pi-vers",
    "hdresearch/reef",
    "hdresearch/punkin-pi"
  ],
  "poll_interval": "5m",
  "watch": {
    "branches": true,
    "pulls": true,
    "issues": true,
    "comments": true,
    "events": true
  }
}
```

Anyone with a GitHub PAT can point this at their repos. The fleet agents are optional — the service works standalone as a polling dashboard.

### Module Breakdown

```
services/
  github-watch/          ← NEW: core polling + storage + API
    index.ts
    store.ts             — SQLite for activity, snapshots
    routes.ts            — REST API
    poller.ts            — GitHub API client + diff logic
    tools.ts             — LLM tools for agents to query github state
    github-watch.test.ts

  fleet-dashboard/       ← NEW: aggregate dashboard
    index.ts
    routes.ts            — /_panel HTML, aggregate stats
    fleet-dashboard.test.ts
```

### Implementation Plan

**Phase 1 — `github-watch` service (the foundation):**
1. GitHub API client with PAT auth and rate limit tracking
2. Poller: fetch branches, PRs, issues, events per repo
3. SQLite store: snapshots + activity events
4. Diff engine: compare current vs previous snapshot → emit change events
5. REST API for querying
6. `/_panel` with basic activity feed
7. Cron job integration for scheduled polling

**Phase 2 — `fleet-dashboard` service:**
1. Read-only aggregator pulling from registry, lieutenant, github-watch, cron
2. Rich `/_panel` with the multi-section dashboard shown above
3. Auto-refresh via polling or SSE

**Phase 3 — Fleet agents (optional, on-demand):**
1. `triage-agent`: watches `github-watch:new_issue` events, auto-labels, finds duplicates
2. `pr-reviewer`: summarizes PR diffs, flags issues, posts review comments
3. `branch-janitor`: weekly job to identify stale branches, propose cleanup
4. `digest-agent`: daily summary across all repos → posted to reef feed

Each agent is a lieutenant spawned from the golden image. They use the `github-watch` API to get context, reason about it, and take action via the GitHub API.

---

## Rate Limit Budget

| Activity | Requests/cycle | Cycles/hr | Total/hr |
|----------|---------------|-----------|----------|
| Branch listing (6 repos) | 6-12 | 12 | 72-144 |
| PR listing (6 repos) | 6 | 12 | 72 |
| Issue listing (6 repos) | 6 | 12 | 72 |
| Events (6 repos) | 6 | 12 | 72 |
| Comment listing (6 repos) | 6 | 12 | 72 |
| **Agent actions** (reviews, labels) | ~10 | 1 | ~10 |
| **Total** | | | **~370-450/hr** |

Budget: 5000/hr. **We're using <10%.** Plenty of headroom for more repos or faster polling.

---

## Open Questions

1. **Webhooks vs polling?** If the reef server has a public URL, we could set up GitHub webhooks instead of polling. Faster, more efficient. But requires a publicly reachable endpoint. The Vers networking skill mentions public URLs are available — worth exploring.

2. **Agent actions — how autonomous?** Should agents auto-comment on PRs? Auto-label issues? Or should they propose actions and wait for human approval? Probably start with "propose" mode and graduate to autonomous for low-risk actions.

3. **Cross-repo correlation?** E.g., "this PR on pi-vers references issue #42 on reef" — useful but complex. Phase 2+.

4. **Notification routing?** When the fleet detects something interesting, where does the notification go? Reef feed? Slack webhook? Email? All of the above?

5. **Historical backfill?** Should we backfill activity from before the service was installed? The GitHub Events API only goes back ~90 days and 300 events per repo. For issues/PRs we can get full history but it's more API calls.

6. **How much of this is the service vs how much is agent intelligence?** The service is the eyes (data collection + change detection). The agents are the brain (reasoning, triage, review). The dashboard is the face (presenting it all). Keep them cleanly separated.

---

## Next Steps

If this direction makes sense:

1. **Build `github-watch` service** — I can implement this directly as a reef service module. It's server-side only for Phase 1, no fleet needed.
2. **Wire up cron polling** — Use the existing cron service to schedule poll jobs.
3. **Build the `/_panel` dashboard** — HTML panel showing activity feed + stats.
4. **Test with our 5 repos** — Get real data flowing.
5. **Then explore fleet agents** — Start with a triage agent for vers-docs (75 open PRs is a problem).

The whole Phase 1 is maybe 2-3 hours of implementation. Want me to start building?
