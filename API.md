# File Diff Engine API

This document describes the HTTP endpoints exposed by the file-diff-engine service, including request arguments, response fields, and example usage.

## Base URL

All endpoints below are relative to your deployed API base URL, for example:

```text
https://your-host.example.com
```

Most routes are served under the `/api` prefix.

## Common notes

- Request and response bodies use JSON unless noted otherwise.
- Repository names use the `owner/repo` format, for example `facebook/react`.
- Commit hashes are full 40-character hexadecimal Git SHAs unless noted otherwise.
- Download responses return binary file content instead of JSON.
- Viewer endpoints require `Authorization: Bearer <token>` with `VIEWER_BEARER_TOKEN`. Admin endpoints require `ADMIN_BEARER_TOKEN`. The current endpoint-to-token mapping is documented in `SECURITY.md`.
- Set `REQUEST_DELAY_MS` to add a fixed delay before every endpoint response. The default is `0` (no delay); for example, `REQUEST_DELAY_MS=500` simulates 500ms latency in development.

## Response field reference

### Job status values

`status` can be one of:

- `waiting`
- `active`
- `completed`
- `failed`

### File type values

The `t` field in file results can be one of:

- `d` - directory
- `t` - text file
- `b` - binary file
- `x` - executable
- `s` - symlink

## Endpoints

### `GET /api/health`

Checks whether the API is running and includes GitHub API rate-limit status for the backend.

#### Request arguments

None.

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `status` | `"ok"` | Health status value |
| `message` | `string` | Human-readable health message |
| `github.configured` | `boolean` | Whether `PRIVATE_GITHUB_TOKEN` is configured |
| `github.status` | `"ok" \| "error"` | Whether the GitHub rate-limit lookup succeeded |
| `github.rateLimit` | `object` | Present when GitHub rate-limit data was fetched successfully |
| `github.error` | `string` | Present when the GitHub rate-limit lookup failed |

#### Example

```bash
curl -X GET https://your-host.example.com/api/health
```

Example response:

```json
{
  "status": "ok",
  "message": "API is healthy",
  "github": {
    "configured": true,
    "status": "ok",
    "rateLimit": {
      "limit": 5000,
      "remaining": 4999,
      "reset": 1712345679,
      "used": 1,
      "resource": "core"
    }
  }
}
```

---

### `GET /api/version`

Returns the configured build version of the running service.

#### Request arguments

None.

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `version` | `string` | Build version string, or `dev` when not set |

#### Example

```bash
curl -X GET https://your-host.example.com/api/version
```

Example response:

```json
{
  "version": "2026.03.10+abc1234"
}
```

---

### `GET /api/stats`

Returns aggregate storage statistics using only data stored in the database.

#### Request arguments

None.

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `jobsStored` | `number` | Number of jobs stored in the database |
| `filesStored` | `number` | Number of file records stored in the database |
| `sizeStored` | `number` | Sum of all stored file sizes in bytes from the database |

#### Example

```bash
curl -X GET https://your-host.example.com/api/stats
```

Example response:

```json
{
  "jobsStored": 42,
  "filesStored": 1024,
  "sizeStored": 9876543
}
```

---

### `GET /api/codex/stats`

Returns Codex CLI usage statistics for the host the API runs on. The endpoint shells out to `npx @ccusage/codex` and returns the command's stdout verbatim as `text/plain`.

#### Request arguments

None.

#### Success response

Status: `200 OK`

Response body:

- Plain-text usage report produced by `@ccusage/codex` (`Content-Type: text/plain; charset=utf-8`).

#### Common statuses

- `429 Too Many Requests` when the per-IP rate limit (30 requests per minute) is exceeded
- `500 Internal Server Error` when `npx @ccusage/codex` fails to run or exceeds the 30 second execution timeout

#### Example

```bash
curl -X GET https://your-host.example.com/api/codex/stats
```

---

### `GET /api/claude/stats`

Returns Claude CLI usage statistics for the host the API runs on. The endpoint shells out to `npx ccusage` and returns the command's stdout verbatim as `text/plain`.

#### Request arguments

None.

#### Success response

Status: `200 OK`

Response body:

- Plain-text usage report produced by `ccusage` (`Content-Type: text/plain; charset=utf-8`).

#### Common statuses

- `429 Too Many Requests` when the per-IP rate limit (30 requests per minute) is exceeded
- `500 Internal Server Error` when `npx ccusage` fails to run or exceeds the 30 second execution timeout

#### Example

```bash
curl -X GET https://your-host.example.com/api/claude/stats
```

---

### `POST /api/shorten-prompt`

Generates a concise lowercase hyphenated title from a long prompt using DeepSeek `deepseek-v4-flash`.

This endpoint always returns `200 OK`. If DeepSeek is not configured, unavailable, or returns a title that is not two to ten lowercase words separated by hyphens, the response title is `failed-to-generate-prompt-title`.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `prompt` | `string` | Yes | Long prompt text to shorten into a title |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `title` | `string` | Generated title, or `failed-to-generate-prompt-title` fallback |
| `inputTokens` | `number` | Prompt tokens reported by DeepSeek for the request, or `0` when generation was skipped |
| `outputTokens` | `number` | Completion tokens reported by DeepSeek for the response, or `0` when generation was skipped |
| `durationMs` | `number` | Total wall-clock time spent generating the title, in milliseconds |

#### Example

```bash
curl -X POST https://your-host.example.com/api/shorten-prompt \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Create a new endpoint that turns a long user prompt into a short concise title"
  }'
```

Example response:

```json
{
  "title": "shorten-prompt-title",
  "inputTokens": 42,
  "outputTokens": 7,
  "durationMs": 318
}
```

---

### `POST /api/jobs/resolve`

Resolves a branch, tag, or other Git ref to a full commit SHA for a repository.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |
| `ref` | `string` | Yes | Git ref to resolve, such as `main`, `v1.0.0`, or a full commit SHA. |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Normalized repository name |
| `ref` | `string` | Trimmed ref value that was resolved |
| `commit` | `string` | Full 40-character commit SHA |
| `commitShort` | `string` | Short commit SHA, first 7 characters |

#### Error response

Example fields for errors:

| Field | Type | Description |
| --- | --- | --- |
| `error` | `string` | Error message |

Common statuses:

- `400 Bad Request` when `repo` or `ref` is missing or invalid
- `404 Not Found` when the ref cannot be resolved
- `500 Internal Server Error` for unexpected failures

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/resolve \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react",
    "ref": "main"
  }'
```

Example response:

```json
{
  "repo": "facebook/react",
  "ref": "main",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "commitShort": "0123456"
}
```

---

### `POST /api/jobs/revert-to-commit`

Creates a new branch from a base branch, rewrites the branch tree to match a past commit, pushes that branch, and optionally creates a pull request when `githubKey` is provided.

This endpoint requires the server to be configured with `ADMIN_BEARER_TOKEN` and the client to send `Authorization: Bearer <token>`.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |
| `commit` | `string` | Yes | Full 40-character commit SHA whose tree should be restored. |
| `branch` | `string` | No | Base branch to fork from before restoring the tree. Defaults to `main`. |
| `githubKey` | `string` | No | Optional GitHub token. When provided, the service also creates a pull request from the generated branch back into `branch`. |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Normalized repository name |
| `branch` | `string` | Base branch used for the new branch |
| `commit` | `string` | Full source commit SHA |
| `commitShort` | `string` | Short source commit SHA |
| `revertBranch` | `string` | Generated branch name pushed to the remote |
| `revertCommit` | `string` | Commit created on the generated branch |
| `revertCommitShort` | `string` | Short generated commit SHA |
| `pullRequest` | `object \| null` | Pull request metadata when one was created |
| `log` | `array<object>` | Ordered user-facing log of the git and GitHub operations performed |

#### Common statuses

- `400 Bad Request` when `repo` or `commit` is missing or invalid
- `401 Unauthorized` when the bearer token is missing or invalid
- `503 Service Unavailable` when the revert-to-commit bearer token is not configured
- `500 Internal Server Error` for git or GitHub failures

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/revert-to-commit \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react",
    "commit": "0123456789abcdef0123456789abcdef01234567",
    "branch": "main"
  }'
```

---

### `POST /api/jobs/merge-branch`

Creates a deterministic branch from a base branch, merges another branch into it, pushes that branch, and optionally creates a pull request when `githubKey` is provided. If the merge branch already exists, the other branch is merged into it instead of creating a new one.

This endpoint requires the server to be configured with `ADMIN_BEARER_TOKEN` and the client to send `Authorization: Bearer <token>`.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |
| `baseBranch` | `string` | No | Base branch to create the merge branch from. Defaults to `main`. |
| `otherBranch` | `string` | Yes | Branch whose changes are merged in. |
| `githubKey` | `string` | No | Optional GitHub token. When provided, the service also creates a pull request from the merge branch back into `baseBranch`. |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Normalized repository name |
| `baseBranch` | `string` | Base branch used |
| `otherBranch` | `string` | Branch that was merged in |
| `mergeBranch` | `string` | Deterministic merge branch name pushed to the remote |
| `mergeCommit` | `string` | Commit SHA after the merge |
| `mergeCommitShort` | `string` | Short merge commit SHA |
| `created` | `boolean` | Whether the merge branch was newly created (`true`) or already existed (`false`) |
| `pullRequest` | `object \| null` | Pull request metadata when one was created |
| `log` | `array<object>` | Ordered user-facing log of the git and GitHub operations performed |

#### Common statuses

- `400 Bad Request` when `repo` or `otherBranch` is missing or invalid
- `401 Unauthorized` when the bearer token is missing or invalid
- `503 Service Unavailable` when the merge-branch bearer token is not configured
- `500 Internal Server Error` for git or GitHub failures

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/merge-branch \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react",
    "baseBranch": "main",
    "otherBranch": "feature-branch"
  }'
```

---

### `POST /api/jobs/delete-remote-branch`

Deletes a remote branch from a GitHub repository.

This endpoint requires the server to be configured with `ADMIN_BEARER_TOKEN` and the client to send `Authorization: Bearer <token>`.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |
| `branch` | `string` | Yes | Branch name to delete from the remote. |
| `githubKey` | `string` | No | Optional GitHub token. Defaults to `PRIVATE_GITHUB_TOKEN`. |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Normalized repository name |
| `branch` | `string` | Deleted branch name |

#### Common statuses

- `400 Bad Request` when `repo` or `branch` is missing or invalid
- `401 Unauthorized` when the bearer token is missing or invalid
- `404 Not Found` when the branch does not exist
- `503 Service Unavailable` when the bearer token is not configured
- `500 Internal Server Error` for GitHub API failures

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/delete-remote-branch \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react",
    "branch": "feature-branch"
  }'
```

---

### `POST /api/jobs/branch-permissions`

Checks whether the configured GitHub token can read from and write to a specific branch in a repository.

This endpoint requires the server to be configured with `ADMIN_BEARER_TOKEN` and the client to send `Authorization: Bearer <token>`.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |
| `branch` | `string` | Yes | Branch name to check permissions for. |
| `githubKey` | `string` | No | Optional GitHub token. Defaults to `PRIVATE_GITHUB_TOKEN`. |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Normalized repository name |
| `branch` | `string` | Branch name that was checked |
| `read` | `boolean` | Whether the token has read access to the branch |
| `write` | `boolean` | Whether the token has write access to the branch |

#### Common statuses

- `400 Bad Request` when `repo` or `branch` is missing or invalid
- `401 Unauthorized` when the bearer token is missing or invalid
- `404 Not Found` when the repository or branch does not exist
- `503 Service Unavailable` when the bearer token is not configured
- `500 Internal Server Error` for GitHub API failures

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/branch-permissions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react",
    "branch": "main"
  }'
```

Example response:

```json
{
  "repo": "facebook/react",
  "branch": "main",
  "read": true,
  "write": false
}
```

---

### `POST /api/jobs/create-tag`

Creates and pushes a remote tag for a specific commit in a GitHub repository.

This endpoint requires the server to be configured with `ADMIN_BEARER_TOKEN` and the client to send `Authorization: Bearer <token>`.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |
| `tag` | `string` | Yes | Tag name to create, for example `v1.2.3` or `release/2026.04.22`. |
| `commit` | `string` | Yes | Full 40-character commit SHA the tag should point to. |
| `githubKey` | `string` | No | Optional GitHub token. Defaults to `PRIVATE_GITHUB_TOKEN`. |

#### Success response

Status: `201 Created`

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Normalized repository name |
| `tag` | `string` | Created tag name |
| `ref` | `string` | Created Git ref, always `refs/tags/<tag>` |
| `commit` | `string` | Full commit SHA the tag points to |
| `commitShort` | `string` | Short commit SHA |

#### Common statuses

- `400 Bad Request` when `repo`, `tag`, or `commit` is missing or invalid
- `401 Unauthorized` when the bearer token is missing or invalid
- `404 Not Found` when the repository does not exist
- `422 Unprocessable Entity` when the tag already exists or GitHub rejects the ref creation
- `503 Service Unavailable` when the bearer token is not configured
- `500 Internal Server Error` for GitHub API failures

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/create-tag \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react",
    "tag": "v1.2.3",
    "commit": "0123456789abcdef0123456789abcdef01234567"
  }'
```

Example response:

```json
{
  "repo": "facebook/react",
  "tag": "v1.2.3",
  "ref": "refs/tags/v1.2.3",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "commitShort": "0123456"
}
```

---

### `POST /api/jobs/delete-tag`

Deletes a remote tag from a GitHub repository.

This endpoint requires the server to be configured with `ADMIN_BEARER_TOKEN` and the client to send `Authorization: Bearer <token>`.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |
| `tag` | `string` | Yes | Tag name to delete from the remote (without the `refs/tags/` prefix). |
| `githubKey` | `string` | No | Optional GitHub token. Defaults to `PRIVATE_GITHUB_TOKEN`. |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Normalized repository name |
| `tag` | `string` | Deleted tag name |

#### Common statuses

- `400 Bad Request` when `repo` or `tag` is missing or invalid
- `401 Unauthorized` when the bearer token is missing or invalid
- `404 Not Found` when the tag does not exist
- `503 Service Unavailable` when the bearer token is not configured
- `500 Internal Server Error` for GitHub API failures

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/delete-tag \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react",
    "tag": "v1.2.3"
  }'
```

---

### `POST /api/jobs/delete-repository`

Deletes a GitHub repository.

This endpoint requires the server to be configured with `ADMIN_BEARER_TOKEN` and the client to send `Authorization: Bearer <token>`. The GitHub token used for the call (request `githubKey` or environment) must have the `delete_repo` scope.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |
| `githubKey` | `string` | No | Optional GitHub token. Defaults to `PRIVATE_GITHUB_TOKEN`. |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Normalized repository name |

#### Common statuses

- `400 Bad Request` when `repo` is missing or invalid
- `401 Unauthorized` when the bearer token is missing or invalid
- `403 Forbidden` when the GitHub token does not have permission to delete the repository
- `404 Not Found` when the repository does not exist
- `503 Service Unavailable` when the bearer token is not configured
- `500 Internal Server Error` for GitHub API failures

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/delete-repository \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react"
  }'
```

---

### `POST /api/jobs/tags`

Lists tags for a repository, newest first as returned by GitHub. The API itself does not paginate &mdash; the server iterates over GitHub's pages internally until at least `limit` tags have been collected (or the repository runs out of tags).

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |
| `limit` | `number` | Yes | Maximum number of tags to return. Must be a positive integer. |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Normalized repository name |
| `tags` | `array` | List of tag entries, capped at `limit` |

Each `tags` entry contains:

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Tag name (e.g. `v1.2.3`) |
| `ref` | `string` | Full Git ref, always `refs/tags/<name>` |
| `commit` | `string` | Commit SHA the tag points to |
| `commitShort` | `string` | Short commit SHA |

#### Common statuses

- `400 Bad Request` when `repo` is missing/invalid or `limit` is not a positive integer
- `404 Not Found` when the repository does not exist
- `500 Internal Server Error` for GitHub API failures

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/tags \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react",
    "limit": 50
  }'
```

Example response:

```json
{
  "repo": "facebook/react",
  "tags": [
    {
      "name": "v1.2.3",
      "ref": "refs/tags/v1.2.3",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "commitShort": "0123456"
    }
  ]
}
```

---

### `POST /api/jobs/actions`

Lists GitHub Actions workflow runs for a repository, newest first as returned by GitHub. The API itself does not paginate &mdash; the server iterates over GitHub's pages internally until at least `limit` runs have been collected (or the repository runs out of workflow runs).

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |
| `limit` | `number` | Yes | Maximum number of workflow runs to return. Must be a positive integer. |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Normalized repository name |
| `runs` | `array` | List of workflow run entries, capped at `limit` |

Each `runs` entry contains:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `number` | GitHub workflow run id |
| `runNumber` | `number` | Run-level number (monotonic per workflow) |
| `name` | `string` | Display name of the run |
| `workflowId` | `number` | Id of the workflow this run belongs to |
| `event` | `string` | Event that triggered the run, e.g. `push`, `pull_request` |
| `status` | `string` | Run status, e.g. `queued`, `in_progress`, `completed` |
| `conclusion` | `string \| null` | Run conclusion when completed, e.g. `success`, `failure`; `null` while in progress |
| `branch` | `string` | Branch the run was triggered for |
| `commit` | `string` | Commit SHA the run was triggered for |
| `commitShort` | `string` | Short commit SHA |
| `createdAt` | `string` | Run creation timestamp |
| `updatedAt` | `string` | Run last update timestamp |
| `url` | `string` | URL to the run on GitHub |

#### Common statuses

- `400 Bad Request` when `repo` is missing/invalid or `limit` is not a positive integer
- `404 Not Found` when the repository does not exist
- `500 Internal Server Error` for GitHub API failures

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/actions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react",
    "limit": 50
  }'
```

Example response:

```json
{
  "repo": "facebook/react",
  "runs": [
    {
      "id": 42,
      "runNumber": 7,
      "name": "CI",
      "workflowId": 100,
      "event": "push",
      "status": "completed",
      "conclusion": "success",
      "branch": "main",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "commitShort": "0123456",
      "createdAt": "2026-04-01T12:00:00Z",
      "updatedAt": "2026-04-01T12:05:00Z",
      "url": "https://github.com/facebook/react/actions/runs/42"
    }
  ]
}
```

---

### `POST /api/jobs/delete-action-run`

Deletes a specific GitHub Actions workflow run.

This endpoint requires the server to be configured with `ADMIN_BEARER_TOKEN` and the client to send `Authorization: Bearer <token>`.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |
| `runId` | `number` | Yes | Workflow run id to delete. Must be a positive integer. |
| `githubKey` | `string` | No | Optional GitHub token. Defaults to `PRIVATE_GITHUB_TOKEN`. |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Normalized repository name |
| `runId` | `number` | Deleted workflow run id |

#### Common statuses

- `400 Bad Request` when `repo` or `runId` is missing or invalid
- `401 Unauthorized` when the bearer token is missing or invalid
- `404 Not Found` when the workflow run does not exist
- `503 Service Unavailable` when the bearer token is not configured
- `500 Internal Server Error` for GitHub API failures

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/delete-action-run \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react",
    "runId": 42
  }'
```

---

### `POST /api/jobs/pull-request/ready`

Marks a draft pull request as ready for review.

This endpoint requires the server to be configured with `ADMIN_BEARER_TOKEN` and the client to send `Authorization: Bearer <token>`.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |
| `pullNumber` | `number` | Yes | Pull request number. |
| `githubKey` | `string` | No | Optional GitHub token. Defaults to `PRIVATE_GITHUB_TOKEN`. |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Normalized repository name |
| `pullNumber` | `number` | Pull request number |

#### Common statuses

- `400 Bad Request` when `repo` or `pullNumber` is missing or invalid
- `401 Unauthorized` when the bearer token is missing or invalid
- `404 Not Found` when the pull request does not exist
- `503 Service Unavailable` when the bearer token is not configured
- `500 Internal Server Error` for GitHub API failures

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/pull-request/ready \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react",
    "pullNumber": 123
  }'
```

---

### `POST /api/jobs/pull-request/merge`

Merges a pull request on GitHub.

This endpoint requires the server to be configured with `ADMIN_BEARER_TOKEN` and the client to send `Authorization: Bearer <token>`.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |
| `pullNumber` | `number` | Yes | Pull request number. |
| `commitTitle` | `string` | No | Title for the merge commit. |
| `commitMessage` | `string` | No | Message body for the merge commit. |
| `mergeMethod` | `string` | No | Merge method: `merge`, `squash`, or `rebase`. Defaults to `merge`. |
| `githubKey` | `string` | No | Optional GitHub token. Defaults to `PRIVATE_GITHUB_TOKEN`. |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Normalized repository name |
| `pullNumber` | `number` | Pull request number |
| `merged` | `boolean` | Whether the pull request was successfully merged |
| `message` | `string` | Message returned by GitHub |
| `sha` | `string` | Merge commit SHA |

#### Common statuses

- `400 Bad Request` when `repo` or `pullNumber` is missing or invalid
- `401 Unauthorized` when the bearer token is missing or invalid
- `404 Not Found` when the pull request does not exist
- `405 Method Not Allowed` when the pull request is not mergeable
- `409 Conflict` when there is a merge conflict
- `503 Service Unavailable` when the bearer token is not configured
- `500 Internal Server Error` for GitHub API failures

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/pull-request/merge \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react",
    "pullNumber": 123,
    "mergeMethod": "squash"
  }'
```

---

### `POST /api/jobs/pull-request/open`

Opens a new pull request on GitHub. By default, the title and description are derived from the last commit on the head branch.

This endpoint requires the server to be configured with `ADMIN_BEARER_TOKEN` and the client to send `Authorization: Bearer <token>`.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |
| `head` | `string` | Yes | Head branch containing the changes. |
| `base` | `string` | No | Base branch to merge into. Defaults to `main`. |
| `title` | `string` | No | Pull request title. Defaults to the first line of the last commit message on the head branch. |
| `body` | `string` | No | Pull request body/description. Defaults to the full last commit message on the head branch. |
| `draft` | `boolean` | No | Whether to create as a draft pull request. Defaults to `false` (ready for review). |
| `githubKey` | `string` | No | Optional GitHub token. Defaults to `PRIVATE_GITHUB_TOKEN`. |

#### Success response

Status: `201 Created`

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Normalized repository name |
| `pullNumber` | `number` | Created pull request number |
| `title` | `string` | Pull request title |
| `url` | `string` | Pull request URL |
| `draft` | `boolean` | Whether the pull request was created as a draft |

#### Common statuses

- `400 Bad Request` when `repo` or `head` is missing or invalid
- `401 Unauthorized` when the bearer token is missing or invalid
- `404 Not Found` when the repository or branch does not exist
- `422 Unprocessable Entity` when a pull request already exists for the head/base pair
- `503 Service Unavailable` when the bearer token is not configured
- `500 Internal Server Error` for GitHub API failures

#### Example

Open a draft pull request:

```bash
curl -X POST https://your-host.example.com/api/jobs/pull-request/open \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react",
    "head": "feature-branch",
    "base": "main",
    "draft": true
  }'
```

Open a ready-to-review pull request with a custom title:

```bash
curl -X POST https://your-host.example.com/api/jobs/pull-request/open \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react",
    "head": "feature-branch",
    "title": "Add login feature",
    "body": "This PR adds the login feature with OAuth support."
  }'
```

---

### `POST /api/jobs/create-task`

Creates a local agent-task job for a repository and enqueues background processing. The worker checks out `base_ref`, creates and pushes a new task branch, opens a draft pull request, then runs the selected local agent (Codex by default; Claude or opencode when `task` is set). When `task_delay_ms` is provided, task execution is deferred until the delay expires.

This endpoint requires the server to be configured with `ADMIN_BEARER_TOKEN` and the client to send `Authorization: Bearer <token>`.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |
| `problem_statement` | `string` | Yes | Task instructions passed to the selected local agent and included in the initialization commit/PR body. |
| `base_ref` | `string` | Yes | Base ref for the new branch/PR. |
| `task` | `"codex" \| "opencode" \| "claude"` | No | Local agent implementation. Defaults to `codex`. |
| `model` | `string` | No | Model for the selected task runner. Codex defaults to `CODEX_MODEL` or `gpt-5.2-codex`; Claude defaults to `CLAUDE_MODEL` or `sonnet`; opencode defaults to `deepseek-v4-flash` and only accepts `deepseek-v4-flash` or `deepseek-v4-pro`. |
| `agent_id` | `integer` | No | Compatibility field stored on the task summary; not used to dispatch a remote agent. |
| `custom_agent` | `string` | No | Compatibility field stored on the task summary; not used to dispatch a remote agent. |
| `create_pull_request` | `boolean` | No | Compatibility field. When provided it must be `true`, because agent tasks always create a draft pull request before execution starts. |
| `auto_ready` | `boolean` | No | Compatibility flag equivalent to `pull_request_completion_mode: "AutoReady"`. Cannot be combined with a conflicting `pull_request_completion_mode` value. |
| `auto_merge` | `boolean` | No | Compatibility flag equivalent to `pull_request_completion_mode: "AutoMerge"`. Takes precedence over `auto_ready` and cannot be combined with a conflicting `pull_request_completion_mode` value. |
| `pull_request_completion_mode` | `"None" \| "AutoReady" \| "AutoMerge"` | No | Follow-up PR action after a successful run. `AutoReady` marks the draft PR ready for review after success; `AutoMerge` additionally enables GitHub auto-merge if the repository setting `Allow auto-merge` is enabled. |
| `branch` | `string` | No | Optional task branch name override. When the branch already exists on origin, the service increments the trailing numeric suffix until it finds a free name (e.g. `branch` → `branch-1`, `branch-03` → `branch-04`). |
| `branch_title` | `string` | No | Optional task branch name override accepted from frontend clients. If both `branch` and `branch_title` are provided, they must normalize to the same value. |
| `reasoning_effort` | `"low" \| "medium" \| "high" \| "xhigh"` | No | Codex-only reasoning effort override. Defaults to `medium`. |
| `reasoning_summary` | `"none" \| "auto" \| "concise" \| "detailed"` | No | Codex-only reasoning summary setting. Defaults to `auto`. |
| `verbosity` | `"low" \| "medium" \| "high"` | No | Codex-only output verbosity override. |
| `codex_web_search` | `boolean` | No | Codex-only flag to enable the Codex web search tool. |
| `task_delay_ms` | `integer` | No | Optional non-negative delay in milliseconds before the queued worker starts processing the task. |
| `githubKey` | `string` | No | Per-request GitHub token override used for branch, commit, push, and PR creation. Defaults to `PRIVATE_GITHUB_TOKEN`. |
| `deepseek_api_key` | `string` | No | Per-request DeepSeek API key override for opencode tasks. Defaults to `DEEPSEEK_API_KEY`. |

#### Success response

Status: `201 Created`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Created local agent-task job ID. Use this value to query status, list pending jobs, or cancel the job before it starts. |

#### Common statuses

- `400 Bad Request` when any required field is missing or invalid
- `401 Unauthorized` when the bearer token is missing or invalid
- `500 Internal Server Error` when the local job cannot be recorded or queued

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/create-task \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react",
    "problem_statement": "Investigate and fix the login flow bug",
    "base_ref": "main",
    "branch_title": "fd-agent/custom-name",
    "task": "codex",
    "model": "gpt-5.2-codex",
    "create_pull_request": true,
    "pull_request_completion_mode": "AutoMerge",
    "verbosity": "medium",
    "codex_web_search": true,
    "task_delay_ms": 60000
  }'
```

---

### `GET /api/jobs/create-task/pending`

Lists local agent-task jobs that are queued and have not yet been picked up by a worker.

#### Success response

Status: `200 OK`

Returns an array of the same objects documented for `GET /api/jobs/create-task/:id`.

---

### `GET /api/jobs/create-task/:id`

Returns the locally tracked status, captured output, and session metadata for a background agent-task job. While an agent is running, logs and session details are flushed into the database about every 15 seconds.

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Local agent-task job id |
| `repo` | `string` | Repository in `owner/repo` format |
| `status` | `string` | Local job status: `waiting`, `active`, `completed`, `failed`, or `canceled` |
| `taskStatus` | `string` | Task phase such as `preparing`, `working`, or `completed`, when available |
| `taskRunner` | `"codex" \| "opencode" \| "claude"` | Selected task runner, when available |
| `baseRef` | `string` | Requested base ref, when available |
| `model` | `string` | Selected task model, when available |
| `branch` | `string \| null` | Generated task branch name once known, otherwise `null` |
| `pullRequestUrl` | `string` | Draft pull request URL when available |
| `pullRequestNumber` | `number` | Draft pull request number when available |
| `pullRequestCompletionMode` | `"None" \| "AutoReady" \| "AutoMerge"` | Requested follow-up PR action when set. `AutoMerge` enables GitHub auto-merge on the created pull request. |
| `reasoningEffort` | `string` | Codex reasoning effort when set |
| `reasoningSummary` | `string` | Codex reasoning summary when set |
| `verbosity` | `string` | Codex verbosity when set |
| `codexWebSearch` | `boolean` | Whether Codex web search was enabled |
| `output` | `string` | Combined captured agent stdout/stderr collected so far |
| `stdout` | `string` | Captured agent stdout collected so far |
| `stderr` | `string` | Captured agent stderr collected so far |
| `opencodeSessionId` | `string` | Detected opencode session id when available |
| `opencodeSessionExport` | `object` | Latest JSON returned by `opencode export <sessionId>` when available |
| `codexSessionId` | `string` | Captured Codex startup `session id` when available |
| `codexSessionFilePath` | `string` | Matching Codex rollout JSONL path under `~/.codex/sessions` when found |
| `codexSessionExport` | `object` | Codex session details, including `sessionId`, `sessionFilePath`, and `testDetails` lines grep-matched from the rollout JSONL |
| `error` | `string` | Error message when the job has failed |
| `taskDelayMs` | `integer` | Configured startup delay in milliseconds |
| `scheduledAt` | `string \| null` | Scheduled start time for delayed jobs, otherwise `null` |
| `cancelRequestedAt` | `string \| null` | Time cancellation was requested, otherwise `null` |
| `deletedAt` | `string \| null` | Time the task was soft-deleted, otherwise `null` |
| `createdAt` | `string` | Job creation timestamp |
| `updatedAt` | `string` | Last update timestamp |

#### Common statuses

- `404 Not Found` when the task job id is unknown

#### Example

```bash
curl https://your-host.example.com/api/jobs/create-task/7eb718f7-5c92-42d4-a6f8-1caaedfb29dc \
  -H "Authorization: Bearer <token>"
```

---

### `POST /api/jobs/create-task/:id/cancel`

Cancels a local agent-task job. Waiting jobs are removed from the queue and marked `canceled`; running Codex/opencode/Claude jobs receive a persisted cancellation request and the worker terminates the attached process before marking the row `canceled`.

This endpoint requires the server to be configured with `ADMIN_BEARER_TOKEN` and the client to send `Authorization: Bearer <token>`.

#### Success response

Status: `200 OK`

Returns the updated job payload documented for `GET /api/jobs/create-task/:id`.

#### Common statuses

- `404 Not Found` when the task job id is unknown
- `409 Conflict` when the task job has already completed or failed

---

### `DELETE /api/jobs/create-task/:id`

Soft-deletes a local agent-task job without removing its database row. If the task is waiting or running, cancellation is requested first. Deleted jobs are omitted from active task listings.

This endpoint requires the server to be configured with `ADMIN_BEARER_TOKEN` and the client to send `Authorization: Bearer <token>`.

#### Success response

Status: `200 OK`

Returns the updated job payload documented for `GET /api/jobs/create-task/:id`, with `deletedAt` set.

#### Common statuses

- `404 Not Found` when the task job id is unknown

---

### `GET /api/agents/repos/:owner/:repo/tasks/:task_id`

Returns the details of a single locally-managed agent task job (Codex/opencode/Claude based).
The `:task_id` is the local agent task job id returned from `POST /api/jobs/create-task`.
For Codex tasks, `:task_id` can also be the captured Codex `session id` from the startup banner.

This endpoint requires the server to be configured with `ADMIN_BEARER_TOKEN` and the client to send `Authorization: Bearer <token>`.

#### Success response

Status: `200 OK`

Returns the agent task job record from the local database, including its repo, task runner, model, Codex option settings when present, branch, pull request information, combined `output`, split `stdout`/`stderr`, detected opencode or Codex session ids, exported session details, and timestamps. While an agent is running, logs and session details are flushed into the database about every 15 seconds.

#### Common statuses

- `400 Bad Request` when the repository path or task id is invalid
- `401 Unauthorized` when the bearer token is missing or invalid
- `404 Not Found` when no agent task job with the given id exists for the specified repository
- `500 Internal Server Error` for unexpected failures

#### Example

```bash
curl https://your-host.example.com/api/agents/repos/facebook/react/tasks/a1b2c3d4-e5f6-7890-abcd-ef1234567890 \
  -H "Authorization: Bearer <token>"
```

---

### `DELETE /api/agents/repos/:owner/:repo/tasks/:task_id`

Soft-deletes a single locally-managed agent task job for a repository. If it is waiting or running, cancellation is requested first. The task row and captured output remain in the database.

This endpoint requires the server to be configured with `ADMIN_BEARER_TOKEN` and the client to send `Authorization: Bearer <token>`.

#### Success response

Status: `200 OK`

Returns the updated agent task job record.

#### Common statuses

- `400 Bad Request` when the repository path or task id is invalid
- `401 Unauthorized` when the bearer token is missing or invalid
- `404 Not Found` when no agent task job with the given id exists for the specified repository

---

### `GET /api/agents/repos/:owner/:repo/tasks`

Lists active (waiting or running) locally-managed agent task jobs for the repository.

This endpoint requires the server to be configured with `ADMIN_BEARER_TOKEN` and the client to send `Authorization: Bearer <token>`.

#### Success response

Status: `200 OK`

Returns an array of active agent task job records for the repository.

#### Common statuses

- `400 Bad Request` when the repository path is invalid
- `401 Unauthorized` when the bearer token is missing or invalid
- `500 Internal Server Error` for unexpected failures

#### Example

```bash
curl https://your-host.example.com/api/agents/repos/facebook/react/tasks \
  -H "Authorization: Bearer <token>"
```

---

### `GET /api/agents/tasks`

Lists active (waiting or running) locally-managed agent task jobs across all repositories.

This endpoint requires the server to be configured with `ADMIN_BEARER_TOKEN` and the client to send `Authorization: Bearer <token>`.

#### Success response

Status: `200 OK`

Returns an array of active agent task job records.

#### Common statuses

- `401 Unauthorized` when the bearer token is missing or invalid
- `500 Internal Server Error` for unexpected failures

#### Example

```bash
curl https://your-host.example.com/api/agents/tasks \
  -H "Authorization: Bearer <token>"
```

---

### `POST /api/jobs/pull-request/resolve`

Resolves a GitHub pull request URL into source and target commit hashes.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `pullRequestUrl` | `string` | Yes | Full GitHub pull request URL, for example `https://github.com/facebook/react/pull/123` |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Repository in `owner/repo` format |
| `repositoryUrl` | `string` | Base GitHub repository URL |
| `sourceCommit` | `string` | Pull request source commit SHA |
| `sourceCommitShort` | `string` | Short source commit SHA |
| `targetCommit` | `string` | Pull request target commit SHA |
| `targetCommitShort` | `string` | Short target commit SHA |

#### Error response

| Field | Type | Description |
| --- | --- | --- |
| `error` | `string` | Error message |

Common statuses:

- `400 Bad Request` when `pullRequestUrl` is missing or malformed
- Other GitHub API status codes may be returned as-is
- `500 Internal Server Error` for unexpected failures

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/pull-request/resolve \
  -H "Content-Type: application/json" \
  -d '{
    "pullRequestUrl": "https://github.com/facebook/react/pull/123"
  }'
```

Example response:

```json
{
  "repo": "facebook/react",
  "repositoryUrl": "https://github.com/facebook/react",
  "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
  "sourceCommitShort": "0123456",
  "targetCommit": "1111111111111111111111111111111111111111",
  "targetCommitShort": "1111111"
}
```

---

### `POST /api/jobs/refs`

Lists branches and tags that can be used for a repository.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Normalized repository name |
| `refs` | `array` | List of available refs |

Each `refs` item contains:

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Display name of the branch or tag |
| `ref` | `string` | Full Git ref, for example `refs/heads/main` |
| `type` | `"branch" \| "tag"` | Type of ref |
| `commit` | `string` | Full resolved commit SHA |
| `commitShort` | `string` | Short commit SHA |

#### Error response

| Field | Type | Description |
| --- | --- | --- |
| `error` | `string` | Error message |

Common statuses:

- `400 Bad Request` when `repo` is missing or invalid
- `500 Internal Server Error` when refs cannot be listed

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/refs \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react"
  }'
```

Example response:

```json
{
  "repo": "facebook/react",
  "refs": [
    {
      "name": "main",
      "ref": "refs/heads/main",
      "type": "branch",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "commitShort": "0123456"
    },
    {
      "name": "v1.0.0",
      "ref": "refs/tags/v1.0.0",
      "type": "tag",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "commitShort": "0123456"
    }
  ]
}
```

---

### `POST /api/jobs/commits`

Lists repository commits from newest to oldest, limited by the requested count.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |
| `limit` | `number` | Yes | Maximum number of commits to return. Must be a positive integer. |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Normalized repository name |
| `commits` | `array` | Recent commits ordered from newest to oldest |

Each `commits` item contains:

| Field | Type | Description |
| --- | --- | --- |
| `commit` | `string` | Full commit SHA |
| `date` | `string` | Commit date/time in ISO-8601 format |
| `author` | `string` | Commit author name |
| `title` | `string` | Commit subject/title |
| `branch` | `string \| null` | Branch name when the commit is the head of a branch |
| `parents` | `string[]` | Full parent commit SHAs |
| `pullRequest` | `object \| null` | Associated GitHub pull request when available |
| `tags` | `string[]` | Tag names pointing at the commit |

When `pullRequest` is present, it contains:

| Field | Type | Description |
| --- | --- | --- |
| `number` | `number` | Pull request number |
| `title` | `string` | Pull request title |
| `url` | `string` | Pull request URL |
| `state` | `"open" \| "closed"` | Pull request state when GitHub provides it |

#### Error response

| Field | Type | Description |
| --- | --- | --- |
| `error` | `string` | Error message |

Common statuses:

- `400 Bad Request` when `repo` is missing or invalid, or `limit` is not a positive integer
- `500 Internal Server Error` when commit history cannot be listed

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/commits \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react",
    "limit": 2
  }'
```

Example response:

```json
{
  "repo": "facebook/react",
  "commits": [
    {
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "date": "2026-03-20T12:00:00Z",
      "author": "Jane Developer",
      "title": "Add commit history endpoint",
      "branch": "main",
      "parents": [
        "1111111111111111111111111111111111111111"
      ],
      "pullRequest": {
        "number": 123,
        "title": "Add commit history endpoint",
        "url": "https://github.com/facebook/react/pull/123",
        "state": "open"
      },
      "tags": [
        "v1.0.0"
      ]
    },
    {
      "commit": "1111111111111111111111111111111111111111",
      "date": "2026-03-19T09:15:00Z",
      "author": "Jane Developer",
      "title": "Prepare release",
      "branch": null,
      "parents": [],
      "pullRequest": null,
      "tags": []
    }
  ]
}
```

---

### `POST /api/jobs/branches`

Lists repository branches with each branch head commit, default-branch flag, head tags, and pull request status.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Normalized repository name |
| `branches` | `array` | Repository branches ordered by branch name |

Each `branches` item contains:

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Branch name |
| `ref` | `string` | Full Git ref, for example `refs/heads/main` |
| `commit` | `string` | Full head commit SHA |
| `commitShort` | `string` | Short head commit SHA |
| `date` | `string` | Head commit date/time in ISO-8601 format |
| `author` | `string` | Head commit author name |
| `title` | `string` | Head commit subject/title |
| `isDefault` | `boolean` | Whether the branch is the repository default branch |
| `pullRequestStatus` | `"open" \| "closed" \| "none"` | Pull request status for the branch head commit |
| `pullRequest` | `object \| null` | Associated GitHub pull request when available |
| `tags` | `string[]` | Tag names pointing at the branch head commit |

When `pullRequest` is present, it contains:

| Field | Type | Description |
| --- | --- | --- |
| `number` | `number` | Pull request number |
| `title` | `string` | Pull request title |
| `url` | `string` | Pull request URL |
| `state` | `"open" \| "closed"` | Pull request state when GitHub provides it |

#### Error response

| Field | Type | Description |
| --- | --- | --- |
| `error` | `string` | Error message |

Common statuses:

- `400 Bad Request` when `repo` is missing or invalid
- `500 Internal Server Error` when branches cannot be listed

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/branches \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react"
  }'
```

Example response:

```json
{
  "repo": "facebook/react",
  "branches": [
    {
      "name": "feature/summary",
      "ref": "refs/heads/feature/summary",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "commitShort": "0123456",
      "date": "2026-03-20T12:00:00Z",
      "author": "Jane Developer",
      "title": "Add branch summary endpoint",
      "isDefault": false,
      "pullRequestStatus": "open",
      "pullRequest": {
        "number": 123,
        "title": "Add branch summary endpoint",
        "url": "https://github.com/facebook/react/pull/123",
        "state": "open"
      },
      "tags": [
        "v1.0.0"
      ]
    },
    {
      "name": "main",
      "ref": "refs/heads/main",
      "commit": "1111111111111111111111111111111111111111",
      "commitShort": "1111111",
      "date": "2026-03-19T09:15:00Z",
      "author": "Jane Developer",
      "title": "Prepare release",
      "isDefault": true,
      "pullRequestStatus": "none",
      "pullRequest": null,
      "tags": []
    }
  ]
}
```

---

### `POST /api/jobs/commits/graph`

Returns recent commits as mixed node/edge items that can be fed directly into a graph visualizer.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |
| `limit` | `number` | Yes | Maximum number of commits to inspect. Must be a positive integer. |

#### Success response

Status: `200 OK`

Returns a JSON array. Each item is one of:

Node item:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Full commit SHA |
| `type` | `"node"` | Item kind |
| `colorKey` | `string` | Optional branch name when the commit is the head of a branch |

Edge item:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Stable edge identifier in `parent->child` format |
| `type` | `"edge"` | Item kind |
| `source` | `string` | Parent commit SHA |
| `target` | `string` | Child commit SHA |

Edges are only included when both commits are present in the requested result set.

#### Error response

| Field | Type | Description |
| --- | --- | --- |
| `error` | `string` | Error message |

Common statuses:

- `400 Bad Request` when `repo` is missing or invalid, or `limit` is not a positive integer
- `500 Internal Server Error` when commit history cannot be listed

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs/commits/graph \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react",
    "limit": 3
  }'
```

Example response:

```json
[
  {
    "id": "0123456789abcdef0123456789abcdef01234567",
    "type": "node",
    "colorKey": "main"
  },
  {
    "id": "1111111111111111111111111111111111111111",
    "type": "node"
  },
  {
    "id": "1111111111111111111111111111111111111111->0123456789abcdef0123456789abcdef01234567",
    "type": "edge",
    "source": "1111111111111111111111111111111111111111",
    "target": "0123456789abcdef0123456789abcdef01234567"
  }
]
```

---

### `GET /api/jobs/organizations/:organization/repositories`

Lists repositories available inside a GitHub organization.

#### Path arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `organization` | `string` | Yes | GitHub organization name |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `organization` | `string` | Organization name |
| `repositories` | `array` | List of organization repositories |

Each `repositories` item contains:

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Repository short name |
| `repo` | `string` | Repository in `owner/repo` format |
| `repositoryUrl` | `string` | Full GitHub repository URL |
| `pushedAt` | `string` | Last push timestamp from GitHub |
| `createdAt` | `string` | Repository creation timestamp from GitHub |
| `updatedAt` | `string` | Last update timestamp from GitHub |

#### Error response

| Field | Type | Description |
| --- | --- | --- |
| `error` | `string` | Error message |

Common statuses:

- `400 Bad Request` when the organization name format is invalid
- `404 Not Found` when the organization does not exist
- Other GitHub API status codes may be returned as-is

#### Example

```bash
curl -X GET \
  https://your-host.example.com/api/jobs/organizations/facebook/repositories
```

Example response:

```json
{
  "organization": "facebook",
  "repositories": [
    {
      "name": "react",
      "repo": "facebook/react",
      "repositoryUrl": "https://github.com/facebook/react"
    }
  ]
}
```

---

### `GET /api/jobs/cache`

Lists git cache folders currently present on disk under the configured temporary directory.

#### Request arguments

None.

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `count` | `number` | Number of git cache folders found on disk |
| `totalSize` | `number` | Total size in bytes across all git cache folders |
| `folders` | `array` | Per-folder size details |

Each `folders` entry contains:

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Cache folder name |
| `size` | `number` | Folder size in bytes |

#### Example

```bash
curl -X GET https://your-host.example.com/api/jobs/cache
```

Example response:

```json
{
  "count": 2,
  "totalSize": 123456,
  "folders": [
    {
      "name": "0f4c2f...",
      "size": 45678
    },
    {
      "name": "b93d17...",
      "size": 77778
    }
  ]
}
```

---

### `POST /api/jobs`

Creates a new repository-processing job for a specific commit.

If a job already exists for the same commit hash, the existing job summary is returned instead of creating a duplicate.

#### Request arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | `string` | Yes | Repository in `owner/repo` format. GitHub URLs such as `https://github.com/owner/repo.git` are also accepted and normalized. |
| `commit` | `string` | Yes | Full 40-character hexadecimal commit SHA |

#### Success response

Status:

- `201 Created` for a newly created job
- `200 OK` when an existing job for the same commit is reused, including when a failed job is reset to `waiting` and started again

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Job ID. In the current implementation this is the same as the commit SHA. |
| `status` | `string` | Current job status |
| `commit` | `string` | Full commit SHA |
| `commitShort` | `string` | Short commit SHA |

#### Error response

| Field | Type | Description |
| --- | --- | --- |
| `error` | `string` | Error message |

Common statuses:

- `400 Bad Request` when required fields are missing or invalid

#### Example

```bash
curl -X POST https://your-host.example.com/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "facebook/react",
    "commit": "0123456789abcdef0123456789abcdef01234567"
  }'
```

Example response:

```json
{
  "id": "0123456789abcdef0123456789abcdef01234567",
  "status": "waiting",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "commitShort": "0123456"
}
```

---

### `GET /api/jobs/:id`

Returns the current status and progress for a previously created job.

#### Path arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Job ID / commit SHA (full or short prefix, minimum 2 characters) |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Job ID |
| `repo` | `string` | Repository in `owner/repo` format |
| `commit` | `string` | Full commit SHA |
| `commitShort` | `string` | Short commit SHA |
| `status` | `string` | Current job status |
| `progress` | `number` | Numeric job progress |
| `totalFiles` | `number` | Total number of files expected |
| `processedFiles` | `number` | Number of files already processed |
| `error` | `string` | Optional error message when the job fails |
| `createdAt` | `string` | Creation timestamp |
| `updatedAt` | `string` | Last update timestamp |

#### Error response

| Field | Type | Description |
| --- | --- | --- |
| `error` | `string` | Error message |

Common statuses:

- `400 Bad Request` when a short hash prefix matches multiple distinct jobs (ambiguous)
- `404 Not Found` when the job does not exist

#### Example

```bash
curl -X GET \
  https://your-host.example.com/api/jobs/0123456789abcdef0123456789abcdef01234567
```

---

### `GET /api/jobs/:id/files`

Returns compact metadata for files that were processed for a job.

#### Path arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Job ID / commit SHA (full or short prefix, minimum 2 characters) |

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `jobId` | `string` | Job ID |
| `commit` | `string` | Full commit SHA |
| `commitShort` | `string` | Short commit SHA |
| `status` | `string` | Current job status |
| `progress` | `number` | Numeric job progress |
| `files` | `array` | File metadata entries |

Each `files` item contains:

| Field | Type | Description |
| --- | --- | --- |
| `t` | `string` | File type code |
| `path` | `string` | Path relative to repository root |
| `s` | `number` | File size in bytes |
| `update` | `string` | ISO-8601 timestamp of the last file update |
| `commit` | `string` | Last commit that touched the file |
| `hash` | `string` | Git blob hash of the file |

#### Error response

| Field | Type | Description |
| --- | --- | --- |
| `error` | `string` | Error message |

Common statuses:

- `400 Bad Request` when a short hash prefix matches multiple distinct jobs (ambiguous)
- `404 Not Found` when the job does not exist

#### Example

```bash
curl -X GET \
  https://your-host.example.com/api/jobs/0123456789abcdef0123456789abcdef01234567/files
```

Example response:

```json
{
  "jobId": "0123456789abcdef0123456789abcdef01234567",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "commitShort": "0123456",
  "status": "waiting",
  "progress": 0,
  "files": [
    {
      "t": "t",
      "path": "README.md",
      "s": 50,
      "update": "2024-01-01T00:00:00Z",
      "commit": "abc123",
      "hash": "deadbeef"
    }
  ]
}
```

---

### `GET /api/commit/:id/files`

Returns compact metadata for files that were processed for the latest job matching a commit SHA.

#### Path arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Full or short commit SHA (minimum 2 characters) |

#### Query arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `format` | `string` | No | Response format: `json` (default), `csv`, or `binary` |

#### Success response

Status: `200 OK`

This endpoint returns the exact same response body as `GET /api/jobs/:id/files`.

When the client sends `Accept-Encoding: zstd`, the endpoint returns the selected format compressed with Zstandard and includes `Content-Encoding: zstd`.

#### Error response

| Field | Type | Description |
| --- | --- | --- |
| `error` | `string` | Error message |

Common statuses:

- `400 Bad Request` when a short commit prefix matches multiple distinct commits (ambiguous)
- `404 Not Found` when no job exists for the given commit

#### Example

```bash
curl -X GET \
  -H 'Accept-Encoding: zstd' \
  https://your-host.example.com/api/commit/0123456789abcdef0123456789abcdef01234567/files
```

---

### `GET /api/commit/:id/grep`

Searches text and executable files for the latest processed job matching a commit SHA without creating a new job.

#### Path arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Full or short commit SHA (minimum 2 characters) |

#### Query arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | `string` | Yes | Plain-text substring to search for |

#### Success response

Status: `200 OK`

```json
{
  "jobId": "job-grep",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "commitShort": "0123456",
  "status": "completed",
  "progress": 100,
  "query": "TODO",
  "matches": [
    {
      "path": "src/index.ts",
      "lineNumber": 14,
      "line": "  // TODO: remove this fallback"
    }
  ]
}
```

#### Error response

| Field | Type | Description |
| --- | --- | --- |
| `error` | `string` | Error message |

Common statuses:

- `400 Bad Request` when the `query` parameter is missing or a short commit prefix is ambiguous
- `404 Not Found` when no job exists for the given commit
- `500 Internal Server Error` when processed files cannot be read from disk

#### Example

```bash
curl -X GET \
  'https://your-host.example.com/api/commit/0123456789abcdef0123456789abcdef01234567/grep?query=TODO'
```

---

### `GET /api/jobs/:id/files/hash/:hash/download`

Downloads the file content for a file that belongs to a processed job.

#### Path arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Job ID / commit SHA (full or short prefix, minimum 2 characters) |
| `hash` | `string` | Yes | Git blob hash for the requested file (full or short prefix, minimum 2 characters) |

#### Success response

Status: `200 OK`

Response body:

- Binary file stream

Relevant headers:

| Header | Description |
| --- | --- |
| `Content-Type` | `application/octet-stream` |
| `Content-Disposition` | Attachment filename generated from the stored file name |

#### Error response

When an error occurs, the response is JSON.

Possible payloads include:

| Field | Type | Description |
| --- | --- | --- |
| `error` | `string` | Error message for lookup or file access failures |
| `statusCode` | `number` | Present on Fastify rate-limit responses |
| `message` | `string` | Present on Fastify rate-limit responses |

Common statuses:

- `400 Bad Request` when a short hash prefix matches multiple distinct jobs or files (ambiguous)
- `404 Not Found` when the job does not exist
- `404 Not Found` when the file hash does not exist for the job
- `404 Not Found` when the file is missing or unreadable on disk
- `429 Too Many Requests` when the download rate limit is exceeded

#### Example

```bash
curl -L \
  https://your-host.example.com/api/jobs/0123456789abcdef0123456789abcdef01234567/files/hash/1111111111111111111111111111111111111111/download \
  --output downloaded-file
```

Rate-limited response example:

```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "Rate limit exceeded, retry in 1 minute"
}
```

---

### `GET /api/jobs/files/hash/:hash/download`

Downloads the file content for a processed file resolved only by its git blob hash across jobs.

#### Path arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `hash` | `string` | Yes | Git blob hash for the requested file (full or short prefix, minimum 2 characters) |

#### Success response

Status: `200 OK`

Response body:

- Binary file stream

Relevant headers:

| Header | Description |
| --- | --- |
| `Content-Type` | `application/octet-stream` |
| `Content-Disposition` | Attachment filename generated from the stored file name |

#### Error response

When an error occurs, the response is JSON.

Possible payloads include:

| Field | Type | Description |
| --- | --- | --- |
| `error` | `string` | Error message for lookup or file access failures |
| `statusCode` | `number` | Present on Fastify rate-limit responses |
| `message` | `string` | Present on Fastify rate-limit responses |

Common statuses:

- `400 Bad Request` when a short hash prefix matches multiple distinct files (ambiguous)
- `404 Not Found` when no file hash exists in the database
- `404 Not Found` when all matching files are missing or unreadable on disk
- `429 Too Many Requests` when the download rate limit is exceeded

#### Example

```bash
curl -L \
  https://your-host.example.com/api/jobs/files/hash/1111111111111111111111111111111111111111/download \
  --output downloaded-file
```

---

### `GET /api/jobs/files/hash/:hash/tokenize`

Runs Shiki tokenization for a file found in the database by its hash and returns the JSON token payload.

#### Path arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `hash` | `string` | Yes | Git blob hash of the file to tokenize (full or short prefix, minimum 2 characters) |

#### Query arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `theme` | `string` | No | Bundled Shiki theme to use. Defaults to `github-dark`. |
| `language` | `string` | No | Override the Shiki language for highlighting. Use `auto` to autodetect from the file name. Defaults to `auto`. |

#### Success response

Status: `200 OK`

Response body:

- JSON emitted by Shiki tokenization, including token lines and theme metadata

#### Error response

| Field | Type | Description |
| --- | --- | --- |
| `error` | `string` | Error message |

Common statuses:

- `400 Bad Request` when `theme` or `language` is not a supported Shiki option
- `400 Bad Request` when a short hash prefix matches multiple distinct files (ambiguous)
- `404 Not Found` when the file hash does not exist in the database
- `404 Not Found` when the file is missing or unreadable on disk
- `500 Internal Server Error` when the stored file path is invalid or Shiki tokenization fails

#### Example

```bash
curl -L \
  'https://your-host.example.com/api/jobs/files/hash/1111111111111111111111111111111111111111/tokenize?theme=github-dark&language=auto'
```

Example response:

```json
{
  "tokens": [
    [
      {
        "content": "#",
        "offset": 0,
        "color": "#e1e4e8",
        "fontStyle": 0
      }
    ]
  ],
  "fg": "#e1e4e8",
  "bg": "#24292e",
  "themeName": "github-dark"
}
```

---

### `GET /api/jobs/files/hash/:leftHash/diff/:rightHash`

Runs `difft --display json` against two files found in the database by their hashes and returns the parsed JSON result.

#### Path arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `leftHash` | `string` | Yes | Git blob hash of the left-hand file (full or short prefix, minimum 2 characters) |
| `rightHash` | `string` | Yes | Git blob hash of the right-hand file (full or short prefix, minimum 2 characters) |

#### Success response

Status: `200 OK`

Response body:

- Parsed JSON emitted by `difft --display json`

#### Error response

| Field | Type | Description |
| --- | --- | --- |
| `error` | `string` | Error message |

Common statuses:

- `400 Bad Request` when a short hash prefix matches multiple distinct files (ambiguous)
- `404 Not Found` when either file hash does not exist in the database
- `404 Not Found` when either file is missing or unreadable on disk
- `500 Internal Server Error` when the stored file path is invalid or the `difft` command fails

#### Example

```bash
curl -L \
  https://your-host.example.com/api/jobs/files/hash/1111111111111111111111111111111111111111/diff/2222222222222222222222222222222222222222
```

Example response:

```json
{
  "status": "different",
  "changes": []
}
```

## Typical usage flow

### Resolve a branch or tag, then create a job

1. Call `POST /api/jobs/resolve` with a repository and ref such as `main`.
2. Copy the returned `commit`.
3. Call `POST /api/jobs` with the same repository and the resolved `commit`.
4. Poll `GET /api/jobs/:id` until `status` becomes `completed` or `failed`.
5. Call `GET /api/jobs/:id/files` to inspect processed file metadata.
6. Call `GET /api/jobs/:id/files/hash/:hash/download` to download a specific file by hash.
7. Call `GET /api/jobs/files/hash/:hash/tokenize` to fetch Shiki JSON tokens for a processed file by blob hash.
8. Call `GET /api/jobs/files/hash/:leftHash/diff/:rightHash` to compare two processed files by blob hash.

### Resolve a pull request, then compare source and target commits externally

1. Call `POST /api/jobs/pull-request/resolve`.
2. Use `sourceCommit` and `targetCommit` in your client workflow.
3. Create jobs with `POST /api/jobs` for either or both commits if you want processed file metadata from this service.

### Run an agent task and watch its progress

1. Call `POST /api/jobs/create-task` with the repo, `base_ref`, `problem_statement`, and the desired `task` runner.
2. Poll `GET /api/jobs/create-task/:id` (or `GET /api/agents/repos/:owner/:repo/tasks/:task_id`) for `status`, captured `output`, and the draft pull request URL.
3. Optionally call `POST /api/jobs/create-task/:id/cancel` to stop a running task or `DELETE /api/jobs/create-task/:id` to soft-delete it.
