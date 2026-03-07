import type { DatabaseClient } from "./database";
import { FileRecord, JobInfo, JobStatus } from "../types";

export class JobRepository {
  constructor(private db: DatabaseClient) {}

  async createJob(id: string, repo: string, ref: string): Promise<void> {
    await this.db.query(
      `INSERT INTO jobs (id, repo, ref, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'waiting', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [id, repo, ref]
    );
  }

  async getJob(id: string): Promise<JobInfo | undefined> {
    const result = await this.db.query("SELECT * FROM jobs WHERE id = $1", [id]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }

    return {
      id: row.id as string,
      repo: row.repo as string,
      ref: row.ref as string,
      status: row.status as JobStatus,
      progress: Number(row.progress),
      total_files: Number(row.total_files),
      processed_files: Number(row.processed_files),
      error: (row.error as string | null) ?? undefined,
      created_at: toIsoString(row.created_at),
      updated_at: toIsoString(row.updated_at),
    };
  }

  async updateJobStatus(
    id: string,
    status: JobStatus,
    error?: string
  ): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = $1, error = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [status, error ?? null, id]
    );
  }

  async updateJobProgress(
    id: string,
    processedFiles: number,
    totalFiles: number
  ): Promise<void> {
    const progress = totalFiles > 0 ? (processedFiles / totalFiles) * 100 : 0;
    await this.db.query(
      `UPDATE jobs SET processed_files = $1, total_files = $2, progress = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4`,
      [processedFiles, totalFiles, progress, id]
    );
  }

  async insertFiles(jobId: string, files: FileRecord[]): Promise<void> {
    if (files.length === 0) {
      return;
    }

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      for (const file of files) {
        await client.query(
          `INSERT INTO files (job_id, file_type, file_name, file_size, file_update_date, file_last_commit, file_sha256_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            jobId,
            file.file_type,
            file.file_name,
            file.file_size,
            file.file_update_date,
            file.file_last_commit,
            file.file_sha256_hash,
          ]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getFiles(jobId: string): Promise<FileRecord[]> {
    const result = await this.db.query(
      `SELECT file_type, file_name, file_size, file_update_date, file_last_commit, file_sha256_hash
       FROM files WHERE job_id = $1 ORDER BY id ASC`,
      [jobId]
    );
    return result.rows as FileRecord[];
  }
}

function toIsoString(value: unknown): string {
  if (value == null) {
    throw new Error("Expected database timestamp value.");
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value);
}
