# file-diff-engine

A TypeScript backend service that uses **BullMQ** to process GitHub repositories. Submit a repo + tag/commit, and the service downloads the files and indexes metadata you can query via a REST API.

## Features

- **Job-based processing** – submit a GitHub repository and git ref (tag, branch, or commit SHA) for asynchronous processing via BullMQ.
- **File metadata** – for every file/directory the service records:
  | Field | Description |
  |---|---|
  | `file_type` | `d` – directory, `t` – text file, `b` – binary file |
  | `file_name` | Path relative to the repository root |
  | `file_size` | Size in bytes (0 for directories) |
  | `file_update_date` | ISO-8601 date of the last git commit that touched the file |
  | `file_last_commit` | SHA of the last commit that touched the file |
  | `file_sha256_hash` | SHA-256 hex digest of the file content (empty for directories) |
- **Progress tracking** – query a job at any time to see how many files have been processed.
- **SQLite storage** – lightweight, zero-configuration persistence.

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | ≥ 18 |
| Redis | ≥ 6 (required by BullMQ) |
| Git | any recent version |

## Quick Start

```bash
# Start Redis (Docker Compose)
docker compose up -d redis

# Install dependencies
npm install

# Build
npm run build

# Start the server (Redis must be running on localhost:6379)
npm start
```

To stop Redis:

```bash
docker compose down
```

## Configuration

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `REDIS_HOST` | `127.0.0.1` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `DATA_DIR` | `./data` | Directory for the SQLite database |

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
      "file_sha256_hash": "e3b0c44298fc..."
    }
  ]
}
```

### Health check

```
GET /health
```

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
├── app.ts                  # Express app factory
├── server.ts               # Entry point – starts API + worker
├── types/index.ts          # Shared TypeScript interfaces
├── db/
│   ├── database.ts         # SQLite initialisation & schema
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
