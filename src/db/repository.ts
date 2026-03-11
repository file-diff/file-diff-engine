import type { DatabaseClient } from "./database";
import { FileRecord, JobInfo, JobStatus } from "../types";
import {createLogger} from "../utils/logger";
import { getCommitShort } from "../utils/commit";

const logger = createLogger("repository");

export interface FileLookupRecord {
  jobId: string;
  fileName: string;
  fileDiskPath: string;
  fileHash: string;
}

export class JobRepository {
  constructor(private db: DatabaseClient) {}

  async createJob(id: string, repo: string, commit: string): Promise<void> {
    await this.db.query(
      `INSERT INTO jobs (id, repo, commit, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'waiting', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [id, repo, commit]
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
      commit: row.commit as string,
      commitShort: getCommitShort(row.commit as string),
      status: row.status as JobStatus,
      progress: Number(row.progress),
      totalFiles: Number(row.total_files),
      processedFiles: Number(row.processed_files),
      error: (row.error as string | null) ?? undefined,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
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
          `INSERT INTO files (job_id, file_type, file_name, file_disk_path, file_size, file_update_date, file_last_commit, file_git_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            jobId,
            file.file_type,
            file.file_name,
            file.file_disk_path ?? file.file_name,
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
           file_disk_path = $2,
           file_size = $3,
           file_update_date = $4,
           file_last_commit = $5,
           file_git_hash = $6
       WHERE job_id = $7 AND file_name = $8`,
      [
        file.file_type,
        file.file_disk_path ?? file.file_name,
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

  async getFileByHash(
    jobId: string,
    hash: string
  ): Promise<FileLookupRecord | undefined> {
    const result = await this.db.query(
      `SELECT job_id, file_name, file_disk_path, file_git_hash
       FROM files
       WHERE job_id = $1 AND file_git_hash = $2
       ORDER BY id ASC
       LIMIT 1`,
      [jobId, hash]
    );
    const row = result.rows[0] as
      | {
          job_id: string;
          file_name: string;
          file_disk_path: string;
          file_git_hash: string;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      jobId: row.job_id,
      fileName: row.file_name,
      fileDiskPath: row.file_disk_path,
      fileHash: row.file_git_hash,
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
