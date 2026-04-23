# Using the Grep Endpoint (Frontend Integration Guide)

This document explains how the frontend should call the file-diff-engine grep endpoint. It exists because frontend integrations have been failing with `404 Job not found.` responses; the cause in every reported case has been a misunderstanding of the endpoint's prerequisites or its URL/parameter shape.

The authoritative reference is [`API.md`](./API.md#get-apicommitidgrep). This document is a focused how-to for the grep endpoint specifically.

## TL;DR

- The endpoint is **`GET /api/commit/:id/grep?query=<text>`**.
- `:id` is a **commit SHA** (full 40-character hex, or a short prefix of at least 2 characters). It is **not** a free-form job ID, branch name, ref, repo name, or PR number.
- The endpoint does **not** create a job. A job for the commit must already exist (created via `POST /api/jobs`) and have processed files on disk. If no job exists for the commit, the endpoint returns `404 Job not found.`
- `query` is a **plain-text substring**, not a regex or glob. It must be URL-encoded.
- The endpoint requires the viewer bearer token: `Authorization: Bearer <VIEWER_BEARER_TOKEN>`.
- Only text (`t`) and executable (`x`) files are searched. Binary (`b`), directory (`d`), and symlink (`s`) entries are skipped.

## Endpoint contract

```
GET /api/commit/:id/grep?query=<text>
Authorization: Bearer <VIEWER_BEARER_TOKEN>
```

### Path parameters

| Name | Required | Description |
| --- | --- | --- |
| `id` | Yes | Commit SHA. Full 40-character hexadecimal SHA, or a short prefix of **at least 2 characters**. Short prefixes that match more than one distinct commit return `400`. |

### Query parameters

| Name | Required | Description |
| --- | --- | --- |
| `query` | Yes | Plain-text substring to search for. Must be URL-encoded. Whitespace-only values are rejected with `400`. The match is case-sensitive and not interpreted as a regular expression. |

### Success response (`200 OK`)

```json
{
  "jobId": "0123456789abcdef0123456789abcdef01234567",
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

Notes:

- `status` reflects the **current** status of the underlying job (`waiting`, `active`, `completed`, or `failed`). It is **not** guaranteed to be `completed`. Frontends should not assume `status === "completed"` and should display whatever `status`/`progress` is returned.
- `matches` is an array of `{ path, lineNumber, line }`. `path` is the file path relative to the repository root. `lineNumber` is 1-based. `line` is the raw matching line (without a trailing newline).
- `matches` may be empty (`[]`) when the job exists and has files but nothing matches the query — this is a successful `200`, not a `404`.

### Error responses

| Status | When | Body |
| --- | --- | --- |
| `400 Bad Request` | `query` is missing or empty after trimming | `{ "error": "Query parameter 'query' is required." }` |
| `400 Bad Request` | A short commit prefix matches more than one distinct commit | `{ "error": "<ambiguity message>" }` |
| `404 Not Found` | No job exists for the given commit | `{ "error": "Job not found." }` |
| `500 Internal Server Error` | A processed file is missing or unreadable on disk | `{ "error": "<details>" }` |

## Prerequisites: why you might be getting `404 Job not found.`

The grep endpoint is a **read-only** lookup. It will not create or trigger a job for you. Before grep can return results, the following must already be true:

1. A job has been created for the commit, via `POST /api/jobs` with the `repo` (`owner/repo`) and the full 40-character `commit` SHA. See [`API.md` → `POST /api/jobs`](./API.md#post-apijobs).
2. The processing worker has run far enough on that job to write file content to disk. (`status` may still be `waiting` or `active` — that is fine, grep will search whatever has been written so far — but if no files have been written yet, `matches` will simply be empty.)

Recommended frontend flow:

```text
1. POST /api/jobs           { repo, commit }      → returns { id, status }
2. (optional) poll GET /api/jobs/:id              → wait for status === "completed"
3. GET /api/commit/:id/grep?query=<encoded text>  → use the same commit SHA from step 1
```

If you skip step 1 and call grep directly with a commit SHA the engine has never seen, you will get `404 Job not found.` This is by design.

## Common mistakes that produce `404 Job not found.`

The frontend has hit each of the following at least once. Check this list before reporting a backend bug.

1. **Calling grep before creating a job.** The grep endpoint never creates jobs. POST `/api/jobs` first.
2. **Passing a non-SHA value as `:id`.** `:id` must be a hex commit SHA (or a ≥2-character hex prefix of one). Branch names (`main`), tag names (`v1.2.3`), repo names (`owner/repo`), PR numbers, and synthetic IDs will all return `404`.
3. **Using the wrong URL.** The endpoint lives under `/api/commit/...`, **not** under `/api/jobs/...`. There is no `GET /api/jobs/:id/grep` route — calling that path will return a 404 from the router (no JSON body, or a Fastify default not-found body), which can be mistaken for "job not found".
4. **Using a short prefix that matches no stored commit.** A 7-character prefix is fine *if* a job exists for a commit starting with those characters. Otherwise you get `404`. Prefer the full 40-character SHA when you have it.
5. **Using a short prefix that matches multiple commits.** This returns `400` (not `404`) with an ambiguity message. Resolve by sending the full SHA.
6. **Missing or wrong bearer token.** Without `Authorization: Bearer <VIEWER_BEARER_TOKEN>` you will get `401`/`403` from the auth pre-handler, not `404` — but it is still a common cause of "this endpoint doesn't work" reports. See [`SECURITY.md`](./SECURITY.md) for the token mapping.

## Common mistakes that produce wrong/empty results (not `404`)

1. **Treating `query` as a regex or glob.** It is a literal substring. `.*foo`, `foo|bar`, and `**/foo` are all matched literally.
2. **Forgetting to URL-encode `query`.** Spaces, `&`, `?`, `#`, and `+` must be percent-encoded. Use `encodeURIComponent` (browser/Node) when building the URL.
3. **Expecting binary files to be searched.** Files with type `b` (binary), `d` (directory), and `s` (symlink) are skipped. Only `t` (text) and `x` (executable) are scanned. If a match should have been found in a file you can see in `/api/commit/:id/files`, check its `t` field first.
4. **Case sensitivity.** Matching is case-sensitive. Search `TODO` and `todo` separately if needed.
5. **Multi-line patterns.** Matching is line-by-line. A query containing a newline will not match anything; split it into separate queries.

## Frontend examples

### `fetch` (browser / Node 18+)

```js
async function grepCommit({ baseUrl, commit, query, viewerToken }) {
  const url = new URL(`/api/commit/${encodeURIComponent(commit)}/grep`, baseUrl);
  url.searchParams.set("query", query);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${viewerToken}` },
  });

  if (res.status === 404) {
    // Most likely cause: no job has been created for `commit` yet.
    // Trigger one with POST /api/jobs and retry once the job has files.
    throw new Error(`No job for commit ${commit}. Create one with POST /api/jobs first.`);
  }

  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`Grep failed (${res.status}): ${error}`);
  }

  return res.json(); // { jobId, commit, commitShort, status, progress, query, matches }
}
```

### `curl`

```bash
curl -X GET \
  -H "Authorization: Bearer $VIEWER_BEARER_TOKEN" \
  --get \
  --data-urlencode 'query=TODO' \
  "https://your-host.example.com/api/commit/0123456789abcdef0123456789abcdef01234567/grep"
```

## Related endpoints

- [`POST /api/jobs`](./API.md#post-apijobs) — create or reuse the job whose files grep will search.
- [`GET /api/jobs/:id`](./API.md#get-apijobsid) — poll job `status` / `progress` before grep.
- [`GET /api/commit/:id/files`](./API.md#get-apicommitidfiles) — list the files available for a commit so you can verify which entries grep will/won't search (based on the `t` field).
