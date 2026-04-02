import os from "os";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { FileRecord, type CommitSummary, type GitRefSummary } from "../types";
import { getCommitShort } from "../utils/commit";
import { createLogger } from "../utils/logger";
import { getCommitPullRequest } from "./githubApi";

const execFileAsync = promisify(execFile);
const logger = createLogger("repo-processor");
const CACHE_COLLISION_MAX_ATTEMPTS = 3;
const CACHE_COLLISION_RETRY_DELAY_MS = 100;
const GITHUB_HOSTNAME = "github.com";

/**
 * Helper to run git commands in a working directory and return stdout (trimmed).
 */
async function runGitCommand(cwd: string, args: string[]): Promise<string> {
  const command = `git ${args.join(" ")}`;
  logger.debug("Running git command", { cwd, command });

  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      env: getGitCommandEnv(),
    });
    const stdoutText = (stdout ?? "").toString().trim();
    const stderrText = (stderr ?? "").toString().trim();
    if (stderrText) {
      logger.debug("Git command emitted stderr", { cwd, command, stderr: stderrText });
    }
    logger.debug("Git command completed", { cwd, command });
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
      stdout: stdoutText,
    });
    throw new Error(details);
  }
}

function getGitCommandEnv(): NodeJS.ProcessEnv {
  const token = process.env.PUBLIC_GITHUB_TOKEN?.trim();
  if (!token) {
    return process.env;
  }

  const env = { ...process.env };
  const existingCount = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const configCount =
    Number.isInteger(existingCount) && existingCount >= 0 ? existingCount : 0;
  const authHeader = Buffer.from(`x-access-token:${token}`, "utf8").toString(
    "base64"
  );

  env.GIT_CONFIG_COUNT = String(configCount + 1);
  env[`GIT_CONFIG_KEY_${configCount}`] = `http.https://${GITHUB_HOSTNAME}/.extraHeader`;
  env[`GIT_CONFIG_VALUE_${configCount}`] = `Authorization: Basic ${authHeader}`;

  return env;
}

function withRepoArg(args: string[], repoUrl: string, trailingArgs: string[] = []): string[] {
  return [...args, "--", repoUrl, ...trailingArgs];
}

function assertSafeGitRepositoryUrl(repoUrl: string): void {
  const trimmedRepoUrl = repoUrl.trim();
  if (!trimmedRepoUrl) {
    throw new Error("Repository URL is required.");
  }

  if (trimmedRepoUrl.startsWith("-")) {
    throw new Error("Repository URL cannot start with '-'.");
  }

  if (/[\0\r\n]/.test(trimmedRepoUrl)) {
    throw new Error("Repository URL contains unsupported control characters.");
  }
}

function isRetryableGitLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  return (
    message.includes(".lock") ||
    message.includes("another git process seems to be running") ||
    message.includes("cannot lock ref")
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function compareCommitDatesDescending(left: string, right: string): number {
  const leftTimestamp = Date.parse(left);
  const rightTimestamp = Date.parse(right);

  if (Number.isNaN(leftTimestamp) || Number.isNaN(rightTimestamp)) {
    return right.localeCompare(left);
  }

  return rightTimestamp - leftTimestamp;
}

async function runGitCommandWithRetry(cwd: string, args: string[]): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= CACHE_COLLISION_MAX_ATTEMPTS; attempt++) {
    try {
      return await runGitCommand(cwd, args);
    } catch (error) {
      lastError = error;
      if (attempt >= CACHE_COLLISION_MAX_ATTEMPTS || !isRetryableGitLockError(error)) {
        throw error;
      }

      logger.warn("Git cache operation collided with another process, retrying", {
        cwd,
        command: `git ${args.join(" ")}`,
        attempt,
        maxAttempts: CACHE_COLLISION_MAX_ATTEMPTS,
      });
      await wait(CACHE_COLLISION_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Git command failed after retries: git ${args.join(" ")}`);
}

export function getRepositoryUrl(repo: string): string {
  if (repo.includes("://") || path.isAbsolute(repo)) {
    return repo;
  }

  return `https://github.com/${repo}.git`;
}

export async function resolveRefToCommitHash(
  repoUrl: string,
  ref: string
): Promise<string> {
  assertSafeGitRepositoryUrl(repoUrl);
  const trimmedRef = ref.trim();
  if (!trimmedRef) {
    throw new Error("Git ref is required.");
  }

  if (/^[a-f0-9]{40}$/i.test(trimmedRef)) {
    return trimmedRef.toLowerCase();
  }

  const refCandidates = trimmedRef.startsWith("refs/")
    ? [trimmedRef, `${trimmedRef}^{}`]
    : [
        `refs/heads/${trimmedRef}`,
        `refs/tags/${trimmedRef}^{}`,
        `refs/tags/${trimmedRef}`,
      ];
  const output = await runGitCommand(process.cwd(), [
    ...withRepoArg(["ls-remote"], repoUrl, refCandidates),
  ]);

  const refsByName = new Map(
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, name] = line.trim().split(/\s+/, 2);
        return [name, hash.toLowerCase()] as const;
      })
  );
  const resolvedRef = refCandidates.find((candidate) => refsByName.has(candidate));
  if (!resolvedRef) {
    throw new Error(
      `Unable to resolve git ref '${trimmedRef}' for repository '${repoUrl}'.`
    );
  }

  return refsByName.get(resolvedRef)!;
}

export async function listRepositoryRefs(repoUrl: string): Promise<GitRefSummary[]> {
  assertSafeGitRepositoryUrl(repoUrl);
  const output = await runGitCommand(
    process.cwd(),
    withRepoArg(["ls-remote", "--heads", "--tags"], repoUrl)
  );
  const refsByName = new Map<string, GitRefSummary>();

  for (const line of output.split("\n").filter(Boolean)) {
    const [hash, rawRef] = line.trim().split(/\s+/, 2);
    if (!hash || !rawRef) {
      continue;
    }

    const ref = rawRef.endsWith("^{}") ? rawRef.slice(0, -3) : rawRef;
    const commit = hash.toLowerCase();
    let type: GitRefSummary["type"];
    let name: string;

    if (ref.startsWith("refs/heads/")) {
      type = "branch";
      name = ref.slice("refs/heads/".length);
    } else if (ref.startsWith("refs/tags/")) {
      type = "tag";
      name = ref.slice("refs/tags/".length);
    } else {
      continue;
    }

    const existing = refsByName.get(ref);
    const resolvedCommit = rawRef.endsWith("^{}") || !existing ? commit : existing.commit;
    refsByName.set(ref, {
      name,
      ref,
      type,
      commit: resolvedCommit,
      commitShort: getCommitShort(resolvedCommit),
    });
  }

  return Array.from(refsByName.values()).sort((a, b) => {
    if (a.type !== b.type) {
      return a.type.localeCompare(b.type);
    }

    return a.name.localeCompare(b.name);
  });
}

export async function listRepositoryCommits(
  repoUrl: string,
  limit: number
): Promise<CommitSummary[]> {
  assertSafeGitRepositoryUrl(repoUrl);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("Field 'limit' must be a positive integer.");
  }

  const { branchRef } = await getHeadReference(repoUrl);
  const defaultBranch =
    branchRef?.startsWith("refs/heads/") ? branchRef.slice("refs/heads/".length) : null;
  const refs = await listRepositoryRefs(repoUrl);
  const refsByCommit = new Map<
    string,
    {
      branches: string[];
      tags: string[];
    }
  >();

  for (const ref of refs) {
    const current = refsByCommit.get(ref.commit) ?? { branches: [], tags: [] };
    if (ref.type === "branch") {
      current.branches.push(ref.name);
    } else {
      current.tags.push(ref.name);
    }
    refsByCommit.set(ref.commit, current);
  }

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-commit-list-"));

  try {
    const cloneArgs = ["clone", `--depth=${limit}`, "--no-single-branch"];
    cloneArgs.push("--", repoUrl, repoDir);
    await runGitCommand(process.cwd(), cloneArgs);

    const output = await runGitCommand(repoDir, [
      "log",
      "--all",
      "--date=iso-strict",
      "--pretty=format:%H%x1f%cI%x1f%an%x1f%s%x1f%P",
    ]);
    const commits = output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [commit, date, author, title, parents = ""] = line.split("\x1f");
        const commitRefs = refsByCommit.get(commit) ?? { branches: [], tags: [] };
        return {
          commit,
          date,
          author,
          title,
          branch:
            (defaultBranch && commitRefs.branches.includes(defaultBranch)
              ? defaultBranch
              : commitRefs.branches[0]) ?? null,
          parents: parents ? parents.split(" ").filter(Boolean) : [],
          pullRequest: null,
          tags: [...commitRefs.tags],
        } satisfies CommitSummary;
      })
      .sort((a, b) => compareCommitDatesDescending(a.date, b.date))
      .slice(0, limit);

    const githubRepo = getGitHubRepoName(repoUrl);
    if (!githubRepo) {
      return commits;
    }

    return Promise.all(
      commits.map(async (commit) => {
        try {
          return {
            ...commit,
            pullRequest: await getCommitPullRequest(githubRepo, commit.commit),
          };
        } catch {
          return commit;
        }
      })
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

/**
 * Determines if a file is binary by reading the first 8 KB and checking for
 * null bytes — the same heuristic Git uses.
 */
function isBinaryFile(filePath: string): boolean {
  const BUFFER_SIZE = 8192;
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(BUFFER_SIZE);
  const bytesRead = fs.readSync(fd, buf, 0, BUFFER_SIZE, 0);
  fs.closeSync(fd);
  for (let i = 0; i < bytesRead; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export interface ProgressCallback {
  (processed: number, total: number): void;
}

export interface ProcessRepositoryHooks {
  onFilesDiscovered?: (files: FileRecord[]) => void | Promise<void>;
  onFileProcessed?: (
    file: FileRecord,
    processed: number,
    total: number
  ) => void | Promise<void>;
  onProgress?: ProgressCallback;
}

export function getFileTypeFromGitMode(
  mode: string,
  isBinary: boolean
): FileRecord["file_type"] {
  if (mode === "120000") {
    return "s";
  }

  if (mode === "100755") {
    return "x";
  }

  return isBinary ? "b" : "t";
}

/**
 * Clone or download a GitHub repository at a given commit and compute metadata
 * for every file and directory in it.
 */
export async function processRepository(
  repo: string,
  commit: string,
  workDir: string,
  hooks: ProcessRepositoryHooks = {}
): Promise<FileRecord[]> {
  logger.debug("Starting repository processing", { repo, commit, workDir });
  const repoUrl = getRepositoryUrl(repo);
  const cacheDir = getRepositoryCacheDir(repoUrl, workDir);
  const cloneDir = path.join(workDir, "tree");

  logger.debug("Using repository directories", { cacheDir, cloneDir });
  fs.mkdirSync(workDir, { recursive: true });
  fs.rmSync(cloneDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(cacheDir), { recursive: true });

  if (!fs.existsSync(path.join(cacheDir, ".git"))) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    await runGitCommandWithRetry(path.dirname(cacheDir), [
      "clone",
      "--no-checkout",
      "--",
      repoUrl,
      cacheDir,
    ]);
  }
  await runGitCommandWithRetry(cacheDir, ["fetch", "--depth=1", "origin", commit]);
  fs.cpSync(cacheDir, cloneDir, { recursive: true });
  await runGitCommand(cloneDir, [
    "-c",
    "advice.detachedHead=false",
    "checkout",
    "--detach",
    commit,
  ]);

  const gitEntriesByPath = await getTrackedGitEntries(cloneDir);
  // Gather all file/directory entries (excluding .git)
  const entries = getAllEntries(cloneDir, gitEntriesByPath);
  const total = entries.length;
  logger.debug("Discovered repository entries", { repo, commit, total });
  const initialRecords = entries.map((entry) => createInitialRecord(cloneDir, entry));
  await hooks.onFilesDiscovered?.(initialRecords);
  const records: FileRecord[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const relativePath = path.relative(cloneDir, entry.fullPath);
    let record: FileRecord;

    if (entry.kind === "directory") {
      // For directories, get the last commit that touched any file in them
      const lastCommit = getLastCommit(cloneDir, relativePath);
      const updateDate = getLastUpdateDate(cloneDir, relativePath);
      record = {
        file_type: "d",
        file_name: relativePath,
        file_disk_path: relativePath,
        file_size: 0,
        file_update_date: await updateDate,
        file_last_commit: await lastCommit,
        file_git_hash: "",
      };
    } else {
      const stat =
        entry.kind === "symlink"
          ? fs.lstatSync(entry.fullPath)
          : fs.statSync(entry.fullPath);
      const binary = entry.kind === "file" ? isBinaryFile(entry.fullPath) : false;
      const gitEntry = entry.gitEntry;
      if (!gitEntry) {
        throw new Error(`Failed to read git metadata for path: ${relativePath}`);
      }
      const lastCommit = getLastCommit(cloneDir, relativePath);
      const updateDate = getLastUpdateDate(cloneDir, relativePath);

      record = {
        file_type: getFileTypeFromGitMode(gitEntry.mode, binary),
        file_name: relativePath,
        file_disk_path: relativePath,
        file_size: stat.size,
        file_update_date: await updateDate,
        file_last_commit: await lastCommit,
        file_git_hash: gitEntry.hash,
      };
    }

    records.push(record);
    await hooks.onFileProcessed?.(record, i + 1, total);

    hooks.onProgress?.(i + 1, total);
  }

  logger.debug("Repository processing completed", {
    repo,
    commit,
    totalRecords: records.length,
  });
  return records;
}

function getRepositoryCacheDir(repoUrl: string, workDir: string): string {
  const cacheKey = createHash("sha256").update(repoUrl).digest("hex");
  return path.join(path.dirname(path.resolve(workDir)), "repo-cache", cacheKey);
}

interface EntryInfo {
  fullPath: string;
  kind: "directory" | "file" | "symlink";
  gitEntry?: GitEntryInfo;
}

interface GitEntryInfo {
  mode: string;
  hash: string;
}

function createInitialRecord(repoDir: string, entry: EntryInfo): FileRecord {
  return {
    file_type: getInitialFileType(entry.kind),
    file_name: path.relative(repoDir, entry.fullPath),
    file_disk_path: path.relative(repoDir, entry.fullPath),
    file_size: 0,
    file_update_date: "",
    file_last_commit: "",
    file_git_hash: entry.gitEntry?.hash ?? "",
  };
}

function getInitialFileType(kind: EntryInfo["kind"]): FileRecord["file_type"] {
  if (kind === "directory") {
    return "d";
  }

  if (kind === "symlink") {
    return "s";
  }

  // Regular files are inserted immediately with a temporary text-file marker.
  // Binary/executable detection runs later and updates the row in place.
  return "t";
}

/** Recursively list all files and directories, excluding .git */
function getAllEntries(
  dir: string,
  gitEntriesByPath: Map<string, GitEntryInfo>
): EntryInfo[] {
  const results: EntryInfo[] = [];

  function walk(currentDir: string): void {
    const items = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const item of items) {
      if (item.name === ".git") continue;
      const fullPath = path.join(currentDir, item.name);
      const relativePath = path.relative(dir, fullPath).split(path.sep).join("/");
      const gitEntry = gitEntriesByPath.get(relativePath);
      if (item.isSymbolicLink()) {
        results.push({ fullPath, kind: "symlink", gitEntry });
      } else if (item.isDirectory()) {
        results.push({ fullPath, kind: "directory", gitEntry: undefined });
        walk(fullPath);
      } else {
        results.push({ fullPath, kind: "file", gitEntry });
      }
    }
  }

  walk(dir);
  return results;
}

async function getTrackedGitEntries(repoDir: string): Promise<Map<string, GitEntryInfo>> {
  const out = await runGitCommand(repoDir, ["ls-files", "--stage"]);
  const entries = new Map<string, GitEntryInfo>();

  for (const line of out.split("\n").filter(Boolean)) {
    const match = line.match(/^(\d{6}) ([a-f0-9]{40}) \d+\t(.+)$/);
    if (!match) {
      throw new Error(`Unexpected git ls-files output: ${line}`);
    }

    entries.set(match[3], {
      mode: match[1],
      hash: match[2],
    });
  }

  return entries;
}

async function getHeadReference(
  repoUrl: string
): Promise<{ branchRef: string | null; commit: string | null }> {
  assertSafeGitRepositoryUrl(repoUrl);
  const output = await runGitCommand(
    process.cwd(),
    withRepoArg(["ls-remote", "--symref"], repoUrl, ["HEAD"])
  );
  let branchRef: string | null = null;
  let commit: string | null = null;

  for (const line of output.split("\n").filter(Boolean)) {
    const symrefMatch = line.match(/^ref:\s+(\S+)\s+HEAD$/);
    if (symrefMatch) {
      branchRef = symrefMatch[1];
      continue;
    }

    const [hash, ref] = line.trim().split(/\s+/, 2);
    if (ref === "HEAD" && hash) {
      commit = hash.toLowerCase();
    }
  }

  return { branchRef, commit };
}

function getGitHubRepoName(repoUrl: string): string | null {
  const match = repoUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Get the last commit SHA that touched a given path. */
async function getLastCommit(
  repoDir: string,
  relativePath: string
): Promise<string> {
  // Normalize to POSIX-style paths for git
  const rel = relativePath.split(path.sep).join("/");
  // Use git log to get the latest commit hash for the path
  const out = await runGitCommand(repoDir, [
    "log",
    "-n",
    "1",
    "--pretty=format:%H",
    "--",
    rel,
  ]);
  return out;
}

/** Get the last update date for a given path from git log. */
async function getLastUpdateDate(
  repoDir: string,
  relativePath: string
): Promise<string> {
  const rel = relativePath.split(path.sep).join("/");
  const out = await runGitCommand(repoDir, [
    "log",
    "-n",
    "1",
    "--pretty=format:%cI",
    "--",
    rel,
  ]);
  return out;
}
