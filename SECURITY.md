# Security and endpoint access

This document lists every HTTP endpoint currently implemented by the service and whether it is public or requires a bearer token.

## Access rules

- **Public**: no `Authorization: Bearer <token>` check is enforced by the route.
- **Bearer required**: the route rejects requests unless the configured bearer token is present and matches.
- Some public endpoints still depend on server-side GitHub configuration such as `PUBLIC_GITHUB_TOKEN` for rate limits or upstream API access. That does **not** make them bearer-protected.
- Several bearer-protected routes also accept an optional `githubKey` request field for GitHub API operations. That is separate from the endpoint bearer token.

## Public endpoints

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| GET | `/api/health` | Public | Health check plus backend GitHub rate-limit status |
| GET | `/api/version` | Public | Returns build version |
| GET | `/api/stats` | Public | Returns stored job/file statistics |
| POST | `/api/jobs` | Public | Creates or reuses a repository-processing job |
| GET | `/api/jobs/:id` | Public | Returns job status |
| GET | `/api/jobs/:id/files` | Public | Returns processed file metadata for a job |
| POST | `/api/jobs/resolve` | Public | Resolves a ref to a commit SHA |
| POST | `/api/jobs/pull-request/resolve` | Public | Resolves a GitHub pull request URL to commits |
| POST | `/api/jobs/refs` | Public | Lists refs for a repository |
| POST | `/api/jobs/branches` | Public | Lists branches for a repository |
| POST | `/api/jobs/commits` | Public | Lists recent commits |
| POST | `/api/jobs/commits/graph` | Public | Returns commit graph items |
| GET | `/api/jobs/organizations/:organization/repositories` | Public | Lists organization repositories |
| GET | `/api/jobs/cache` | Public | Lists on-disk git cache folders |
| GET | `/api/jobs/create-task/:id` | Public | Returns locally tracked Copilot task job status |
| GET | `/api/commit/:id/files` | Public | Returns files for the latest job matching a commit |
| GET | `/api/commit/:id/grep` | Public | Greps stored text files for a processed commit |
| GET | `/api/jobs/:id/files/hash/:hash/download` | Public | Downloads a file by job id and file hash |
| GET | `/api/jobs/files/hash/:hash/download` | Public | Downloads the first accessible file matching a hash |
| GET | `/api/jobs/files/hash/:hash/tokenize` | Public | Tokenizes a file by hash with Shiki |
| GET | `/api/jobs/files/hash/:leftHash/diff/:rightHash` | Public | Returns a `difft` JSON diff between two files |

## Bearer-protected endpoints

| Method | Path | Access | Required bearer token |
| --- | --- | --- | --- |
| POST | `/api/jobs/revert-to-commit` | Bearer required | `REVERT_TO_COMMIT_BEARER_TOKEN` |
| POST | `/api/jobs/merge-branch` | Bearer required | `MERGE_BRANCH_BEARER_TOKEN` |
| POST | `/api/jobs/delete-remote-branch` | Bearer required | `GITHUB_OPERATIONS_BEARER_TOKEN`, falling back to `REVERT_TO_COMMIT_BEARER_TOKEN` |
| POST | `/api/jobs/branch-permissions` | Bearer required | `GITHUB_OPERATIONS_BEARER_TOKEN`, falling back to `REVERT_TO_COMMIT_BEARER_TOKEN` |
| POST | `/api/jobs/pull-request/ready` | Bearer required | `GITHUB_OPERATIONS_BEARER_TOKEN`, falling back to `REVERT_TO_COMMIT_BEARER_TOKEN` |
| POST | `/api/jobs/pull-request/merge` | Bearer required | `GITHUB_OPERATIONS_BEARER_TOKEN`, falling back to `REVERT_TO_COMMIT_BEARER_TOKEN` |
| POST | `/api/jobs/pull-request/open` | Bearer required | `GITHUB_OPERATIONS_BEARER_TOKEN`, falling back to `REVERT_TO_COMMIT_BEARER_TOKEN` |
| POST | `/api/jobs/create-task` | Bearer required | `CREATE_TASK_BEARER_TOKEN` |
| GET | `/api/agents/repos/:owner/:repo/tasks` | Bearer required | `CREATE_TASK_BEARER_TOKEN` |
| GET | `/api/agents/repos/:owner/:repo/tasks/:task_id` | Bearer required | `CREATE_TASK_BEARER_TOKEN` |
| POST | `/api/agents/repos/:owner/:repo/tasks/:task_id/archive` | Bearer required | `CREATE_TASK_BEARER_TOKEN` |
| GET | `/api/api/agents/tasks` | Bearer required | `CREATE_TASK_BEARER_TOKEN` |

`/api/api/agents/tasks` is included because that is the route path currently registered in code.

## Source of truth

This list was verified against the currently implemented routes in:

- `/home/runner/work/file-diff-engine/file-diff-engine/src/app.ts`
- `/home/runner/work/file-diff-engine/file-diff-engine/src/routes/jobs/discoveryRoutes.ts`
- `/home/runner/work/file-diff-engine/file-diff-engine/src/routes/jobs/jobManagementRoutes.ts`
- `/home/runner/work/file-diff-engine/file-diff-engine/src/routes/jobs/downloadRoutes.ts`
- `/home/runner/work/file-diff-engine/file-diff-engine/src/routes/taskRoutes.ts`

It is implementation-based and therefore includes endpoints that are not yet listed in `API.md`.
