import { Pool, type PoolConfig } from "pg";

export interface DatabaseConfig {
  pool?: Pool;
}

export type DatabaseClient = Pool;

function createPool(): Pool {
  const baseConfig: PoolConfig = {
    idleTimeoutMillis: parseNonNegativeInteger(
      process.env.DB_IDLE_TIMEOUT_MS,
      0
    ),
  };

  if (process.env.DATABASE_URL) {
    return new Pool({
      ...baseConfig,
      connectionString: process.env.DATABASE_URL,
    });
  }

  return new Pool({
    ...baseConfig,
    host: process.env.DB_HOST || "127.0.0.1",
    port: parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME || "file_diff_engine",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "postgres",
  });
}

export async function getDatabase(
  config?: DatabaseConfig
): Promise<DatabaseClient> {
  const db = config?.pool ?? createPool();
  await initSchema(db);
  return db;
}

async function initSchema(db: DatabaseClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      commit TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      progress DOUBLE PRECISION NOT NULL DEFAULT 0,
      total_files INTEGER NOT NULL DEFAULT 0,
      processed_files INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS files (
      id BIGSERIAL PRIMARY KEY,
      job_id TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_disk_path TEXT NOT NULL DEFAULT '',
      file_size INTEGER NOT NULL DEFAULT 0,
      file_update_date TEXT NOT NULL DEFAULT '',
      file_last_commit TEXT NOT NULL DEFAULT '',
      file_git_hash TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

    ALTER TABLE files
    ADD COLUMN IF NOT EXISTS file_disk_path TEXT NOT NULL DEFAULT '';

    UPDATE files
    SET file_disk_path = file_name
    WHERE file_disk_path = '';

    CREATE INDEX IF NOT EXISTS idx_files_job_id ON files(job_id);
    CREATE INDEX IF NOT EXISTS idx_files_job_id_hash ON files(job_id, file_git_hash);
  `);
}

function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number
): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}
