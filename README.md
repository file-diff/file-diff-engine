# File Diff Engine

https://filediff.org

API reference: [API.md](./API.md)

## Storage tree

The worker stores repository data under `TMP_DIR` (or `tmp` when `TMP_DIR` is not set).

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
3. If the cache does not exist yet, run `git clone --no-checkout <repoUrl> <cacheDir>`.
4. Run `git fetch --depth=1 origin <commit>` inside the cache to fetch the requested commit.
5. Copy the cache directory to `TMP_DIR/fde-<jobId>/tree/`.
6. Run `git checkout --detach FETCH_HEAD` inside `tree/` so the job works with the exact requested commit.

As a result:

- `repo-cache/` is reused across jobs for the same repository URL
- `tree/` is job-specific and contains the files that the API serves from disk
- stored file paths are relative to the `tree/` directory
