import Database from "better-sqlite3";
import { FileRecord, JobInfo, JobStatus } from "../types";

export class JobRepository {
  constructor(private db: Database.Database) {}

  createJob(id: string, repo: string, ref: string): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, repo, ref, status, created_at, updated_at)
         VALUES (?, ?, ?, 'waiting', datetime('now'), datetime('now'))`
      )
      .run(id, repo, ref);
  }

  getJob(id: string): JobInfo | undefined {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      repo: row.repo as string,
      ref: row.ref as string,
      status: row.status as JobStatus,
      progress: row.progress as number,
      total_files: row.total_files as number,
      processed_files: row.processed_files as number,
      error: row.error as string | undefined,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  updateJobStatus(id: string, status: JobStatus, error?: string): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(status, error ?? null, id);
  }

  updateJobProgress(
    id: string,
    processedFiles: number,
    totalFiles: number
  ): void {
    const progress = totalFiles > 0 ? (processedFiles / totalFiles) * 100 : 0;
    this.db
      .prepare(
        `UPDATE jobs SET processed_files = ?, total_files = ?, progress = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(processedFiles, totalFiles, progress, id);
  }

  insertFiles(jobId: string, files: FileRecord[]): void {
    const insert = this.db.prepare(
      `INSERT INTO files (job_id, file_type, file_name, file_size, file_update_date, file_last_commit, file_sha256_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const transaction = this.db.transaction((records: FileRecord[]) => {
      for (const f of records) {
        insert.run(
          jobId,
          f.file_type,
          f.file_name,
          f.file_size,
          f.file_update_date,
          f.file_last_commit,
          f.file_sha256_hash
        );
      }
    });
    transaction(files);
  }

  getFiles(jobId: string): FileRecord[] {
    const rows = this.db
      .prepare(
        "SELECT file_type, file_name, file_size, file_update_date, file_last_commit, file_sha256_hash FROM files WHERE job_id = ?"
      )
      .all(jobId) as FileRecord[];
    return rows;
  }
}
