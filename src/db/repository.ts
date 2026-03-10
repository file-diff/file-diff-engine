import type { DatabaseClient } from "./database";
import { FileRecord, JobInfo, JobStatus } from "../types";
import {createLogger} from "../utils/logger";
import { getCommitShort } from "../utils/commit";
import { normalizeJobRef } from "../utils/jobIdentity";

const logger = createLogger("repository");

export class JobRepository {
  constructor(private db: DatabaseClient) {}

  async createJob(
    id: string,
    repo: string,
    commit: string,
    ref?: string,
    permalink?: string
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO jobs (id, repo, ref, commit, permalink, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'waiting', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [id, repo, normalizeJobRef(ref) ?? null, commit, permalink ?? ""]
    );
  }

  async findJob(repo: string, commit: string): Promise<JobInfo | undefined> {
    const result = await this.db.query(
      "SELECT * FROM jobs WHERE repo = $1 AND commit = $2 ORDER BY created_at ASC LIMIT 1",
      [repo, commit]
    );
    return this.toJobInfo(result.rows[0] as Record<string, unknown> | undefined);
  }

  async getJob(id: string): Promise<JobInfo | undefined> {
    const result = await this.db.query("SELECT * FROM jobs WHERE id = $1", [id]);
    return this.toJobInfo(result.rows[0] as Record<string, unknown> | undefined);
  }

  async updateJobPermalink(
    id: string,
    ref: string | undefined,
    permalink: string
  ): Promise<void> {
    await this.db.query(
      `UPDATE jobs
       SET ref = COALESCE(ref, $1),
           permalink = CASE
             WHEN permalink = '' OR (ref IS NULL AND $1 IS NOT NULL) THEN $2
             ELSE permalink
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [normalizeJobRef(ref) ?? null, permalink, id]
    );
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
          `INSERT INTO files (job_id, file_type, file_name, file_size, file_update_date, file_last_commit, file_git_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            jobId,
            file.file_type,
            file.file_name,
            file.file_size,
            file.file_update_date,
            file.file_last_commit,
            file.file_git_hash,
          ]
        );
      }
      await client.query("COMMIT");
      logger.info("Inserted files successfully", { jobId, fileCount: files.length });
    } catch (error) {
      logger.error("Failed to insert files, rolling back transaction + error", { jobId, error });
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateFile(jobId: string, file: FileRecord): Promise<void> {
    const result = await this.db.query(
      `UPDATE files
       SET file_type = $1,
           file_size = $2,
           file_update_date = $3,
           file_last_commit = $4,
           file_git_hash = $5
       WHERE job_id = $6 AND file_name = $7`,
      [
        file.file_type,
        file.file_size,
        file.file_update_date,
        file.file_last_commit,
        file.file_git_hash,
        jobId,
        file.file_name,
      ]
    );

    if (result.rowCount === 0) {
      throw new Error(
        `Failed to update file metadata for job '${jobId}' and path '${file.file_name}'.`
      );
    }
  }

  async getFiles(jobId: string): Promise<FileRecord[]> {
    const result = await this.db.query(
      `SELECT file_type, file_name, file_size, file_update_date, file_last_commit, file_git_hash
       FROM files WHERE job_id = $1 ORDER BY id ASC`,
      [jobId]
    );
    return result.rows as FileRecord[];
  }

  private toJobInfo(row: Record<string, unknown> | undefined): JobInfo | undefined {
    if (!row) {
      return undefined;
    }

    return {
      id: row.id as string,
      repo: row.repo as string,
      ref: (row.ref as string | null) ?? undefined,
      commit: row.commit as string,
      commitShort: getCommitShort(row.commit as string),
      permalink: (row.permalink as string | null) ?? "",
      status: row.status as JobStatus,
      progress: Number(row.progress),
      totalFiles: Number(row.total_files),
      processedFiles: Number(row.processed_files),
      error: (row.error as string | null) ?? undefined,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
    };
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
