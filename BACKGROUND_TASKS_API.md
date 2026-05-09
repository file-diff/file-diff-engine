# Background Tasks API

This document describes the HTTP API for listing, inspecting, canceling, and
soft-deleting locally managed background agent tasks.

The API covers Codex, opencode, and Claude tasks stored in the
`agent_task_jobs` table. These are the tasks created by:

- `POST /api/jobs/create-task`
- `POST /api/jobs/create-review`

Use this API from the frontend to see which tasks are queued or running, inspect
task progress and logs, identify stuck work, and request that harmful or stuck
tasks stop.

## Authentication

All examples assume:

```http
Authorization: Bearer <token>
```

Access requirements differ by endpoint:

| Endpoint family | Required token |
| --- | --- |
| `GET /api/jobs/create-task/:id` | `VIEWER_BEARER_TOKEN`; `ADMIN_BEARER_TOKEN` is also accepted |
| `GET /api/jobs/create-task/pending` | `VIEWER_BEARER_TOKEN`; `ADMIN_BEARER_TOKEN` is also accepted |
| `GET /api/agents/...` | `ADMIN_BEARER_TOKEN` |
| `POST /api/jobs/create-task/:id/cancel` | `ADMIN_BEARER_TOKEN` |
| `DELETE /api/jobs/create-task/:id` | `ADMIN_BEARER_TOKEN` |
| `DELETE /api/agents/...` | `ADMIN_BEARER_TOKEN` |

The frontend management screen should use an admin token if it needs to list all
active tasks or stop tasks.

## Task Status Model

`status` is the local job lifecycle:

| Status | Meaning |
| --- | --- |
| `waiting` | The task is queued or delayed and has not started running yet. |
| `active` | A worker has picked up the task. The agent process may be preparing, running, or shutting down. |
| `completed` | The task finished successfully. |
| `failed` | The task failed. See `error`, `output`, `stdout`, and `stderr`. |
| `canceled` | Cancellation was requested and the task has been marked canceled. |

`taskStatus` is a more specific phase when known. Current values are free-form
strings and may include values such as:

- `preparing`
- `working`
- `canceling`
- `completed`

Frontend code should treat unknown `taskStatus` values as display text, not as a
closed enum.

## Cancellation Semantics

Cancellation is asynchronous for running tasks.

For waiting tasks, the API removes the pending BullMQ job when possible and
marks the database row as `canceled`.

For active tasks, the API records `cancelRequestedAt` and changes `taskStatus`
to `canceling`. The worker polls for cancellation and then terminates the agent
process tree. The worker first sends a graceful termination signal, then sends a
forceful kill signal if the process does not exit within its grace period.

Deletion is a soft delete. It sets `deletedAt` and leaves the row, logs, output,
and session metadata in the database. Deleted tasks are omitted from active task
list endpoints.

## Response Object

Task read/list endpoints return this object, or an array of this object:

```ts
interface BackgroundTask {
  id: string;
  repo: string;
  status: "waiting" | "active" | "completed" | "failed" | "canceled";
  branch: string | null;
  taskRunner?: "codex" | "opencode" | "claude";
  baseRef?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  reasoningSummary?: "none" | "auto" | "concise" | "detailed";
  verbosity?: "low" | "medium" | "high";
  codexWebSearch?: boolean;
  pullRequestCompletionMode?: "None" | "AutoReady" | "AutoMerge";
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  taskId?: string;
  taskStatus?: string;
  opencodeSessionId?: string;
  opencodeSessionExport?: unknown;
  codexSessionId?: string;
  codexSessionFilePath?: string;
  codexSessionExport?: unknown;
  taskDelayMs: number;
  scheduledAt: string | null;
  cancelRequestedAt: string | null;
  deletedAt: string | null;
  error?: string;
  output?: string;
  stdout?: string;
  stderr?: string;
  createdAt: string;
  updatedAt: string;
}
```

Example:

```json
{
  "id": "7eb718f7-5c92-42d4-a6f8-1caaedfb29dc",
  "repo": "file-diff/file-diff-engine",
  "status": "active",
  "branch": "fd-agent/list-and-kill-background-tasks-api",
  "taskRunner": "codex",
  "baseRef": "main",
  "model": "gpt-5.2-codex",
  "taskStatus": "working",
  "pullRequestUrl": "https://github.com/file-diff/file-diff-engine/pull/158",
  "pullRequestNumber": 158,
  "taskDelayMs": 0,
  "scheduledAt": null,
  "cancelRequestedAt": null,
  "deletedAt": null,
  "createdAt": "2026-05-09T10:00:00.000Z",
  "updatedAt": "2026-05-09T10:15:00.000Z"
}
```

## List Active Tasks Across Repositories

```http
GET /api/agents/tasks
```

Lists all active background tasks across all repositories. Active means
`status` is `waiting` or `active` and `deletedAt` is not set.

Requires `ADMIN_BEARER_TOKEN`.

### Success

Status: `200 OK`

```json
[
  {
    "id": "7eb718f7-5c92-42d4-a6f8-1caaedfb29dc",
    "repo": "file-diff/file-diff-engine",
    "status": "active",
    "branch": "fd-agent/list-and-kill-background-tasks-api",
    "taskRunner": "codex",
    "baseRef": "main",
    "model": "gpt-5.2-codex",
    "taskStatus": "working",
    "taskDelayMs": 0,
    "scheduledAt": null,
    "cancelRequestedAt": null,
    "deletedAt": null,
    "createdAt": "2026-05-09T10:00:00.000Z",
    "updatedAt": "2026-05-09T10:15:00.000Z"
  }
]
```

### Example

```bash
curl https://your-host.example.com/api/agents/tasks \
  -H "Authorization: Bearer <admin-token>"
```

## List Active Tasks For A Repository

```http
GET /api/agents/repos/:owner/:repo/tasks
```

Lists active background tasks for one repository. Active means `status` is
`waiting` or `active` and `deletedAt` is not set.

Requires `ADMIN_BEARER_TOKEN`.

### Path Parameters

| Parameter | Description |
| --- | --- |
| `owner` | Repository owner or organization. |
| `repo` | Repository name. |

### Success

Status: `200 OK`

Returns an array of `BackgroundTask` objects.

### Errors

| Status | Body | Cause |
| --- | --- | --- |
| `400 Bad Request` | `{ "error": "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react')." }` | The repository path is invalid. |
| `401 Unauthorized` | Fastify auth error body | The bearer token is missing or invalid. |
| `500 Internal Server Error` | `{ "error": "<message>" }` | Unexpected server failure. |

### Example

```bash
curl https://your-host.example.com/api/agents/repos/file-diff/file-diff-engine/tasks \
  -H "Authorization: Bearer <admin-token>"
```

## Get A Repository-Scoped Task

```http
GET /api/agents/repos/:owner/:repo/tasks/:task_id
```

Returns one background task in a repository.

`:task_id` is usually the local task job id returned by
`POST /api/jobs/create-task` or `POST /api/jobs/create-review`. For Codex tasks,
it may also be the captured Codex `session id`.

Requires `ADMIN_BEARER_TOKEN`.

### Success

Status: `200 OK`

Returns one `BackgroundTask` object.

### Errors

| Status | Body | Cause |
| --- | --- | --- |
| `400 Bad Request` | `{ "error": "Task id is required." }` | `:task_id` is empty. |
| `400 Bad Request` | `{ "error": "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react')." }` | The repository path is invalid. |
| `401 Unauthorized` | Fastify auth error body | The bearer token is missing or invalid. |
| `404 Not Found` | `{ "error": "Agent task job '<id>' was not found in repository '<owner>/<repo>'." }` | No matching task exists in the repository. |
| `500 Internal Server Error` | `{ "error": "<message>" }` | Unexpected server failure. |

### Example

```bash
curl https://your-host.example.com/api/agents/repos/file-diff/file-diff-engine/tasks/7eb718f7-5c92-42d4-a6f8-1caaedfb29dc \
  -H "Authorization: Bearer <admin-token>"
```

## List Pending Tasks

```http
GET /api/jobs/create-task/pending
```

Lists task rows that are still `waiting`, are not deleted, and have not yet been
attached to an agent task/session id. Use this when the frontend specifically
wants to show work that is queued but has not started.

Requires `VIEWER_BEARER_TOKEN`; `ADMIN_BEARER_TOKEN` is also accepted.

### Success

Status: `200 OK`

Returns an array of `BackgroundTask` objects.

### Example

```bash
curl https://your-host.example.com/api/jobs/create-task/pending \
  -H "Authorization: Bearer <viewer-or-admin-token>"
```

## Get A Task By Local Job Id

```http
GET /api/jobs/create-task/:id
```

Returns the full local task record for one background task, including captured
output, split stdout/stderr, error text, and Codex/opencode session metadata
when available.

Requires `VIEWER_BEARER_TOKEN`; `ADMIN_BEARER_TOKEN` is also accepted.

### Success

Status: `200 OK`

Returns one `BackgroundTask` object.

### Errors

| Status | Body | Cause |
| --- | --- | --- |
| `401 Unauthorized` | Fastify auth error body | The bearer token is missing or invalid. |
| `404 Not Found` | `{ "error": "Task job not found." }` | The task id is unknown. |

### Example

```bash
curl https://your-host.example.com/api/jobs/create-task/7eb718f7-5c92-42d4-a6f8-1caaedfb29dc \
  -H "Authorization: Bearer <viewer-or-admin-token>"
```

## Cancel A Task

```http
POST /api/jobs/create-task/:id/cancel
```

Requests cancellation without hiding the task row.

Use this when the frontend user wants to stop a task but still see its terminal
state and logs in normal task detail views.

Requires `ADMIN_BEARER_TOKEN`.

### Behavior

- If the task is `waiting`, the queued BullMQ job is removed when possible and
  the task is marked `canceled`.
- If the task is `active`, `cancelRequestedAt` is set and `taskStatus` becomes
  `canceling`. The worker then terminates the running agent process tree on its
  next cancellation poll.
- If the task is already `canceled`, the endpoint returns the existing task.
- If the task is `completed` or `failed`, the endpoint returns `409 Conflict`.

### Success

Status: `200 OK`

Returns the updated `BackgroundTask` object.

### Errors

| Status | Body | Cause |
| --- | --- | --- |
| `401 Unauthorized` | Fastify auth error body | The bearer token is missing or invalid. |
| `404 Not Found` | `{ "error": "Task job not found." }` | The task id is unknown. |
| `409 Conflict` | `{ "error": "Task job has already finished and cannot be canceled." }` | The task has already completed or failed. |

### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/create-task/7eb718f7-5c92-42d4-a6f8-1caaedfb29dc/cancel \
  -H "Authorization: Bearer <admin-token>"
```

## Soft-Delete A Task

```http
DELETE /api/jobs/create-task/:id
```

Soft-deletes a background task. If it is still waiting or active, cancellation is
requested before `deletedAt` is set.

Use this when the frontend user wants to remove a task from active management
lists. The database row is retained.

Requires `ADMIN_BEARER_TOKEN`.

### Success

Status: `200 OK`

Returns the updated `BackgroundTask` object with `deletedAt` set.

### Errors

| Status | Body | Cause |
| --- | --- | --- |
| `401 Unauthorized` | Fastify auth error body | The bearer token is missing or invalid. |
| `404 Not Found` | `{ "error": "Task job not found." }` | The task id is unknown. |

### Example

```bash
curl -X DELETE https://your-host.example.com/api/jobs/create-task/7eb718f7-5c92-42d4-a6f8-1caaedfb29dc \
  -H "Authorization: Bearer <admin-token>"
```

## Soft-Delete A Repository-Scoped Task

```http
DELETE /api/agents/repos/:owner/:repo/tasks/:task_id
```

Soft-deletes a background task after validating that it belongs to the requested
repository. If it is still waiting or active, cancellation is requested before
`deletedAt` is set.

This endpoint is useful for frontend screens that already operate within a
specific repository route.

Requires `ADMIN_BEARER_TOKEN`.

### Success

Status: `200 OK`

Returns the updated `BackgroundTask` object with `deletedAt` set.

### Errors

| Status | Body | Cause |
| --- | --- | --- |
| `400 Bad Request` | `{ "error": "Task id is required." }` | `:task_id` is empty. |
| `400 Bad Request` | `{ "error": "Invalid repo format. Expected 'owner/repo' (e.g. 'facebook/react')." }` | The repository path is invalid. |
| `401 Unauthorized` | Fastify auth error body | The bearer token is missing or invalid. |
| `404 Not Found` | `{ "error": "Agent task job '<id>' was not found in repository '<owner>/<repo>'." }` | No matching task exists in the repository. |
| `500 Internal Server Error` | `{ "error": "<message>" }` | Unexpected server failure. |

### Example

```bash
curl -X DELETE https://your-host.example.com/api/agents/repos/file-diff/file-diff-engine/tasks/7eb718f7-5c92-42d4-a6f8-1caaedfb29dc \
  -H "Authorization: Bearer <admin-token>"
```

## Frontend Usage

### List And Render Active Tasks

```ts
async function listBackgroundTasks(adminToken: string): Promise<BackgroundTask[]> {
  const response = await fetch("/api/agents/tasks", {
    headers: {
      Authorization: `Bearer ${adminToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to list background tasks: ${response.status}`);
  }

  return response.json();
}
```

Recommended columns:

| Column | Source field |
| --- | --- |
| Repository | `repo` |
| Runner | `taskRunner` |
| Status | `status` and `taskStatus` |
| Branch | `branch` |
| Pull request | `pullRequestUrl` or `pullRequestNumber` |
| Last update | `updatedAt` |
| Cancel requested | `cancelRequestedAt` |

### Stop A Task

```ts
async function cancelBackgroundTask(
  taskId: string,
  adminToken: string
): Promise<BackgroundTask> {
  const response = await fetch(`/api/jobs/create-task/${taskId}/cancel`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
    },
  });

  if (response.status === 409) {
    throw new Error("Task already finished and cannot be canceled.");
  }

  if (!response.ok) {
    throw new Error(`Failed to cancel background task: ${response.status}`);
  }

  return response.json();
}
```

### Remove A Task From Active Lists

```ts
async function deleteBackgroundTask(
  taskId: string,
  adminToken: string
): Promise<BackgroundTask> {
  const response = await fetch(`/api/jobs/create-task/${taskId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${adminToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to delete background task: ${response.status}`);
  }

  return response.json();
}
```

## Polling And Stuck Task Detection

Poll `GET /api/agents/tasks` for the active management view. A reasonable
frontend interval is 5 to 15 seconds.

Use these fields to detect suspicious tasks:

| Signal | Interpretation |
| --- | --- |
| `status === "waiting"` and `scheduledAt` is in the past | The task may be stuck in the queue. |
| `status === "active"` and `updatedAt` is old | The worker or agent may be stuck. |
| `taskStatus === "canceling"` and `cancelRequestedAt` is old | Cancellation may not have completed yet. |
| `output`, `stdout`, `stderr` stop changing | The agent may be idle or blocked. |

Do not rely only on `taskStatus`; it is a phase string. Use `status` for the
canonical lifecycle state.

After calling cancel or delete, continue polling until either:

- `status` becomes `canceled`, or
- the task disappears from active listings because `deletedAt` was set.

## Common Error Shape

Most explicit route errors use:

```json
{
  "error": "Human-readable error message."
}
```

Authentication failures may use Fastify's default auth error shape.

## Related Task Creation APIs

Create a normal agent task:

```http
POST /api/jobs/create-task
```

Create a pull request review task:

```http
POST /api/jobs/create-review
```

Those endpoints return:

```json
{
  "id": "7eb718f7-5c92-42d4-a6f8-1caaedfb29dc"
}
```

Use that `id` with the read, cancel, and delete endpoints documented above.
