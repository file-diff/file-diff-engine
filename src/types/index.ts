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

/** Payload sent when merging one branch into another and creating a pull request. */
export interface MergeBranchRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
  /** Base branch to merge into (default: "main") */
  baseBranch?: string;
  /** Branch whose changes are merged in */
  otherBranch: string;
  /** Optional GitHub token; when provided a pull request is also created */
  githubKey?: string;
}

/** Response payload after merging a branch and optionally creating a pull request. */
export interface MergeBranchResponse {
  repo: string;
  baseBranch: string;
  otherBranch: string;
  mergeBranch: string;
  mergeCommit: string;
  mergeCommitShort: string;
  created: boolean;
  pullRequest: CommitPullRequestSummary | null;
  log: OperationLogEntry[];
}

/** Payload sent when restoring a branch to the tree from a past commit. */
export interface RevertToCommitRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
  /** Full 40-character commit SHA */
  commit: string;
  /** Branch to fork from before restoring the tree */
  branch?: string;
  /** Optional GitHub token; when provided a pull request is also created */
  githubKey?: string;
}

/** Payload sent when listing Git refs for a repository. */
export interface ListRefsRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
}

/** Payload sent when listing repository branches with branch head metadata. */
export interface ListBranchesRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
}

/** Payload sent when listing recent commits for a repository. */
export interface ListCommitsRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
  /** Maximum number of commits to return */
  limit: number;
}

/** Generic error response payload returned by the API. */
export interface ErrorResponse {
  error: string;
}

/** Status of a processing job. */
export type JobStatus = "waiting" | "active" | "completed" | "failed";

/** Status of a locally tracked GitHub agent task job. */
export type AgentTaskJobStatus = JobStatus | "canceled";

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

/** User-facing log entry for a git or GitHub operation. */
export interface OperationLogEntry {
  message: string;
}

/** Response payload after creating a branch that restores a commit snapshot. */
export interface RevertToCommitResponse {
  repo: string;
  branch: string;
  commit: string;
  commitShort: string;
  revertBranch: string;
  revertCommit: string;
  revertCommitShort: string;
  pullRequest: CommitPullRequestSummary | null;
  log: OperationLogEntry[];
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

/** Pull request metadata associated with a commit. */
export interface CommitPullRequestSummary {
  number: number;
  title: string;
  url: string;
  state?: "open" | "closed";
}

/** Pull request status associated with a branch head commit. */
export type BranchPullRequestStatus = "open" | "closed" | "none";

/** Response entry when listing repository branches with head metadata. */
export interface BranchSummary {
  name: string;
  ref: string;
  commit: string;
  commitShort: string;
  date: string;
  author: string;
  title: string;
  isDefault: boolean;
  pullRequestStatus: BranchPullRequestStatus;
  pullRequest: CommitPullRequestSummary | null;
  tags: string[];
}

/** Response payload when listing repository branches. */
export interface ListBranchesResponse {
  repo: string;
  branches: BranchSummary[];
}

/** Response entry when listing recent commits for a repository. */
export interface CommitSummary {
  commit: string;
  date: string;
  author: string;
  title: string;
  branch: string | null;
  parents: string[];
  pullRequest: CommitPullRequestSummary | null;
  tags: string[];
}

/** Response payload when listing recent commits for a repository. */
export interface ListCommitsResponse {
  repo: string;
  commits: CommitSummary[];
}

/** Visualization node entry when listing commits as a graph. */
export interface CommitGraphNode {
  id: string;
  type: "node";
  colorKey?: string;
}

/** Visualization edge entry when listing commits as a graph. */
export interface CommitGraphEdge {
  id: string;
  type: "edge";
  source: string;
  target: string;
}

/** Mixed graph item returned by the commit visualization endpoint. */
export type CommitGraphItem = CommitGraphNode | CommitGraphEdge;

/** Response payload when listing recent commits as visualization graph items. */
export type ListCommitsGraphResponse = CommitGraphItem[];

/** Response entry when listing repositories for a GitHub organization. */
export interface OrganizationRepositorySummary {
  name: string;
  repo: string;
  repositoryUrl: string;
  pushedAt: string;
  createdAt: string;
  updatedAt: string;
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

/** A single grep match found within a processed commit checkout. */
export interface CommitGrepMatch {
  path: string;
  lineNumber: number;
  line: string;
}

/** Response payload when grepping files for a processed commit. */
export interface CommitGrepResponse {
  jobId: string;
  commit: string;
  commitShort: string;
  status: JobStatus;
  progress: number;
  query: string;
  matches: CommitGrepMatch[];
}

/** Aggregate storage statistics derived from the database. */
export interface StatsResponse {
  jobsStored: number;
  filesStored: number;
  sizeStored: number;
}

/** Health endpoint response payload. */
export interface HealthResponse {
  status: "ok";
  message: string;
  github: {
    configured: boolean;
    status: "ok" | "error";
    rateLimit?: {
      limit: number;
      remaining: number;
      reset: number;
      used: number;
      resource: string;
    };
    error?: string;
  };
}

/** Build version endpoint response payload. */
export interface VersionResponse {
  version: string;
}

/** Follow-up pull request action after a successful agent task run. */
export type PullRequestCompletionMode = "None" | "AutoReady" | "AutoMerge";

/** Payload sent when creating a new GitHub Copilot coding agent task. */
export interface CreateTaskRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
  /** User's written prompt (deprecated; ignored for task creation payloads) */
  event_content?: string;
  /** Agent ID (optional, defaults to coding agent) */
  agent_id?: number;
  /** Additional prompting for the agent */
  problem_statement?: string;
  /** The model to use for this task */
  model?: string;
  /** Custom agent identifier */
  custom_agent?: string;
  /** Whether to create a PR */
  create_pull_request?: boolean;
  /** Follow-up pull request action after a successful agent run */
  pull_request_completion_mode?: PullRequestCompletionMode;
  /** Base ref for new branch/PR */
  base_ref?: string;
  /** Optional delay in milliseconds before starting the remote task */
  task_delay_ms?: number;
}

/** Response payload after creating a GitHub Copilot coding agent task. */
export interface CreateTaskResponse {
  /** Created task id */
  id: string;
}

/** Minimal response payload returned after creating an agent task job. */
export interface AgentTaskJobSummary {
  id: string;
  repo: string;
  status: AgentTaskJobStatus;
  branch: string | null;
  taskId?: string;
  taskStatus?: string;
  taskDelayMs: number;
  scheduledAt: string | null;
}

/** Response payload when querying a queued or monitored agent task job. */
export interface AgentTaskJobInfo extends AgentTaskJobSummary {
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** Session information for a GitHub Copilot coding agent task. */
export interface TaskSessionInfo {
  id?: string;
  task_id?: string;
  state?: string;
  base_ref?: string;
  /** Head branch created for this session when available. */
  head_ref?: string;
  [key: string]: unknown;
}

/** Response payload for a GitHub Copilot coding agent task lookup. */
export interface TaskInfoResponse {
  /** Remote GitHub Copilot task state such as queued, in_progress, completed, or failed. */
  state?: string;
  /** Session details populated by GitHub once task execution has started. */
  sessions?: TaskSessionInfo[];
  [key: string]: unknown;
}

/** Response payload for listing GitHub Copilot coding agent tasks for a repository. */
export type ListTasksResponse =
  | Array<Record<string, unknown>>
  | Record<string, unknown>;

/** Payload sent when deleting a remote branch from a GitHub repository. */
export interface DeleteRemoteBranchRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
  /** Branch name to delete */
  branch: string;
  /** Optional GitHub token */
  githubKey?: string;
}

/** Payload sent when creating a remote tag in a GitHub repository. */
export interface CreateTagRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
  /** Tag name to create */
  tag: string;
  /** Full 40-character commit SHA */
  commit: string;
  /** Optional GitHub token */
  githubKey?: string;
}

/** Payload sent when checking access to a repository branch. */
export interface BranchPermissionsRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
  /** Branch name */
  branch: string;
  /** Optional GitHub token */
  githubKey?: string;
}

/** Response payload after checking access to a repository branch. */
export interface BranchPermissionsResponse {
  repo: string;
  branch: string;
  read: boolean;
  write: boolean;
}

/** Response payload after deleting a remote branch. */
export interface DeleteRemoteBranchResponse {
  repo: string;
  branch: string;
}

/** Response payload after creating a remote tag. */
export interface CreateTagResponse {
  repo: string;
  tag: string;
  ref: string;
  commit: string;
  commitShort: string;
}

/** Payload sent when listing tags for a repository. */
export interface ListTagsRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
  /** Maximum number of tags to return */
  limit: number;
}

/** Response entry when listing tags for a repository. */
export interface TagSummary {
  /** Tag name (e.g. `v1.2.3`) */
  name: string;
  /** Full Git ref (always `refs/tags/<name>`) */
  ref: string;
  /** Commit SHA the tag points to */
  commit: string;
  /** Short commit SHA */
  commitShort: string;
}

/** Response payload when listing tags for a repository. */
export interface ListTagsResponse {
  repo: string;
  tags: TagSummary[];
}

/** Payload sent when listing GitHub Actions workflow runs for a repository. */
export interface ListActionsRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
  /** Maximum number of workflow runs to return */
  limit: number;
}

/** Response entry when listing GitHub Actions workflow runs for a repository. */
export interface WorkflowRunSummary {
  /** GitHub workflow run id */
  id: number;
  /** Run-level number (monotonic per workflow) */
  runNumber: number;
  /** Display name of the run, when available */
  name: string;
  /** Workflow id this run belongs to */
  workflowId: number;
  /** Event that triggered the run, e.g. `push`, `pull_request` */
  event: string;
  /** Run status, e.g. `queued`, `in_progress`, `completed` */
  status: string;
  /** Run conclusion when the run has completed (e.g. `success`, `failure`), otherwise `null` */
  conclusion: string | null;
  /** Branch the run was triggered for */
  branch: string;
  /** Commit SHA the run was triggered for */
  commit: string;
  /** Short commit SHA */
  commitShort: string;
  /** Run creation timestamp */
  createdAt: string;
  /** Run last update timestamp */
  updatedAt: string;
  /** URL to the run on GitHub */
  url: string;
}

/** Response payload when listing GitHub Actions workflow runs for a repository. */
export interface ListActionsResponse {
  repo: string;
  runs: WorkflowRunSummary[];
}

/** Payload sent when deleting a specific GitHub Actions workflow run. */
export interface DeleteActionRunRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
  /** Workflow run id to delete */
  runId: number;
  /** Optional GitHub token */
  githubKey?: string;
}

/** Response payload after deleting a specific workflow run. */
export interface DeleteActionRunResponse {
  repo: string;
  runId: number;
}

/** Payload sent when deleting a remote tag from a GitHub repository. */
export interface DeleteTagRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
  /** Tag name to delete */
  tag: string;
  /** Optional GitHub token */
  githubKey?: string;
}

/** Response payload after deleting a remote tag. */
export interface DeleteTagResponse {
  repo: string;
  tag: string;
}

/** Payload sent when deleting a GitHub repository. */
export interface DeleteRepositoryRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
  /** Optional GitHub token */
  githubKey?: string;
}

/** Response payload after deleting a GitHub repository. */
export interface DeleteRepositoryResponse {
  repo: string;
}

/** Payload sent when marking a pull request as ready for review. */
export interface MarkPullRequestReadyRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
  /** Pull request number */
  pullNumber: number;
  /** Optional GitHub token */
  githubKey?: string;
}

/** Response payload after marking a pull request as ready for review. */
export interface MarkPullRequestReadyResponse {
  repo: string;
  pullNumber: number;
}

/** Payload sent when merging a pull request. */
export interface MergePullRequestRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
  /** Pull request number */
  pullNumber: number;
  /** Optional commit title for the merge commit */
  commitTitle?: string;
  /** Optional commit message for the merge commit */
  commitMessage?: string;
  /** Merge method: merge, squash, or rebase (default: merge) */
  mergeMethod?: "merge" | "squash" | "rebase";
  /** Optional GitHub token */
  githubKey?: string;
}

/** Response payload after merging a pull request. */
export interface MergePullRequestResponse {
  repo: string;
  pullNumber: number;
  merged: boolean;
  message: string;
  sha: string;
}

/** Payload sent when opening a new pull request. */
export interface OpenPullRequestRequest {
  /** GitHub repository in owner/repo format */
  repo: string;
  /** Head branch containing the changes */
  head: string;
  /** Base branch to merge into (default: "main") */
  base?: string;
  /** Pull request title (defaults to last commit message on the head branch) */
  title?: string;
  /** Pull request body/description (defaults to last commit message body on the head branch) */
  body?: string;
  /** Whether to create as a draft pull request (default: false) */
  draft?: boolean;
  /** Optional GitHub token */
  githubKey?: string;
}

/** Response payload after opening a pull request. */
export interface OpenPullRequestResponse {
  repo: string;
  pullNumber: number;
  title: string;
  url: string;
  draft: boolean;
}
