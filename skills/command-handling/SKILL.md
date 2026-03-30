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

## Urgency rule

- `abort` and `pause` are urgent
- `steer` can usually wait until the current step completes unless the parent clearly marked it urgent

## Waiting for messages

Use:
- `reef_inbox` when checking current messages
- scheduled checks when future attention should survive after the current turn

If a future `reef_inbox_wait` primitive exists, it should be used only for bounded message waits inside the current turn, not for indefinite monitoring.
