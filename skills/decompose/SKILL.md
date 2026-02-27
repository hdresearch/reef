# Recursive Task Decomposition

You are an agent in a recursive task tree. Your job is to either **do the work** or **break it down and delegate**.

## The Rule

**If a task has more than one independent subsystem, decompose it. If it's a single coherent module you can finish in ~15 minutes, do it yourself.**

A "subsystem" is something with its own types, its own tests, and a clear interface boundary. Examples:
- A SQL parser is one subsystem (lexer + AST + parser + tests — they're tightly coupled, one agent should do it)
- A query planner is a separate subsystem from the parser
- An auth module is a separate subsystem from a job scheduler

**Target depth of 3-4 levels.** The root should NOT directly spawn leaf workers. The root decomposes into major areas, those decompose into subsystems, those decompose into modules if needed.

Example tree structure:
```
Root: "Build DataForge"
├── "Rust Data Engine"                    ← Level 1: spawns own VM
│   ├── "SQL Parser (lexer + AST + parser + tests)"    ← Level 2: leaf, does the work
│   ├── "Query Planner (logical + physical + optimizer)" ← Level 2: leaf
│   ├── "Execution Engine (operators + eval)"            ← Level 2: leaf
│   ├── "Storage Layer (parquet + delta + catalog)"      ← Level 2: leaf
│   └── "Arrow Flight Server"                            ← Level 2: leaf
├── "Elixir Control Plane"               ← Level 1: spawns own VM
│   ├── "Auth + Tenant isolation"                        ← Level 2: leaf
│   ├── "Job Orchestrator"                               ← Level 2: leaf
│   ├── "Cluster Manager"                                ← Level 2: leaf
│   ├── "Notebook Sessions"                              ← Level 2: leaf
│   └── "Phoenix API Gateway + Router"                   ← Level 2: leaf
├── "Shared Protos + CLI"                ← Level 1: could be leaf or decompose
└── "Integration Tests + Docker"         ← Level 1: runs after others finish
```

**Do NOT put everything in 3 fat children like last time.** The Elixir control plane child should NOT write all of auth, jobs, cluster, notebooks, and API itself — it should spawn 5 children.

## Each Child Gets Its Own VM

Every child task runs on a fresh VM restored from the golden commit. This enables recursive decomposition — your children can spawn their own children.

### Spawning a child:

**Step 1: Create a child VM**
Use the `vers_vm_restore` tool with the GOLDEN_COMMIT_ID from your task prompt. Save the returned VM ID.

**Step 2: Spawn the task on the child's reef**
The child VM already has reef running from the golden snapshot:
```bash
TASK_ID=$(curl -s -X POST "https://${CHILD_VM_ID}.vm.vers.sh:3000/agent/tasks" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "YOUR DETAILED SUBTASK DESCRIPTION"
  }' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "Spawned task $TASK_ID on VM $CHILD_VM_ID"
```

**Step 3: Repeat for all children** (spawn them all before waiting)

**Step 4: Poll until all children complete**
```bash
while true; do
  ALL_DONE=true
  for child in "${CHILDREN[@]}"; do
    VM_ID="${child%%:*}"
    TASK_ID="${child##*:}"
    STATUS=$(curl -s "https://${VM_ID}.vm.vers.sh:3000/agent/tasks/${TASK_ID}" \
      -H "Authorization: Bearer $VERS_AUTH_TOKEN" | python3 -c "
import sys,json; print(json.load(sys.stdin)['status'])")
    echo "$TASK_ID on $VM_ID: $STATUS"
    if [ "$STATUS" != "done" ] && [ "$STATUS" != "error" ]; then
      ALL_DONE=false
    fi
  done
  if $ALL_DONE; then break; fi
  sleep 30
done
```

**Step 5: Collect results** — `vers_vm_copy vm:${CHILD_VM_ID}:/root/workspace/<dir>/ /root/workspace/<dir>/`

**Step 6: Clean up** — `vers_vm_delete $CHILD_VM_ID`

## Identity

Your VM ID is at `/etc/vm_id`:
```bash
MY_VM_ID=$(cat /etc/vm_id)
```

## Subtask Prompt Template

Every child MUST receive the golden commit ID so it can decompose further:

```
You are a subtask agent in a recursive decomposition tree.

GOLDEN VM COMMIT: <commit-id>
Use vers_vm_restore to create child VMs if you need to decompose further.

PARENT VM: <your-vm-id>
TASK: [specific deliverable]
DIRECTORY: /root/workspace/<path> — put ALL your work here
INTERFACES: [what your module must expose]
DEPENDENCIES: [what sibling modules will provide]
DONE WHEN: [concrete acceptance criteria]

If this task has multiple independent subsystems, decompose further by spawning child VMs. Read skills/decompose/SKILL.md.

If it's a single coherent module (~15 min of work), do it yourself: write code, write tests, make them pass.
```

## Leaf Node Work

When you're a leaf (single coherent module):
- Write the code in your assigned directory
- Write tests, make them pass
- Log to feed:
```bash
curl -X POST localhost:3000/feed/events \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"task.complete","agent":"'$(cat /etc/vm_id)'","data":{"summary":"what you built","files":["list","of","files"]}}'
```

## Integration (Parent Nodes)

After all children complete:
1. Copy each child's work via `vers_vm_copy`
2. Wire modules together — imports, shared types, build configs
3. Run the full test suite
4. Fix integration issues
5. Delete child VMs

## Building Your Own Tools

If you need coordination primitives, build them as reef services using `reef_deploy`. Read `skills/create-service/SKILL.md`.

## Error Handling

- If a child fails, read its output and retry or do the work yourself
- If a child VM is unresponsive, check with `vers_vms` and `vers_vm_state`
- Fall back to `vers_vm_use` + direct bash if reef is down
