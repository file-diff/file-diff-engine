import { Pool, type PoolConfig } from "pg";
import {createLogger} from "../utils/logger";

const logger = createLogger("pg-pool");

export interface DatabaseConfig {
  pool?: Pool;
}

export type DatabaseClient = Pool;

const RESET_AGENT_TASK_JOBS_MIGRATION_ID =
  "2026-05-21-reset-agent-task-jobs";

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
    await ensureMigrationLedger(db);
    await runResetAgentTaskJobsMigration(db);
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
        branch_name TEXT,
        task_runner TEXT,
        base_ref TEXT,
        model TEXT,
        reasoning_effort TEXT,
        reasoning_summary TEXT,
        verbosity TEXT,
        codex_web_search BOOLEAN,
        previous_session TEXT,
        pull_request_completion_mode TEXT,
        pull_request_url TEXT,
        pull_request_number INTEGER,
        output TEXT,
        stdout TEXT,
        stderr TEXT,
        opencode_session_id TEXT,
        opencode_session_export TEXT,
        codex_session_id TEXT,
        codex_session_file_path TEXT,
        codex_session_export TEXT,
        task_delay_ms INTEGER NOT NULL DEFAULT 0,
        scheduled_at TIMESTAMPTZ,
        cancel_requested_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE files
      ADD COLUMN IF NOT EXISTS file_disk_path TEXT NOT NULL DEFAULT '';

      -- Migration safety for existing databases created before task-tracking columns existed.
      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS branch_name TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS task_runner TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS base_ref TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS model TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS reasoning_effort TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS reasoning_summary TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS verbosity TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS codex_web_search BOOLEAN;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS previous_session TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS pull_request_completion_mode TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS pull_request_url TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS pull_request_number INTEGER;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS output TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS stdout TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS stderr TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS opencode_session_id TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS opencode_session_export TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS codex_session_id TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS codex_session_file_path TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS codex_session_export TEXT;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS task_delay_ms INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;

      ALTER TABLE agent_task_jobs
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

      UPDATE files
      SET file_disk_path = file_name
      WHERE file_disk_path = '';

      CREATE INDEX IF NOT EXISTS idx_files_job_id ON files(job_id);
      CREATE INDEX IF NOT EXISTS idx_files_job_id_hash ON files(job_id, file_git_hash);
      CREATE INDEX IF NOT EXISTS idx_agent_task_jobs_status ON agent_task_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_agent_task_jobs_codex_session_id ON agent_task_jobs(codex_session_id);
    `);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

async function ensureMigrationLedger(db: DatabaseClient): Promise<void> {
  if (await tableExists(db, "schema_migrations")) {
    return;
  }

  await db.query(`
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function runResetAgentTaskJobsMigration(
  db: DatabaseClient
): Promise<void> {
  const result = await db.query(
    "SELECT 1 FROM schema_migrations WHERE id = $1",
    [RESET_AGENT_TASK_JOBS_MIGRATION_ID]
  );
  if (result.rowCount && result.rowCount > 0) {
    return;
  }

  await db.query("DROP TABLE IF EXISTS agent_task_jobs");
  await db.query("DROP INDEX IF EXISTS agent_task_jobs_pkey");
  await db.query("INSERT INTO schema_migrations (id) VALUES ($1)", [
    RESET_AGENT_TASK_JOBS_MIGRATION_ID,
  ]);
}

async function tableExists(
  db: DatabaseClient,
  tableName: string
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_name = $1`,
    [tableName]
  );
  return Boolean(result.rowCount && result.rowCount > 0);
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
