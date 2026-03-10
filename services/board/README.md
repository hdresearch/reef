# board

Shared task tracking for agent fleets. Tasks move through a review workflow: `open` → `in_progress` → `in_review` → `done`. Agents claim tasks, add notes and artifacts, bump priority, and submit work for review.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/board/tasks` | Create a task |
| `GET` | `/board/tasks` | List tasks (filter: `?status=`, `?assignee=`, `?tag=`) |
| `GET` | `/board/tasks/:id` | Get a task |
| `PATCH` | `/board/tasks/:id` | Update a task |
| `DELETE` | `/board/tasks/:id` | Delete a task |
| `POST` | `/board/tasks/:id/bump` | Bump priority score |
| `POST` | `/board/tasks/:id/notes` | Add a note |
| `GET` | `/board/tasks/:id/notes` | List notes |
| `POST` | `/board/tasks/:id/artifacts` | Attach an artifact |
| `POST` | `/board/tasks/:id/review` | Submit for review |
| `POST` | `/board/tasks/:id/approve` | Approve (sets status to `done`) |
| `POST` | `/board/tasks/:id/reject` | Reject (sets status back to `open`) |
| `GET` | `/board/review` | List tasks awaiting review |
| `GET` | `/board/_panel` | UI panel (HTML fragment) |

## Tools

- `board_create_task` — create a task with title, description, assignee, tags
- `board_list_tasks` — list/filter tasks
- `board_update_task` — update status, assignee, title, tags
- `board_add_note` — add a finding, question, or update note

## Events

Emits to the server-side event bus:
- `board:task_created` — `{ task }`
- `board:task_updated` — `{ task, changes }`
- `board:task_deleted` — `{ taskId }`
