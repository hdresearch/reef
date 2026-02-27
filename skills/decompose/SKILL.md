# Recursive Task Decomposition

You are an agent in a recursive task tree. Your job is to either **do the work** or **break it down and delegate**.

## The Rule

**If a task would take you more than ~15 minutes of focused work, decompose it. Otherwise, do it yourself.**

15 minutes means: write the code, write the tests, make them pass. If you're unsure, decompose.

## The Pattern

### 1. Assess
Read the task. Think about what's involved. Estimate scope.

### 2. If leaf node (≤15 min): Do the work
- Write the code in your assigned directory
- Write tests
- Make them pass
- Log what you built: `curl -X POST localhost:3000/feed/events -H "Authorization: Bearer $VERS_AUTH_TOKEN" -H "Content-Type: application/json" -d '{"type":"task.complete","agent":"<your-task-id>","data":{"summary":"what you built","files":["list","of","files"]}}'`

### 3. If parent node (>15 min): Decompose and delegate
Break the task into subtasks. Each subtask should be:
- **Independent** — can be done without waiting for siblings
- **Specific** — clear deliverable, clear directory, clear interfaces
- **Testable** — the child knows what "done" looks like

Spawn children:
```bash
TASK_ID=$(curl -s -X POST localhost:3000/agent/tasks \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "YOUR DETAILED SUBTASK DESCRIPTION HERE"
  }' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "Spawned: $TASK_ID"
```

Poll until all children complete:
```bash
curl -s localhost:3000/agent/tasks/$TASK_ID \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" | python3 -c "
import sys,json
r = json.load(sys.stdin)
print(f\"{r['id']}: {r['status']}\")
"
```

### 4. Integrate
Once all children finish:
- Read what they built (check their output, read their files)
- Wire modules together — imports, shared types, configuration
- Run the full test suite across children's work
- Fix integration issues
- Log the integration result to the feed

## Building Your Own Tools

You are running inside a reef server. If you need coordination primitives that don't exist yet — **build them as reef services**.

Use `reef_manifest` to see what's available. Use `reef_deploy` to ship new services.

Examples of tools you might need:
- A task tree tracker (parent-child relationships, status rollup)
- A workspace allocator (which agent owns which directories)
- A dependency graph (which subtasks block others)
- A shared type registry (interfaces that cross module boundaries)

Don't ask permission. If you need a tool to do your job, build it, deploy it, and use it. Your children will inherit it.

Read the `create-service` skill at `skills/create-service/SKILL.md` for the service module conventions.

## Identity

Your VM ID is at `/etc/vm_id`. Read it to know who you are:
```bash
MY_VM_ID=$(cat /etc/vm_id)
```

Use this when logging to the feed, tracking parent-child relationships, or any coordination that needs agent identity.

## Workspace Convention

Each subtask should specify a directory for the child to work in. Use the project's natural module structure:
```
workspace/
├── engine/          # Rust data engine
│   ├── src/
│   └── Cargo.toml
├── control/         # Elixir control plane
│   ├── lib/
│   └── mix.exs
└── shared/          # Shared types, proto definitions, specs
```

Children own their directory. Parents own integration across directories.

## Subtask Prompt Template

When spawning a child, give it everything it needs:

```
You are a subtask agent in a recursive decomposition tree.

TASK: [specific deliverable]
DIRECTORY: [where to write code]  
INTERFACES: [what your module must expose]
DEPENDENCIES: [what sibling modules exist, what they expose]
DONE WHEN: [concrete acceptance criteria]

You have access to reef tools (reef_manifest, reef_deploy) and vers VM tools.
You are running on a reef server at localhost:3000 with auth token in $VERS_AUTH_TOKEN.

If this task is too large for ~15 minutes of work, decompose it further using the same pattern. Read skills/decompose/SKILL.md for the protocol.

If it's small enough, do it directly: write code, write tests, make them pass.
```

## Error Handling

- If a child fails, read its output, understand why, and either retry with a better prompt or do the work yourself
- If you need something a sibling is building, define the interface in `shared/` and code against it — the integration parent will wire it up
- If reef is down or a tool is broken, fall back to direct file writes and bash


