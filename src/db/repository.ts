import type { DatabaseClient } from "./database";
import {
  AgentTaskJobStatus,
  AgentTaskJobInfo,
  FileRecord,
  JobInfo,
  JobStatus,
  StatsResponse,
} from "../types";
import {createLogger} from "../utils/logger";
import { getCommitShort } from "../utils/commit";

const logger = createLogger("repository");

const FULL_HASH_LENGTH = 40;
const MIN_SHORT_HASH_LENGTH = 2;

export class AmbiguousHashError extends Error {
  constructor(hash: string, entityType: string) {
    super(
      `Multiple ${entityType}s match the short hash '${hash}'. Please use a longer hash to uniquely identify the ${entityType}.`
    );
    this.name = "AmbiguousHashError";
  }
}

function needsLikeMatch(value: string): boolean {
  return value.length >= MIN_SHORT_HASH_LENGTH && value.length < FULL_HASH_LENGTH;
}

function buildLikePattern(value: string): string {
  // Git hashes are hexadecimal, so they never contain LIKE wildcards (% or _).
  // Validate hex to be safe before constructing the pattern.
  if (!/^[a-f0-9]+$/i.test(value)) {
    return value;
  }
  return value + "%";
}

function normalizeTaskDelayMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface FileLookupRecord {
  jobId: string;
  fileName: string;
  fileDiskPath: string;
  fileHash: string;
}

export class JobRepository {
  constructor(private db: DatabaseClient) {}

  async createAgentTaskJob(
    id: string,
    repo: string,
    taskId?: string,
    taskStatus?: string,
    branchName?: string | null,
    taskDelayMs = 0,
    scheduledAt?: Date | string | null
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO agent_task_jobs (
         id,
         repo,
         status,
         github_task_id,
         task_status,
         branch_name,
         task_delay_ms,
         scheduled_at,
         created_at,
         updated_at
        )
       VALUES ($1, $2, 'waiting', $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        id,
        repo,
        taskId ?? null,
        taskStatus ?? null,
        branchName ?? null,
        taskDelayMs,
        scheduledAt ?? null,
      ]
    );
  }

  async getAgentTaskJob(id: string): Promise<AgentTaskJobInfo | undefined> {
    const result = await this.db.query(
      "SELECT * FROM agent_task_jobs WHERE id = $1",
      [id]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }

    return {
      id: row.id as string,
      repo: row.repo as string,
      status: row.status as AgentTaskJobStatus,
      branch: (row.branch_name as string | null) ?? null,
      taskId: (row.github_task_id as string | null) ?? undefined,
      taskStatus: (row.task_status as string | null) ?? undefined,
      taskDelayMs: normalizeTaskDelayMs(row.task_delay_ms),
      scheduledAt: row.scheduled_at ? toIsoString(row.scheduled_at) : null,
      error: (row.error as string | null) ?? undefined,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
    };
  }

  async updateAgentTaskJobStatus(
    id: string,
    status: AgentTaskJobStatus,
    error?: string
  ): Promise<void> {
    await this.db.query(
      `UPDATE agent_task_jobs
       SET status = $1, error = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [status, error ?? null, id]
    );
  }

  async attachAgentTaskToJob(
    id: string,
    taskId: string,
    taskStatus?: string,
    branchName?: string
  ): Promise<void> {
    await this.db.query(
      `UPDATE agent_task_jobs
        SET github_task_id = $1,
            task_status = COALESCE($2, task_status),
            branch_name = COALESCE($3, branch_name),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $4`,
      [taskId, taskStatus ?? null, branchName ?? null, id]
    );
  }

  async updateAgentTaskStatus(
    id: string,
    taskStatus: string,
    branchName?: string
  ): Promise<void> {
    await this.db.query(
      `UPDATE agent_task_jobs
        SET task_status = $1,
            branch_name = COALESCE($2, branch_name),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $3`,
      [taskStatus, branchName ?? null, id]
    );
  }

  async listPendingAgentTaskJobs(): Promise<AgentTaskJobInfo[]> {
    const result = await this.db.query(
      `SELECT *
       FROM agent_task_jobs
       WHERE status = 'waiting'
         AND github_task_id IS NULL
       ORDER BY COALESCE(scheduled_at, created_at) ASC, created_at ASC`
    );

    return result.rows.map((row) => {
      const record = row as Record<string, unknown>;
      return {
        id: record.id as string,
        repo: record.repo as string,
        status: record.status as AgentTaskJobStatus,
        branch: (record.branch_name as string | null) ?? null,
        taskId: (record.github_task_id as string | null) ?? undefined,
        taskStatus: (record.task_status as string | null) ?? undefined,
        taskDelayMs: normalizeTaskDelayMs(record.task_delay_ms),
        scheduledAt: record.scheduled_at ? toIsoString(record.scheduled_at) : null,
        error: (record.error as string | null) ?? undefined,
        createdAt: toIsoString(record.created_at),
        updatedAt: toIsoString(record.updated_at),
      };
    });
  }

  async createJob(id: string, repo: string, commit: string): Promise<void> {
    await this.db.query(
      `INSERT INTO jobs (id, repo, commit, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'waiting', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [id, repo, commit]
    );
  }

  async getJob(id: string): Promise<JobInfo | undefined> {
    const useLike = needsLikeMatch(id);
    const query = useLike
      ? "SELECT * FROM jobs WHERE id LIKE $1"
      : "SELECT * FROM jobs WHERE id = $1";
    const param = useLike ? buildLikePattern(id) : id;

    const result = await this.db.query(query, [param]);

    if (useLike) {
      const distinctIds = new Set(
        result.rows.map((r) => (r as Record<string, unknown>).id as string)
      );
      if (distinctIds.size > 1) {
        throw new AmbiguousHashError(id, "job");
      }
    }

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

  async getJobByCommit(commit: string): Promise<JobInfo | undefined> {
    const useLike = needsLikeMatch(commit);
    const condition = useLike ? "commit LIKE $1" : "commit = $1";
    const param = useLike ? buildLikePattern(commit) : commit;

    const result = await this.db.query(
      `SELECT * FROM jobs WHERE ${condition} ORDER BY created_at DESC`,
      [param]
    );

    if (useLike) {
      const distinctCommits = new Set(
        result.rows.map((r) => (r as Record<string, unknown>).commit as string)
      );
      if (distinctCommits.size > 1) {
        throw new AmbiguousHashError(commit, "commit");
      }
    }

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

  async resetJobForRetry(id: string): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM files WHERE job_id = $1", [id]);
      await client.query(
        `UPDATE jobs
         SET status = 'waiting',
             progress = 0,
             total_files = 0,
             processed_files = 0,
             error = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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

  async getFilesWithDiskPaths(jobId: string): Promise<FileRecord[]> {
    const result = await this.db.query(
      `SELECT file_type, file_name, file_disk_path, file_size, file_update_date, file_last_commit, file_git_hash
       FROM files WHERE job_id = $1 ORDER BY id ASC`,
      [jobId]
    );
    return result.rows as FileRecord[];
  }

  async getFileByHash(
    jobId: string,
    hash: string
  ): Promise<FileLookupRecord | undefined> {
    const useLike = needsLikeMatch(hash);
    const condition = useLike ? "file_git_hash LIKE $2" : "file_git_hash = $2";
    const param = useLike ? buildLikePattern(hash) : hash;

    const result = await this.db.query(
      `SELECT job_id, file_name, file_disk_path, file_git_hash
       FROM files
       WHERE job_id = $1 AND ${condition}
       ORDER BY id ASC`,
      [jobId, param]
    );

    if (useLike) {
      const distinctHashes = new Set(
        result.rows.map(
          (r) => (r as { file_git_hash: string }).file_git_hash
        )
      );
      if (distinctHashes.size > 1) {
        throw new AmbiguousHashError(hash, "file");
      }
    }

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

  async getFilesByHash(hash: string): Promise<FileLookupRecord[]> {
    const useLike = needsLikeMatch(hash);
    const condition = useLike ? "file_git_hash LIKE $1" : "file_git_hash = $1";
    const param = useLike ? buildLikePattern(hash) : hash;

    const result = await this.db.query(
      `SELECT job_id, file_name, file_disk_path, file_git_hash
       FROM files
       WHERE ${condition}
       ORDER BY id ASC`,
      [param]
    );

    if (useLike) {
      const distinctHashes = new Set(
        result.rows.map(
          (r) => (r as { file_git_hash: string }).file_git_hash
        )
      );
      if (distinctHashes.size > 1) {
        throw new AmbiguousHashError(hash, "file");
      }
    }

    return result.rows.map((row) => {
      const file = row as {
        job_id: string;
        file_name: string;
        file_disk_path: string;
        file_git_hash: string;
      };

      return {
        jobId: file.job_id,
        fileName: file.file_name,
        fileDiskPath: file.file_disk_path,
        fileHash: file.file_git_hash,
      };
    });
  }

  async getStats(): Promise<StatsResponse> {
    const result = await this.db.query(`
      SELECT
        (SELECT COUNT(*) FROM jobs) AS jobs_stored,
        (SELECT COUNT(*) FROM files) AS files_stored,
        (SELECT COALESCE(SUM(file_size), 0) FROM files) AS size_stored
    `);
    const row = result.rows[0] as
      | {
          jobs_stored: string | number;
          files_stored: string | number;
          size_stored: string | number;
        }
      | undefined;

    return {
      jobsStored: Number(row?.jobs_stored ?? 0),
      filesStored: Number(row?.files_stored ?? 0),
      sizeStored: Number(row?.size_stored ?? 0),
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
