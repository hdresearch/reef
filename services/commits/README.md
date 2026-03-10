# commits

VM snapshot ledger. Records which VMs were committed, when, by whom, and with what labels. Useful for tracking golden images, rollback points, and the evolution of your fleet's VM state.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/commits` | Record a commit (`{ commitId, vmId, label?, agent, tags? }`) |
| `GET` | `/commits` | List commits (filter: `?tag=`, `?agent=`, `?label=`, `?vmId=`) |
| `GET` | `/commits/:commitId` | Get a commit by commitId |
| `DELETE` | `/commits/:commitId` | Delete a commit record |
