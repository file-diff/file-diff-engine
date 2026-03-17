/** Metadata for a single file/directory in a processed repository. */
export interface FileRecord {
  /** d = directory, t = text file, b = binary file, x = executable, s = symlink */
  file_type: "d" | "t" | "b" | "x" | "s";
  /** File name with path relative to the repo root */
  file_name: string;
  /** File location relative to the checked-out repo root on disk */
  file_disk_path?: string;
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
  /** Full commit SHA */
  commit: string;
}

/** Payload sent when resolving a Git ref to a commit SHA. */
export interface ResolveCommitRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
  /** Git ref or full commit SHA */
  ref: string;
}

/** Payload sent when resolving a GitHub pull request URL. */
export interface ResolvePullRequestRequest {
  /** Full GitHub pull request URL */
  pullRequestUrl: string;
}

/** Payload sent when listing Git refs for a repository. */
export interface ListRefsRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
}

/** Generic error response payload returned by the API. */
export interface ErrorResponse {
  error: string;
}

/** Status of a processing job. */
export type JobStatus = "waiting" | "active" | "completed" | "failed";

/** Minimal job payload returned after creating or reusing a job. */
export interface JobSummary {
  id: string;
  status: JobStatus;
  commit: string;
  commitShort: string;
}

/** Response payload when resolving a Git ref to a commit SHA. */
export interface ResolveCommitResponse {
  repo: string;
  ref: string;
  commit: string;
  commitShort: string;
}

/** Response payload when resolving a GitHub pull request URL. */
export interface ResolvePullRequestResponse {
  repo: string;
  repositoryUrl: string;
  sourceCommit: string;
  sourceCommitShort: string;
  targetCommit: string;
  targetCommitShort: string;
}

/** Supported Git ref types exposed by the API. */
export type GitRefType = "branch" | "tag";

/** Response entry when listing Git refs for a repository. */
export interface GitRefSummary {
  name: string;
  ref: string;
  type: GitRefType;
  commit: string;
  commitShort: string;
}

/** Response payload when listing Git refs for a repository. */
export interface ListRefsResponse {
  repo: string;
  refs: GitRefSummary[];
}

/** Response entry when listing repositories for a GitHub organization. */
export interface OrganizationRepositorySummary {
  name: string;
  repo: string;
  repositoryUrl: string;
}

/** Response payload when listing repositories for a GitHub organization. */
export interface ListOrganizationRepositoriesResponse {
  organization: string;
  repositories: OrganizationRepositorySummary[];
}

/** Response entry when listing git cache folders on disk. */
export interface GitCacheFolderSummary {
  name: string;
  size: number;
}

/** Response payload when listing git cache folders on disk. */
export interface GitCacheStatsResponse {
  count: number;
  totalSize: number;
  folders: GitCacheFolderSummary[];
}

/** Response when querying a job. */
export interface JobInfo {
  id: string;
  repo: string;
  commit: string;
  commitShort: string;
  status: JobStatus;
  progress: number;
  totalFiles: number;
  processedFiles: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** Compact file metadata shape returned by the files endpoint. */
export interface JobFileSummary {
  t: FileRecord["file_type"];
  path: FileRecord["file_name"];
  s: FileRecord["file_size"];
  update: FileRecord["file_update_date"];
  commit: FileRecord["file_last_commit"];
  hash: FileRecord["file_git_hash"];
}

/** Response payload when querying processed files for a job. */
export interface JobFilesResponse {
  jobId: string;
  commit: string;
  commitShort: string;
  status: JobStatus;
  progress: number;
  files: JobFileSummary[];
}

/** Health endpoint response payload. */
export interface HealthResponse {
  status: "ok";
  message: string;
}

/** Build version endpoint response payload. */
export interface VersionResponse {
  version: string;
}
