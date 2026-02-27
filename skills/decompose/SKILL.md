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
- Log what you built to the feed on your parent's reef (see Reporting Back below)

### 3. If parent node (>15 min): Decompose and delegate

Break the task into subtasks. Each subtask should be:
- **Independent** — can be done without waiting for siblings
- **Specific** — clear deliverable, clear directory, clear interfaces
- **Testable** — the child knows what "done" looks like

**Each child gets its own VM.** This is critical for recursive decomposition — children need their own reef instance to spawn grandchildren.

#### Spawning a child (step by step):

**Step 1: Restore a VM from the golden commit**
```bash
# Use the vers_vm_restore tool to create a child VM
vers_vm_restore <GOLDEN_COMMIT_ID>
# This returns a new VM ID — save it
CHILD_VM_ID="<returned vm id>"
```

**Step 2: Wait for the child VM to boot and reef to start**
```bash
# Use vers_vm_use to connect, then check reef is up
vers_vm_use $CHILD_VM_ID
# Reef should already be running from the golden snapshot
curl -s localhost:3000/health
vers_vm_local  # Switch back to your own VM
```

**Step 3: Spawn the task on the child's reef**
The child VM is accessible at `https://<CHILD_VM_ID>.vm.vers.sh`. Spawn a task on its reef server:
```bash
TASK_ID=$(curl -s -X POST "https://${CHILD_VM_ID}.vm.vers.sh/agent/tasks" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "YOUR DETAILED SUBTASK DESCRIPTION HERE"
  }' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "Spawned task $TASK_ID on VM $CHILD_VM_ID"
```

**Step 4: Poll until the child completes**
```bash
curl -s "https://${CHILD_VM_ID}.vm.vers.sh/agent/tasks/${TASK_ID}" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" | python3 -c "
import sys,json
r = json.load(sys.stdin)
print(f\"{r['id']}: {r['status']}\")
"
```

**Step 5: Collect results**
Once the child is done, copy its work back to your VM:
```bash
vers_vm_copy vm:${CHILD_VM_ID}:/root/workspace/<child-dir>/ /root/workspace/<child-dir>/
```

#### Spawning multiple children
Spawn all children first (don't wait between spawns), then poll all of them in a loop:
```bash
# Spawn all children, collect VM_ID:TASK_ID pairs
CHILDREN=()  # array of "VM_ID:TASK_ID" strings

# ... spawn each child as above, append to CHILDREN ...

# Poll until all done
while true; do
  ALL_DONE=true
  for child in "${CHILDREN[@]}"; do
    VM_ID="${child%%:*}"
    TASK_ID="${child##*:}"
    STATUS=$(curl -s "https://${VM_ID}.vm.vers.sh/agent/tasks/${TASK_ID}" \
      -H "Authorization: Bearer $VERS_AUTH_TOKEN" | python3 -c "
import sys,json; print(json.load(sys.stdin)['status'])")
    if [ "$STATUS" != "done" ] && [ "$STATUS" != "error" ]; then
      ALL_DONE=false
    fi
    echo "$TASK_ID on $VM_ID: $STATUS"
  done
  if $ALL_DONE; then break; fi
  sleep 30
done
```

### 4. Integrate
Once all children finish:
- Copy each child's work to your VM using `vers_vm_copy`
- Wire modules together — imports, shared types, configuration
- Run the full test suite across children's work
- Fix integration issues
- Log the integration result to the feed
- Optionally delete child VMs with `vers_vm_delete` to free resources

## Reporting Back

If you were spawned by a parent, your parent will poll your reef's task status and then copy your files. Make sure:
- All your work is in the directory specified in your task
- Tests pass
- You log completion to your local reef's feed:
```bash
curl -X POST localhost:3000/feed/events \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"task.complete","agent":"'$(cat /etc/vm_id)'","data":{"summary":"what you built","files":["list","of","files"]}}'
```

## Identity

Your VM ID is at `/etc/vm_id`. Read it to know who you are:
```bash
MY_VM_ID=$(cat /etc/vm_id)
```

Use this when logging to the feed, tracking parent-child relationships, or any coordination that needs agent identity.

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

When spawning a child, give it everything it needs. **Include the golden commit ID** so the child can spawn grandchildren:

```
You are a subtask agent in a recursive decomposition tree.

GOLDEN VM COMMIT: <commit-id>
Use vers_vm_restore to branch from this commit if you need to decompose further.

TASK: [specific deliverable]
DIRECTORY: [where to write code — all work goes in /root/workspace/<subdir>]
INTERFACES: [what your module must expose]
DEPENDENCIES: [what sibling modules exist, what they expose]
DONE WHEN: [concrete acceptance criteria]

You have access to reef tools (reef_manifest, reef_deploy) and vers VM tools.
You are running on your own reef server at localhost:3000 with auth token in $VERS_AUTH_TOKEN.

If this task is too large for ~15 minutes of work, decompose it further:
1. vers_vm_restore the golden commit to create child VMs
2. Spawn tasks on each child's reef (https://<child-vm-id>.vm.vers.sh/agent/tasks)
3. Poll until done, copy results back, integrate

Read skills/decompose/SKILL.md for the full protocol.

If it's small enough, do it directly: write code, write tests, make them pass.
```

## Error Handling

- If a child fails, read its output (`GET /agent/tasks/:id` on the child's reef), understand why, and either retry with a better prompt or do the work yourself
- If a child VM is unresponsive, check `vers_vms` and try `vers_vm_state` to resume it
- If you need something a sibling is building, define the interface in `shared/` and code against it — the integration parent will wire it up
- If reef is down or a tool is broken, fall back to direct file writes and bash via `vers_vm_use`
