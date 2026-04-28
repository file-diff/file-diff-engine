import { Pool, type PoolConfig } from "pg";
import {createLogger} from "../utils/logger";

const logger = createLogger("pg-pool");

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

  const postgresPass = process.env.POSTGRES_PASSWORD || "postgres";
  if (postgresPass == "postgres") {
    logger.warn(
      "Warning: Using default PostgresSQL password. This is not recommended for production environments."
    );
  }

  return new Pool({
    ...baseConfig,
    host: process.env.POSTGRES_DB_HOST || "127.0.0.1",
    port: parseInt(process.env.POSTGRES_DB_PORT || "5432"),
    database: process.env.POSTGRES_DB || "file_diff_engine",
    user: process.env.POSTGRES_USER || "postgres",
    password: postgresPass,
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
  await db.query("BEGIN");
  try {
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

      CREATE TABLE IF NOT EXISTS agent_task_jobs (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'waiting',
        github_task_id TEXT,
        task_status TEXT,
        branch_name TEXT,
        base_ref TEXT,
        model TEXT,
        pull_request_url TEXT,
        pull_request_number INTEGER,
        output TEXT,
        task_delay_ms INTEGER NOT NULL DEFAULT 0,
        scheduled_at TIMESTAMPTZ,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE files
      ADD COLUMN IF NOT EXISTS file_disk_path TEXT NOT NULL DEFAULT '';

      -- Migration safety for existing databases created before task-tracking columns existed.
      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS github_task_id TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS task_status TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS branch_name TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS base_ref TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS model TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS pull_request_url TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS pull_request_number INTEGER;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS output TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS task_delay_ms INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;

      UPDATE files
      SET file_disk_path = file_name
      WHERE file_disk_path = '';

      CREATE INDEX IF NOT EXISTS idx_files_job_id ON files(job_id);
      CREATE INDEX IF NOT EXISTS idx_files_job_id_hash ON files(job_id, file_git_hash);
      CREATE INDEX IF NOT EXISTS idx_agent_task_jobs_status ON agent_task_jobs(status);
    `);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
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
