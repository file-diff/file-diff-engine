# Agents Tasks API

This API scope manages background agent tasks for a specific GitHub repository.
Agent tasks run Codex, opencode, or Claude against a repo/ref, create or reuse a
working branch, and may create or update pull requests.

The canonical scope is:

```text
/api/agents
```

File indexing, file downloads, tokenization, and file diffs are intentionally not
part of this API. Use `INDEX_FILES_TASK_API.md` for those workflows.

## Create an Agent Task

```http
POST /api/agents/create-task
Authorization: Bearer <ADMIN_BEARER_TOKEN>
Content-Type: application/json
```

Creates a local agent task job and enqueues background execution.

Required body fields:

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Repository in `owner/repo` format. |
| `base_ref` | `string` | Base branch, tag, or ref used to prepare the task branch. |
| `problem_statement` | `string` | Instructions for the agent. |

Optional body fields:

| Field | Type | Description |
| --- | --- | --- |
| `task` | `"codex" \| "opencode" \| "claude"` | Agent runner. Defaults to `codex`. |
| `model` | `string` | Runner model. Defaults come from runner-specific env vars. |
| `branch` | `string` | Requested task branch name. |
| `branch_title` | `string` | Frontend-compatible branch override. Must match `branch` if both are provided. |
| `reasoning_effort` | `"low" \| "medium" \| "high" \| "xhigh"` | Codex-only reasoning effort. |
| `reasoning_summary` | `"none" \| "auto" \| "concise" \| "detailed"` | Codex-only reasoning summary. |
| `verbosity` | `"low" \| "medium" \| "high"` | Codex-only output verbosity. |
| `codex_web_search` | `boolean` | Enables Codex web search support. |
| `system_prompt` | `string` | Codex/opencode full prompt override. Empty, whitespace-only, or `"no"` keeps the default generated prompt. Any other string is sent verbatim without appending `problem_statement` or branch/PR workflow instructions. Codex uses a single one-shot run when this is provided. |
| `pull_request_completion_mode` | `"None" \| "AutoReady" \| "AutoMerge"` | Follow-up action after successful task completion. |
| `auto_ready` | `boolean` | Compatibility alias for `AutoReady`. |
| `auto_merge` | `boolean` | Compatibility alias for `AutoMerge`. |
| `task_delay_ms` | `integer` | Non-negative delay before the worker starts. |
| `githubKey` | `string` | Per-request GitHub token override. |
| `deepseek_api_key` | `string` | Per-request DeepSeek key for opencode tasks. |

Response:

```json
{
  "id": "7eb718f7-5c92-42d4-a6f8-1caaedfb29dc"
}
```

## Create a Pull Request Review Task

```http
POST /api/agents/create-review
Authorization: Bearer <ADMIN_BEARER_TOKEN>
Content-Type: application/json
```

Creates an agent task that reviews an existing pull request. This does not create
a new branch or pull request.

Required body fields:

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Repository in `owner/repo` format. |
| `pull_request_number` | `integer` | Pull request number to review. |

The `task`, `model`, Codex tuning fields, `system_prompt`, `task_delay_ms`,
`githubKey`, and `deepseek_api_key` options match
`POST /api/agents/create-task`.

The fields `branch`, `branch_title`, `create_pull_request`, `auto_ready`,
`auto_merge`, and `pull_request_completion_mode` are rejected for review tasks.

## List Pending Agent Tasks

```http
GET /api/agents/create-task/pending
Authorization: Bearer <VIEWER_BEARER_TOKEN>
```

Returns queued agent task jobs that have not started.

## Get Agent Task Status

```http
GET /api/agents/create-task/:id
Authorization: Bearer <VIEWER_BEARER_TOKEN>
```

Returns the locally tracked task status, selected runner/model, branch and pull
request metadata, captured stdout/stderr/output, session metadata, timestamps,
and cancellation/deletion timestamps when present.

## Cancel an Agent Task

```http
POST /api/agents/create-task/:id/cancel
Authorization: Bearer <ADMIN_BEARER_TOKEN>
```

Cancels a waiting or running agent task. Completed and failed tasks return a
conflict response.

## Delete an Agent Task

```http
DELETE /api/agents/create-task/:id
Authorization: Bearer <ADMIN_BEARER_TOKEN>
```

Soft-deletes a task. Waiting or running tasks are canceled first. The database
row and captured output remain stored.

## Repository-Scoped Agent Task Views

These existing agent task views remain under the same logical scope:

```http
GET /api/agents/repos/:owner/:repo/tasks
GET /api/agents/repos/:owner/:repo/tasks/:task_id
DELETE /api/agents/repos/:owner/:repo/tasks/:task_id
GET /api/agents/tasks
```

`task_id` is the local agent task job id. For Codex tasks, the captured Codex
session id can also be used where supported.
