/** Parameters for the revert-to-commit operation. */
export interface RevertToCommitParams {
  /** GitHub repository in "owner/repo" format or a full URL. */
  repo: string;
  /** The commit hash (full or short SHA) to revert to. */
  commitHash: string;
  /** The branch to fork from (default: "main"). */
  branch?: string;
  /** GitHub token for push and PR creation. Falls back to PUBLIC_GITHUB_TOKEN env var. */
  githubToken?: string;
  /** Optional directory containing a cached clone of the repository. */
  cacheDir?: string;
}

/** Result of the revert-to-commit operation. */
export interface RevertToCommitResult {
  /** Whether the operation succeeded. */
  success: boolean;
  /** Human-readable status message. */
  message: string;
  /** The name of the new branch that was created. */
  newBranch: string;
  /** The resolved full 40-character commit SHA that was reverted to. */
  commitSha: string;
  /** URL of the pull request, if one was created. */
  pullRequestUrl?: string;
  /** Error message if the operation failed. */
  error?: string;
}
