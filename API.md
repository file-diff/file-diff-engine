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

Checks whether the API is running.

#### Request arguments

None.

#### Success response

Status: `200 OK`

| Field | Type | Description |
| --- | --- | --- |
| `status` | `"ok"` | Health status value |
| `message` | `string` | Human-readable health message |

#### Example

```bash
curl -X GET https://your-host.example.com/api/health
```

Example response:

```json
{
  "status": "ok",
  "message": "API is healthy"
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
| `id` | `string` | Yes | Job ID / commit SHA |

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
| `id` | `string` | Yes | Job ID / commit SHA |

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

### `GET /api/jobs/:id/files/hash/:hash/download`

Downloads the file content for a file that belongs to a processed job.

#### Path arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Job ID / commit SHA |
| `hash` | `string` | Yes | Git blob hash for the requested file |

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

### `GET /api/jobs/files/hash/:hash/tokenize`

Runs Shiki tokenization for a file found in the database by its hash and returns the JSON token payload.

#### Path arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `hash` | `string` | Yes | Git blob hash of the file to tokenize |

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
| `leftHash` | `string` | Yes | Git blob hash of the left-hand file |
| `rightHash` | `string` | Yes | Git blob hash of the right-hand file |

#### Success response

Status: `200 OK`

Response body:

- Parsed JSON emitted by `difft --display json`

#### Error response

| Field | Type | Description |
| --- | --- | --- |
| `error` | `string` | Error message |

Common statuses:

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
