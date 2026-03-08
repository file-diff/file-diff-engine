# file-diff-engine

A TypeScript backend service that uses **BullMQ** to process GitHub repositories. Submit a repo + tag/commit, and the service downloads the files and indexes metadata you can query via a REST API.

## Features

- **Job-based processing** – submit a GitHub repository and git ref (tag, branch, or commit SHA) for asynchronous processing via BullMQ.
- **File metadata** – for every file/directory the service records:
  | Field | Description |
  |---|---|
  | `file_type` | `d` – directory, `t` – text file, `b` – binary file, `x` – executable file, `s` – symlink |
  | `file_name` | Path relative to the repository root |
  | `file_size` | Size in bytes (0 for directories) |
  | `file_update_date` | ISO-8601 date of the last git commit that touched the file |
  | `file_last_commit` | SHA of the last commit that touched the file |
  | `file_git_hash` | Git blob hash of the file content (empty for directories) |
- **Progress tracking** – query a job at any time to see how many files have been processed.
- **PostgreSQL storage** – durable persistence for jobs and indexed files.

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | ≥ 18 |
| Redis | ≥ 6 (required by BullMQ) |
| PostgreSQL | ≥ 16 |
| Git | any recent version |

## Quick Start

```bash
# Start local development services (Postgres + Redis)
docker compose up -d

# Install dependencies
npm install

# Build
npm run build

# Start the server
npm start
```

The Docker Compose configuration exposes a ready-to-use local PostgreSQL instance:

- host: `127.0.0.1`
- port: `5432`
- database: `file_diff_engine`
- user: `postgres`
- password: `postgres`

To stop the development services:

```bash
docker compose down
```

## Configuration

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `12986` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server bind address |
| `ADDR` | `0.0.0.0` | Legacy alias for `HOST` |
| `REDIS_HOST` | `127.0.0.1` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `DATABASE_URL` | unset | Full PostgreSQL connection string; overrides individual DB settings |
| `DB_HOST` | `127.0.0.1` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `file_diff_engine` | PostgreSQL database name |
| `DB_USER` | `postgres` | PostgreSQL user |
| `DB_PASSWORD` | `postgres` | PostgreSQL password |

## API

### Create a processing job

```
POST /api/jobs
Content-Type: application/json

{ "repo": "owner/repo", "ref": "v1.0.0" }
```

**Response** `201 Created`

```json
{ "id": "uuid", "status": "waiting" }
```

### Query job progress

```
GET /api/jobs/:id
```

**Response** `200 OK`

```json
{
  "id": "uuid",
  "repo": "owner/repo",
  "ref": "v1.0.0",
  "status": "active",
  "progress": 42.5,
  "total_files": 200,
  "processed_files": 85,
  "created_at": "2024-01-01T00:00:00",
  "updated_at": "2024-01-01T00:01:00"
}
```

### Query processed files

```
GET /api/jobs/:id/files
```

**Response** `200 OK`

```json
{
  "job_id": "uuid",
  "status": "completed",
  "progress": 100,
  "files": [
    {
      "file_type": "t",
      "file_name": "src/index.ts",
      "file_size": 1234,
      "file_update_date": "2024-01-01T12:00:00+00:00",
      "file_last_commit": "abc123def456",
      "file_git_hash": "557db03de997c86a4a028e1ebd3a1ceb225be238"
    }
  ]
}
```

### Health check

```
GET /health
```

The API uses permissive CORS by default so it can be called from a frontend hosted on a different domain.

## Development

```bash
# Run tests
npm test

# Watch mode
npm run test:watch

# TypeScript watch
npm run dev
```

## Architecture

```
src/
├── app.ts                  # Fastify app factory
├── server.ts               # Entry point – starts API + worker
├── types/index.ts          # Shared TypeScript interfaces
├── db/
│   ├── database.ts         # PostgreSQL initialisation & schema
│   └── repository.ts       # Data-access layer (jobs + files)
├── routes/
│   └── jobs.ts             # REST endpoints
├── services/
│   ├── queue.ts            # BullMQ queue setup
│   └── repoProcessor.ts   # Clone repo, walk files, compute metadata
├── workers/
│   └── repoWorker.ts       # BullMQ worker
└── __tests__/              # Vitest tests
```
