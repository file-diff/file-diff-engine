# DeepSeek + opencode task setup

This service can start opencode-backed agent tasks through `POST /api/jobs/create-task` and expose task progress/output through `GET /api/jobs/create-task/:id`.

## Required configuration

Set these environment variables for the API container:

| Variable | Required | Description |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | Yes | DeepSeek API key used by opencode. A per-request `deepseek_api_key` can override this, but the environment variable is preferred. |
| `PRIVATE_GITHUB_TOKEN` or `PUBLIC_GITHUB_TOKEN` | Yes | GitHub token used to clone the repo, create/push branches, create the initial commit, and open the pull request. |
| `ADMIN_BEARER_TOKEN` | Yes | Bearer token required to start/cancel tasks. |
| `VIEWER_BEARER_TOKEN` | Yes | Bearer token required to read task status/output. The admin token is also accepted by viewer endpoints. |
| `OPENCODE_BIN` | No | opencode executable path. Defaults to `opencode`. |
| `OPENCODE_TIMEOUT_MS` | No | Maximum opencode runtime per task. Defaults to `7200000` (2 hours). |
| `OPENCODE_OUTPUT_LIMIT` | No | Maximum captured opencode stdout/stderr bytes. Defaults to `1000000`. |
| `GIT_AUTHOR_NAME` | No | Git author name for generated commits. |
| `GIT_AUTHOR_EMAIL` | No | Git author email for generated commits. |

Docker images install `opencode-ai@1.14.28` and expose these variables in `docker-compose.yml`.

## Supported models

The task API defaults to:

- `deepseek-v4-flash`

You can explicitly choose:

- `deepseek-v4-flash`
- `deepseek-v4-pro`

## Start a task

```bash
curl -X POST http://127.0.0.1:12986/api/jobs/create-task \
  -H "Authorization: Bearer $ADMIN_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "file-diff/file-diff-engine",
    "base_ref": "main",
    "problem_statement": "Implement the requested change",
    "model": "deepseek-v4-flash"
  }'
```

Response:

```json
{
  "id": "task-job-id"
}
```

Optional request fields:

- `model`: `deepseek-v4-flash` or `deepseek-v4-pro`.
- `task_delay_ms`: delay before the worker starts.
- `githubKey`: GitHub token override for this task.
- `deepseek_api_key`: DeepSeek key override for this task.

## Check progress and output

```bash
curl http://127.0.0.1:12986/api/jobs/create-task/task-job-id \
  -H "Authorization: Bearer $VIEWER_BEARER_TOKEN"
```

Important response fields:

- `status`: local worker status: `waiting`, `active`, `completed`, `failed`, or `canceled`.
- `taskStatus`: high-level task phase, for example `preparing`, `working`, or `completed`.
- `branch`: generated task branch after preparation succeeds.
- `pullRequestUrl` / `pullRequestNumber`: initialized draft pull request.
- `output`: captured opencode stdout/stderr or failure message.
- `error`: failure details when `status` is `failed`.

## How it works

1. The API validates the repository, base branch, problem statement, model, and auth token.
2. A local task record is created and queued in Redis.
3. The worker clones the repository, checks out `base_ref`, creates a new `fde-agent/...` branch, and creates an empty initialization commit containing the task text.
4. The branch is pushed and a draft pull request is opened before opencode starts.
5. opencode is launched on the prepared branch with DeepSeek credentials. The prompt tells opencode that the branch and pull request already exist and instructs it to commit and push progress to that branch.
6. When opencode exits, the worker captures output, commits/pushes any remaining uncommitted changes, and marks the task `completed`; failures are stored as `failed`.

## Docker Compose example

Create a local `.env` file:

```env
DEEPSEEK_API_KEY=your-deepseek-key
PRIVATE_GITHUB_TOKEN=github-token-with-repo-access
ADMIN_BEARER_TOKEN=choose-an-admin-token
VIEWER_BEARER_TOKEN=choose-a-viewer-token
```

Then run:

```bash
docker compose up --build
```
