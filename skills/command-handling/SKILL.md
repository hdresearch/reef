---
name: command-handling
description: Use when handling parent commands such as steer, abort, pause, or resume, or when deciding how urgently to react to inbox messages from above.
---

# Command Handling

Use this skill when your parent has sent a command and you need the response playbook.

## Where commands come from

Commands come from your parent through:
- `reef_inbox({ direction: "down" })`

They are authoritative.

## Command intent

### `steer`
- read the payload carefully
- adjust your approach
- do not throw away good work unless the steer requires it
- use this only while you are still actively working on the current task

### `abort`
- stop work
- propagate abort downward if you own children
- preserve partial work pointers if they matter
- signal final state upward

### `pause`
- stop making new LLM/tool progress that would change the task state
- hold your place
- wait for `resume` or explicit follow-up

### `resume`
- continue from the held state
- do not restart from scratch unless necessary

## Working vs idle vs stopped

Use this state model when deciding how to react to parent direction:

- **working**: you are still actively executing the current task
- **idle**: your current task is done, but you are still alive and available
- **stopped**: you are no longer a live task target

Interpret parent intent accordingly:
- if you are **working**, a parent `steer` means adjust the in-flight task
- if you are **idle**, a parent should give you a new bounded assignment rather than pretending it is still steering the old task
- if you are **stopped**, you cannot accept new work until you are restored or recreated

Typical surfaces:
- idle lieutenant -> `reef_lt_send(..., mode: "prompt")`
- idle agent VM -> `reef_agent_task(...)`
- idle swarm worker -> `reef_swarm_task(...)`

This applies to lieutenants, agent VMs, and swarm workers. Category changes the usual lifecycle, not whether an alive idle child is reusable.

## Post-task disposition

Parents may also tell you what to do after the current task completes:
- `stay_idle` -> finish the task, do final inbox catch-up, then remain alive and idle
- `stop_when_done` -> finish the task, do final inbox catch-up, then stop unless immediate context gives a concrete reason to remain alive

If parent intent is explicit, it overrides your category default. If parent intent is not explicit, fall back to your category baseline and then do one final inbox/context override check before exit.

If you were created with an explicit spawn-time disposition, treat that as your current baseline until a later task or command explicitly changes it.

## Urgency rule

- `abort` and `pause` are urgent
- `steer` can usually wait until the current step completes unless the parent clearly marked it urgent

## Waiting for messages

Use:
- `reef_inbox` when checking current messages
- `reef_inbox_wait` when you need a bounded wait for message arrival inside the current turn
- scheduled checks when future attention should survive after the current turn

Do not use `reef_inbox_wait` as indefinite monitoring. It is for bounded waits, not for lingering forever.
