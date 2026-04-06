---
name: logs-debugging
description: Use when debugging Reef or fleet behavior through logs, including keyword/date filtering, per-agent inspection, post-mortem analysis, and handoff investigation.
---

# Logs And Debugging

Use this skill when logs are the fastest way to understand what happened.

## Logs browser

The logs surface is a real browser now:
- all matching logs are available
- keyword filtering is server-side
- date-range filtering is server-side
- agent filtering is supported
- level filtering is supported

Use it when you need:
- incident triage
- post-mortem analysis
- root decision review
- targeted search over a large fleet

## Recommended debugging flow

1. narrow by agent if you know the owner of the problem
2. use keyword search for the failure or artifact name
3. use date-range filtering to bound the incident window
4. switch to history-aware fleet inspection if the relevant agent has already stopped

## Post-mortem rule

Stopped descendants are still valid post-mortem subjects.
If the issue happened in the past:
- inspect historical lineage explicitly
- then read the relevant logs

## What to log

Use `reef_log` for:
- important decisions
- state changes
- abnormal situations
- recovery actions

Good logs make later handoff and root supervision cheaper.
