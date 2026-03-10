/** Metadata for a single file/directory in a processed repository. */
export interface FileRecord {
  /** d = directory, t = text file, b = binary file, x = executable, s = symlink */
  file_type: "d" | "t" | "b" | "x" | "s";
  /** File name with path relative to the repo root */
  file_name: string;
  /** Size in bytes */
  file_size: number;
  /** ISO-8601 date of last modification according to git */
  file_update_date: string;
  /** SHA of the last commit that touched this file */
  file_last_commit: string;
  /** Git blob hash of the file content (empty string for directories) */
  file_git_hash: string;
}

/** Payload sent when creating a new processing job. */
export interface JobRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
  /** Exact commit SHA to process */
  commit: string;
}

/** Status of a processing job. */
export type JobStatus = "waiting" | "active" | "completed" | "failed";

/** Response when querying a job. */
export interface JobInfo {
  id: string;
  repo: string;
  commit: string;
  commitShort: string;
  status: JobStatus;
  progress: number;
  total_files: number;
  processed_files: number;
  error?: string;
  created_at: string;
  updated_at: string;
}
