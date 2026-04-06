---
name: scheduled-orchestration
description: Use when reef needs deferred attention, follow-up checks, deadlines, or condition-based orchestration via scheduled checks instead of reminder-style timers.
---

# Scheduled Orchestration

Use scheduled checks for deferred orchestration attention.

Primary tools:
- `reef_schedule_check`
- `reef_scheduled`
- `reef_cancel_scheduled`

## When to use scheduled checks

Use them for:
- follow-up checks
- deadlines
- waiting on signal/store/status conditions
- future attention that must survive after the current turn ends

Do not use reminder-style timers as the normal orchestration primitive.

## Common patterns

### Follow-up

Use `follow_up` when:
- something should be checked later
- there is no precise event to wait on

### Condition-first orchestration

Use:
- `await_signal`
- `await_store`
- `await_status`

with `triggerOn` when the check should fire because a condition becomes true.

Timeout is optional. Only provide one if timeout behavior matters.

## Recommended flow

1. create the scheduled check
2. inspect it with `reef_scheduled`
3. cancel or supersede it when the follow-up is no longer needed
4. end the current task once future attention has been externalized

## Design rule

If you are only keeping the current turn alive because you might need to look again later, use a scheduled check and conclude the turn.
