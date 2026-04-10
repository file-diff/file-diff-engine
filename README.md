# File Diff Engine

https://filediff.org

API reference: [API.md](./API.md)

## Configuration

- `REQUEST_DELAY_MS`: Adds a delay before every API request is handled. Defaults to `0` (disabled). Set `REQUEST_DELAY_MS=500` to simulate 500ms of latency during development.
- `PRIVATE_GITHUB_TOKEN`: Optional GitHub token used by the `revertToCommit` CLI by default for GitHub git operations and pull request creation.
- `PUBLIC_GITHUB_TOKEN`: Optional GitHub token used to authorize GitHub API requests and Git HTTPS operations so the service can use higher authenticated rate limits.
- `AGENT_TASK_POLL_INTERVAL_MS`: Polling delay for monitoring queued GitHub Copilot agent tasks after they are created. Defaults to `5000`.
- `AGENT_TASK_MAX_POLL_DURATION_MS`: Maximum time to keep polling a GitHub Copilot agent task before marking the local job as failed. Defaults to `1800000` (30 minutes).
- `SLACK_WEBHOOK_URL`: Optional incoming Slack webhook used to send agent-task terminal-state notifications with the task status, link, duration, branch name, failure details, and any pull request actions taken when available.
- `ADMIN_BEARER_TOKEN`: Required bearer token for every admin endpoint listed in [`SECURITY.md`](./SECURITY.md). It is also accepted on viewer endpoints.
- `VIEWER_BEARER_TOKEN`: Required bearer token for every viewer endpoint listed in [`SECURITY.md`](./SECURITY.md).

## CLI

After building the project, you can run the revert helper from the CLI:

```bash
revertToCommit --repo owner/repo --commit <40-char-sha> [--branch main]
```

## Storage tree

The worker stores repository data under `TMP_DIR` (or the relative `tmp/` directory under the service working directory when `TMP_DIR` is not set).

Each job gets its own working directory:

```text
TMP_DIR/
├── fde-<jobId>/
│   └── tree/
│       ├── README.md
│       ├── src/
│       └── ...
└── repo-cache/
    └── <sha256-of-repository-url>/
        └── .git/
```

### How repositories are cloned

For a job with id `<jobId>`, the worker creates:

- `TMP_DIR/fde-<jobId>/` as the job workspace
- `TMP_DIR/fde-<jobId>/tree/` as the checked out repository tree used by file download and diff endpoints

To avoid cloning the same repository from scratch for every job, the service also keeps a shared cache at:

- `TMP_DIR/repo-cache/<sha256-of-repository-url>/`

The processing flow is:

1. Build the repository URL from the requested `owner/repo`.
2. Hash that URL and use it as the cache directory name.
3. If the cache does not exist yet, run `git clone --no-checkout <repoUrl> <cacheDir>` so the cache keeps Git metadata without checking out a working tree there.
4. Run `git fetch --depth=1 origin <commit>` inside the cache to fetch the requested commit.
5. Copy the cache directory to `TMP_DIR/fde-<jobId>/tree/`.
6. Run `git checkout --detach FETCH_HEAD` inside `tree/` so the job works with the exact requested commit.

As a result:

- `repo-cache/` is reused across jobs for the same repository URL
- `tree/` is job-specific and contains the files that the API serves from disk
- stored file paths are relative to the `tree/` directory
- jobs resolve refs to full commit SHAs first, so the worker fetches/checks out an exact commit instead of trusting a moving branch tip
- once a commit has been fetched into `repo-cache/`, later force-pushes or branch resets do not rewrite that cached object data
- the shared cache stores Git metadata only, not a checked-out working tree
- every job gets its own detached checkout, so weird remote-side changes cannot mutate an already-prepared job tree
