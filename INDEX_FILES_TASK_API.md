# Index Files Task API

This API scope manages background file indexing tasks for a specific GitHub
repository ref. It checks out a requested ref or commit, stores file metadata,
and exposes file retrieval, tokenization, and diff endpoints for comparing
repositories and files.

The canonical scope is:

```text
/api/files
```

Agent execution, branch creation, and pull request creation are intentionally
not part of this API. Use `AGENTS_TASKS_API.md` for those workflows.

The worker uses the repository cache under `TMP_DIR/repo-cache`: a shared git
metadata cache can be reused for the same repository, while each index task gets
its own checked-out working tree. This is an implementation detail below the
`/api/files` scope, not a reason to mix file indexing routes with agent routes.

## Create a File Index Task

```http
POST /api/files/index-task
Authorization: Bearer <VIEWER_BEARER_TOKEN>
Content-Type: application/json
```

Creates or reuses a background file indexing task.

Required body fields:

| Field | Type | Description |
| --- | --- | --- |
| `repo` | `string` | Repository in `owner/repo` format. |
| `ref` or `commit` | `string` | Git ref to resolve, or a full 40-character commit SHA to index directly. |

When `commit` is provided, it is used directly. When only `ref` is provided, the
server resolves it to a full commit SHA before enqueueing work.

Response:

```json
{
  "id": "0123456789abcdef0123456789abcdef01234567",
  "status": "waiting",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "commitShort": "01234567"
}
```

If the same commit already has an indexing task, the existing task status is
returned. Failed tasks are reset and re-enqueued.

## Get File Index Task Status

```http
GET /api/files/index-task/:id
Authorization: Bearer <VIEWER_BEARER_TOKEN>
```

Returns index task status and progress.

Response fields include:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Index task id. Currently the full commit SHA. |
| `repo` | `string` | Repository in `owner/repo` format. |
| `commit` | `string` | Full indexed commit SHA. |
| `commitShort` | `string` | Short commit SHA. |
| `status` | `"waiting" \| "active" \| "completed" \| "failed"` | Current task state. |
| `progress` | `number` | Completion ratio from `0` to `1`. |
| `totalFiles` | `number` | Total files discovered. |
| `processedFiles` | `number` | Files processed so far. |
| `error` | `string` | Failure reason, when present. |

## List Indexed Files

```http
GET /api/files/index-task/:id/files
Authorization: Bearer <VIEWER_BEARER_TOKEN>
```

Returns compact file metadata for the indexed checkout.

Each file item contains:

| Field | Type | Description |
| --- | --- | --- |
| `t` | `"d" \| "t" \| "b" \| "x" \| "s"` | Directory, text, binary, executable, or symlink. |
| `path` | `string` | Path relative to the checkout root. |
| `s` | `number` | Size in bytes. |
| `update` | `string` | Last update time from git. |
| `commit` | `string` | Last commit touching the path. |
| `hash` | `string` | Git blob hash. Empty for directories. |

## Download a File by Hash

```http
GET /api/files/hash/:hash/download
Authorization: Bearer <VIEWER_BEARER_TOKEN>
```

Downloads the first accessible indexed file matching a full hash or unambiguous
short hash.

```http
GET /api/files/index-task/:id/hash/:hash/download
Authorization: Bearer <VIEWER_BEARER_TOKEN>
```

Downloads a file by hash within one index task.

## Tokenize a File by Hash

```http
GET /api/files/hash/:hash/tokenize?theme=github-dark&language=auto
Authorization: Bearer <VIEWER_BEARER_TOKEN>
```

Returns Shiki token JSON for a text file. `theme` defaults to `github-dark` and
`language` defaults to `auto`.

## Diff Two Indexed Files

```http
GET /api/files/hash/:leftHash/diff/:rightHash
Authorization: Bearer <VIEWER_BEARER_TOKEN>
```

Runs `difft --display json` against two indexed files resolved by hash and
returns the parsed JSON diff.

## Legacy Compatibility

The older mixed `/api/jobs` and `/api/jobs/files/...` endpoints are legacy
compatibility routes. New clients should use `/api/files/...`.
