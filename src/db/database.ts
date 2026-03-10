import { Pool } from "pg";

export interface DatabaseConfig {
  pool?: Pool;
}

export type DatabaseClient = Pool;

function createPool(): Pool {
  if (process.env.DATABASE_URL) {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
    });
  }

  return new Pool({
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
      file_size INTEGER NOT NULL DEFAULT 0,
      file_update_date TEXT NOT NULL DEFAULT '',
      file_last_commit TEXT NOT NULL DEFAULT '',
      file_git_hash TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_files_job_id ON files(job_id);
  `);
}
