---
name: coordination-patterns
description: Use when agents need to coordinate through reef store, peer signals, barriers, rendezvous, or child/peer communication without breaking authority boundaries.
---

# Coordination Patterns

Use this skill when you need coordination, not just raw messaging.

## Model

- tree for authority
- peer signals for coordination
- store for synchronization

Use:
- `reef_command` for parent -> descendant control
- `reef_signal` for child -> parent reporting
- `reef_peer_signal` for same-parent sibling coordination
- `reef_inbox_wait` for waiting on message arrival inside the current turn
- `reef_store_list` for discovery
- `reef_store_wait` for synchronization
- `reef_schedule_check` for future attention beyond the current turn

## Store rules

- your writes are namespaced to your agent name
- write your own keys with `reef_store_put`
- discover sibling keys with `reef_store_list`
- do not guess full namespaced keys if discovery can answer it
- do not pre-prefix another agent's name into your own write key; if your agent is `skill-agent`, write `skill-agent:coord/phase`, not `wait-swarm:coord/phase`

## Recommended barrier pattern

1. write your readiness key
2. discover the coordination prefix with `reef_store_list`
3. wait on the barrier with `reef_store_wait(prefix)`
4. exchange ephemeral coordination with `reef_peer_signal` only while both peers are alive

Prefer:
- `reef_inbox_wait` when you are waiting for a child/parent/peer message to arrive now
- `reef_store_wait(prefix)` for barriers and rendezvous
- `reef_store_wait(key)` for exact logical conditions
- `reef_schedule_check` when the attention should outlive the current turn

## When to use peer signals

Use `reef_peer_signal` for:
- artifact handoff
- warnings
- requests
- coordination acknowledgements

Do not use it for:
- steering another agent
- overriding parent direction
- long-lived state that should survive after one peer exits

If the coordination must survive peer shutdown, persist it in the store.

## Child completion

Do not invent polling loops for child completion if inbox/signals already answer it.

Prefer:
- `reef_inbox({ direction: "up" })` for child `done` / `blocked` / `failed`
- `reef_inbox_wait({ direction: "up" })` when you need to block briefly for the next child signal inside the current turn
- store waits only when the protocol actually depends on shared state

## Which wait to use

- `reef_inbox` — read what is already waiting for you now
- `reef_inbox_wait` — wait briefly for message arrival inside the current turn
- `reef_store_wait` — wait for shared state conditions, barriers, or rendezvous
- `reef_schedule_check` — durable follow-up when attention must survive after the current turn ends
