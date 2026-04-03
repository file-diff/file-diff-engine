import os from "os";
import fs from "fs";
import path from "path";
import https from "https";
import { execFile } from "child_process";
import { promisify } from "util";
import { createLogger } from "../utils/logger";
import { getRepositoryUrl } from "../services/repoProcessor";
import type { RevertToCommitParams, RevertToCommitResult } from "./types";

const execFileAsync = promisify(execFile);
const logger = createLogger("github-operations");

const GITHUB_HOSTNAME = "github.com";
const GITHUB_API_HOSTNAME = "api.github.com";

/**
 * Validates that a git ref/hash string is safe for use in git commands.
 */
function validateRef(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  if (trimmed.startsWith("-")) {
    throw new Error(`${label} must not start with '-'.`);
  }
  if (/[\0\r\n]/.test(trimmed)) {
    throw new Error(`${label} contains invalid characters.`);
  }
  return trimmed;
}

/**
 * Validates a repository name in "owner/repo" format or full URL.
 */
function validateRepo(repo: string): string {
  const trimmed = repo.trim();
  if (!trimmed) {
    throw new Error("Repository name is required.");
  }
  if (trimmed.startsWith("-")) {
    throw new Error("Repository name must not start with '-'.");
  }
  if (/[\0\r\n]/.test(trimmed)) {
    throw new Error("Repository name contains invalid characters.");
  }
  if (!trimmed.includes("/")) {
    throw new Error(
      "Repository must be in 'owner/repo' format or a full URL."
    );
  }
  return trimmed;
}

/**
 * Validates that a cache directory path is safe to use.
 */
function validateCacheDir(cacheDir: string): string {
  const resolved = path.resolve(cacheDir);
  if (!resolved) {
    throw new Error("Cache directory path is required.");
  }
  return resolved;
}

/**
 * Returns environment variables for git commands, optionally injecting
 * token-based authentication for github.com via git config overrides.
 */
function getGitEnv(token?: string): NodeJS.ProcessEnv {
  const effectiveToken = token || process.env.PUBLIC_GITHUB_TOKEN?.trim();
  if (!effectiveToken) {
    return { ...process.env };
  }

  const env = { ...process.env };
  const existingCount = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const configCount =
    Number.isInteger(existingCount) && existingCount >= 0 ? existingCount : 0;
  const authHeader = Buffer.from(
    `x-access-token:${effectiveToken}`,
    "utf8"
  ).toString("base64");

  env.GIT_CONFIG_COUNT = String(configCount + 1);
  env[`GIT_CONFIG_KEY_${configCount}`] =
    `http.https://${GITHUB_HOSTNAME}/.extraHeader`;
  env[`GIT_CONFIG_VALUE_${configCount}`] =
    `Authorization: Basic ${authHeader}`;

  return env;
}

/**
 * Runs a git command in the given directory and returns trimmed stdout.
 */
async function runGit(
  cwd: string,
  args: string[],
  token?: string
): Promise<string> {
  const command = `git ${args.join(" ")}`;
  logger.debug("Running git command", { cwd, command });

  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      env: getGitEnv(token),
    });
    const stdoutText = (stdout ?? "").toString().trim();
    const stderrText = (stderr ?? "").toString().trim();
    if (stderrText) {
      logger.debug("Git command emitted stderr", {
        cwd,
        command,
        stderr: stderrText,
      });
    }
    return stdoutText;
  } catch (err) {
    const error = err as Error & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const stderrText = (error.stderr ?? "").toString().trim();
    const stdoutText = (error.stdout ?? "").toString().trim();
    const details = [
      `Git command failed: ${command}`,
      `cwd: ${cwd}`,
      error.message ? `error: ${error.message}` : undefined,
      stderrText ? `stderr: ${stderrText}` : undefined,
      stdoutText ? `stdout: ${stdoutText}` : undefined,
    ]
      .filter(Boolean)
      .join(" | ");
    logger.error("Git command failed", {
      cwd,
      command,
      error: error.message,
      stderr: stderrText,
    });
    throw new Error(details);
  }
}

/**
 * Creates a pull request on GitHub via the REST API.
 * Returns the HTML URL of the created pull request.
 */
async function createPullRequest(
  repo: string,
  headBranch: string,
  baseBranch: string,
  commitHash: string,
  token: string
): Promise<string> {
  const [owner, repoName] = repo.split("/", 2);
  const shortHash = commitHash.slice(0, 7);

  const body = JSON.stringify({
    title: `Revert to commit ${shortHash}`,
    body: [
      `This pull request reverts the \`${baseBranch}\` branch to the exact`,
      `state of commit [\`${shortHash}\`](https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/commit/${commitHash}).`,
      "",
      "Created automatically by file-diff-engine.",
    ].join("\n"),
    head: headBranch,
    base: baseBranch,
  });

  return new Promise<string>((resolve, reject) => {
    const request = https.request(
      {
        protocol: "https:",
        hostname: GITHUB_API_HOSTNAME,
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls`,
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "file-diff-engine",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          const statusCode = response.statusCode ?? 500;

          if (statusCode < 200 || statusCode >= 300) {
            let message = `GitHub API request failed with status ${statusCode}.`;
            try {
              const parsed = JSON.parse(responseBody) as {
                message?: string;
              };
              if (parsed.message) {
                message = `GitHub API error: ${parsed.message}`;
              }
            } catch {
              // ignore parse errors
            }
            reject(new Error(message));
            return;
          }

          try {
            const parsed = JSON.parse(responseBody) as {
              html_url?: string;
            };
            resolve(parsed.html_url ?? "");
          } catch {
            reject(
              new Error("GitHub API returned an invalid JSON response.")
            );
          }
        });
      }
    );

    request.on("error", (error) => {
      reject(new Error(`GitHub API request failed: ${error.message}`));
    });

    request.write(body);
    request.end();
  });
}

/**
 * Reverts a repository branch to the exact state of a given commit.
 *
 * Creates a new branch forked from the specified source branch, replaces all
 * content with the target commit's tree, commits, pushes, and optionally
 * opens a pull request.
 *
 * The repository is cloned into a temporary directory which is deleted once the
 * operation completes (whether it succeeds or fails).
 */
export async function revertToCommit(
  params: RevertToCommitParams
): Promise<RevertToCommitResult> {
  const {
    repo,
    commitHash,
    branch = "main",
    githubToken,
    cacheDir,
  } = params;

  const token =
    githubToken || process.env.PUBLIC_GITHUB_TOKEN?.trim() || undefined;

  const safeRepo = validateRepo(repo);
  const repoUrl = getRepositoryUrl(safeRepo);
  const safeBranch = validateRef(branch, "Branch");
  const safeCommit = validateRef(commitHash, "Commit hash");
  const safeCacheDir = cacheDir ? validateCacheDir(cacheDir) : undefined;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-revert-"));
  fs.chmodSync(workDir, 0o700);
  const cloneDir = path.join(workDir, "repo");

  logger.info("Starting revert-to-commit operation", {
    repo: safeRepo,
    commitHash: safeCommit,
    branch: safeBranch,
    workDir,
  });

  try {
    // 1. Clone the repository (use cache if available, otherwise clone fresh)
    if (safeCacheDir && fs.existsSync(path.join(safeCacheDir, ".git"))) {
      logger.info("Using cached repository clone", { cacheDir: safeCacheDir });
      fs.cpSync(safeCacheDir, cloneDir, { recursive: true });
      await runGit(cloneDir, ["fetch", "--all"], token);
    } else {
      logger.info("Cloning repository", { repoUrl });
      await runGit(workDir, ["clone", "--", repoUrl, "repo"], token);
    }

    // 2. Configure git identity for the commit
    await runGit(
      cloneDir,
      ["config", "user.name", "file-diff-engine"],
      token
    );
    await runGit(
      cloneDir,
      ["config", "user.email", "noreply@file-diff-engine"],
      token
    );

    // 3. Checkout the source branch
    await runGit(cloneDir, ["checkout", safeBranch], token);

    // 4. Resolve the target commit to a full SHA
    let resolvedCommit: string;
    try {
      resolvedCommit = await runGit(
        cloneDir,
        ["rev-parse", "--verify", safeCommit],
        token
      );
    } catch {
      // Commit might not be available in a shallow clone; fetch it.
      logger.info("Commit not found locally, fetching from remote", {
        commitHash: safeCommit,
      });
      await runGit(cloneDir, ["fetch", "origin", safeCommit], token);
      resolvedCommit = await runGit(
        cloneDir,
        ["rev-parse", "--verify", safeCommit],
        token
      );
    }

    if (!/^[a-f0-9]{40}$/i.test(resolvedCommit)) {
      throw new Error(
        `Failed to resolve '${safeCommit}' to a valid 40-character commit SHA.`
      );
    }
    resolvedCommit = resolvedCommit.toLowerCase();
    const shortHash = resolvedCommit.slice(0, 7);

    // 5. Create a new branch from the source branch
    const newBranch = `revert/to-${shortHash}-${Date.now()}`;
    await runGit(cloneDir, ["checkout", "-b", newBranch], token);

    // 6. Replace working tree and index with the target commit's tree
    await runGit(
      cloneDir,
      ["read-tree", "-u", "--reset", resolvedCommit],
      token
    );

    // 7. Check whether the tree actually differs from the source branch HEAD
    let hasChanges: boolean;
    try {
      await runGit(cloneDir, ["diff-index", "--quiet", "HEAD"], token);
      hasChanges = false;
    } catch {
      hasChanges = true;
    }

    if (!hasChanges) {
      logger.info(
        "No changes detected — branch already matches target commit",
        { commitHash: resolvedCommit, branch: safeBranch }
      );
      return {
        success: true,
        message: `No changes needed — branch '${safeBranch}' already matches commit ${shortHash}.`,
        newBranch,
        commitSha: resolvedCommit,
      };
    }

    // 8. Commit the reverted state
    const commitMessage = [
      `Revert to commit ${shortHash}`,
      "",
      `Reverts branch '${safeBranch}' to the exact state of commit ${resolvedCommit}.`,
    ].join("\n");
    await runGit(cloneDir, ["commit", "-m", commitMessage], token);

    // 9. Push the new branch to origin
    await runGit(cloneDir, ["push", "origin", newBranch], token);

    // 10. Create a pull request if a token is available
    let pullRequestUrl: string | undefined;
    if (token) {
      try {
        pullRequestUrl = await createPullRequest(
          safeRepo,
          newBranch,
          safeBranch,
          resolvedCommit,
          token
        );
        logger.info("Pull request created", { pullRequestUrl });
      } catch (prError) {
        logger.warn("Failed to create pull request", {
          error:
            prError instanceof Error ? prError.message : String(prError),
        });
      }
    }

    logger.info("Revert-to-commit operation completed successfully", {
      repo: safeRepo,
      newBranch,
      commitSha: resolvedCommit,
      pullRequestUrl,
    });

    return {
      success: true,
      message: `Successfully reverted to commit ${shortHash} on new branch '${newBranch}'.`,
      newBranch,
      commitSha: resolvedCommit,
      pullRequestUrl,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error("Revert-to-commit operation failed", {
      error: errorMessage,
    });
    return {
      success: false,
      message: `Revert operation failed: ${errorMessage}`,
      newBranch: "",
      commitSha: "",
      error: errorMessage,
    };
  } finally {
    // Clean up the temporary working directory
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
      logger.info("Cleaned up working directory", { workDir });
    } catch (cleanupError) {
      logger.warn("Failed to clean up working directory", {
        workDir,
        error:
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    const usage = [
      "Usage: revertToCommit <repo> <commitHash> [branch] [githubToken]",
      "",
      "Arguments:",
      "  repo         GitHub repository in owner/repo format",
      "  commitHash   The commit SHA to revert to",
      "  branch       Branch to fork from (default: main)",
      "  githubToken  GitHub token for push & PR (or set PUBLIC_GITHUB_TOKEN env var)",
    ];
    console.error(usage.join("\n"));
    process.exit(1);
  }

  const [repo, commitHash, branch, githubToken] = args;

  revertToCommit({ repo, commitHash, branch, githubToken })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error("Unexpected error:", err);
      process.exit(1);
    });
}
