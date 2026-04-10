# Security and endpoint access

This document lists every HTTP endpoint currently implemented by the service and which bearer token is allowed to access it.

## Access rules

- **Viewer**: the route requires `Authorization: Bearer <token>` and accepts `VIEWER_BEARER_TOKEN`. `ADMIN_BEARER_TOKEN` is also accepted on these endpoints.
- **Admin**: the route requires `Authorization: Bearer <token>` and accepts `ADMIN_BEARER_TOKEN` only.
- Some viewer endpoints still depend on server-side GitHub configuration such as `PUBLIC_GITHUB_TOKEN` for rate limits or upstream API access.
- Several admin endpoints also accept an optional `githubKey` request field for GitHub API operations. That is separate from the endpoint bearer token.

## Viewer endpoints

| Method | Path | Access | Notes |
| --- | --- | --- | --- |
| GET | `/api/health` | Viewer | Health check plus backend GitHub rate-limit status |
| GET | `/api/version` | Viewer | Returns build version |
| GET | `/api/stats` | Viewer | Returns stored job/file statistics |
| POST | `/api/jobs` | Viewer | Creates or reuses a repository-processing job |
| GET | `/api/jobs/:id` | Viewer | Returns job status |
| GET | `/api/jobs/:id/files` | Viewer | Returns processed file metadata for a job |
| POST | `/api/jobs/resolve` | Viewer | Resolves a ref to a commit SHA |
| POST | `/api/jobs/pull-request/resolve` | Viewer | Resolves a GitHub pull request URL to commits |
| POST | `/api/jobs/refs` | Viewer | Lists refs for a repository |
| POST | `/api/jobs/branches` | Viewer | Lists branches for a repository |
| POST | `/api/jobs/commits` | Viewer | Lists recent commits |
| POST | `/api/jobs/commits/graph` | Viewer | Returns commit graph items |
| GET | `/api/jobs/organizations/:organization/repositories` | Viewer | Lists organization repositories |
| GET | `/api/jobs/cache` | Viewer | Lists on-disk git cache folders |
| GET | `/api/jobs/create-task/:id` | Viewer | Returns locally tracked Copilot task job status |
| GET | `/api/commit/:id/files` | Viewer | Returns files for the latest job matching a commit |
| GET | `/api/commit/:id/grep` | Viewer | Greps stored text files for a processed commit |
| GET | `/api/jobs/:id/files/hash/:hash/download` | Viewer | Downloads a file by job id and file hash |
| GET | `/api/jobs/files/hash/:hash/download` | Viewer | Downloads the first accessible file matching a hash |
| GET | `/api/jobs/files/hash/:hash/tokenize` | Viewer | Tokenizes a file by hash with Shiki |
| GET | `/api/jobs/files/hash/:leftHash/diff/:rightHash` | Viewer | Returns a `difft` JSON diff between two files |

## Admin endpoints

| Method | Path | Access | Required bearer token |
| --- | --- | --- | --- |
| POST | `/api/jobs/revert-to-commit` | Admin | `ADMIN_BEARER_TOKEN` |
| POST | `/api/jobs/merge-branch` | Admin | `ADMIN_BEARER_TOKEN` |
| POST | `/api/jobs/delete-remote-branch` | Admin | `ADMIN_BEARER_TOKEN` |
| POST | `/api/jobs/branch-permissions` | Admin | `ADMIN_BEARER_TOKEN` |
| POST | `/api/jobs/pull-request/ready` | Admin | `ADMIN_BEARER_TOKEN` |
| POST | `/api/jobs/pull-request/merge` | Admin | `ADMIN_BEARER_TOKEN` |
| POST | `/api/jobs/pull-request/open` | Admin | `ADMIN_BEARER_TOKEN` |
| POST | `/api/jobs/create-task` | Admin | `ADMIN_BEARER_TOKEN` |
| GET | `/api/agents/repos/:owner/:repo/tasks` | Admin | `ADMIN_BEARER_TOKEN` |
| GET | `/api/agents/repos/:owner/:repo/tasks/:task_id` | Admin | `ADMIN_BEARER_TOKEN` |
| POST | `/api/agents/repos/:owner/:repo/tasks/:task_id/archive` | Admin | `ADMIN_BEARER_TOKEN` |
| GET | `/api/api/agents/tasks` | Admin | `ADMIN_BEARER_TOKEN` |

`/api/api/agents/tasks` is included exactly as implemented today because the route is currently registered with a double `/api` prefix in code.

## Source of truth

This list was verified against the currently implemented routes in:

- `src/app.ts`
- `src/routes/jobs/discoveryRoutes.ts`
- `src/routes/jobs/jobManagementRoutes.ts`
- `src/routes/jobs/downloadRoutes.ts`
- `src/routes/taskRoutes.ts`

It is implementation-based and therefore includes endpoints that are not yet listed in `API.md`.
