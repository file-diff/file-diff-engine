import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { FileRecord } from "../types";
import { createLogger } from "../utils/logger";

const execFileAsync = promisify(execFile);
const logger = createLogger("repo-processor");

/**
 * Helper to run git commands in a working directory and return stdout (trimmed).
 */
async function runGitCommand(cwd: string, args: string[]): Promise<string> {
  const command = `git ${args.join(" ")}`;
  logger.debug("Running git command", { cwd, command });

  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd });
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

/** SHA-256 hex digest of a file's content. */
function sha256File(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

export interface ProgressCallback {
  (processed: number, total: number): void;
}

/**
 * Clone or download a GitHub repository at a given ref and compute metadata
 * for every file and directory in it.
 */
export async function processRepository(
  repo: string,
  ref: string,
  workDir: string,
  onProgress?: ProgressCallback
): Promise<FileRecord[]> {
  logger.debug("Starting repository processing", { repo, ref, workDir });
  // Clone the repository
  const repoUrl = `https://github.com/${repo}.git`;
  const cloneDir = path.join(workDir, "repo");

  if (fs.existsSync(cloneDir)) {
    fs.rmSync(cloneDir, { recursive: true, force: true });
  }

  // Use the system git to clone and checkout
  await runGitCommand(workDir, ["clone", repoUrl, cloneDir]);
  await runGitCommand(cloneDir, ["checkout", ref]);

  // Gather all file/directory entries (excluding .git)
  const entries = getAllEntries(cloneDir);
  const total = entries.length;
  logger.debug("Discovered repository entries", { repo, ref, total });
  const records: FileRecord[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const relativePath = path.relative(cloneDir, entry.fullPath);

    if (entry.isDirectory) {
      // For directories, get the last commit that touched any file in them
      const lastCommit = getLastCommit(cloneDir, relativePath);
      const updateDate = getLastUpdateDate(cloneDir, relativePath);
      records.push({
        file_type: "d",
        file_name: relativePath,
        file_size: 0,
        file_update_date: await updateDate,
        file_last_commit: await lastCommit,
        file_sha256_hash: "",
      });
    } else {
      const stat = fs.statSync(entry.fullPath);
      const binary = isBinaryFile(entry.fullPath);
      const hash = sha256File(entry.fullPath);
      const lastCommit = getLastCommit(cloneDir, relativePath);
      const updateDate = getLastUpdateDate(cloneDir, relativePath);

      records.push({
        file_type: binary ? "b" : "t",
        file_name: relativePath,
        file_size: stat.size,
        file_update_date: await updateDate,
        file_last_commit: await lastCommit,
        file_sha256_hash: hash,
      });
    }

    if (onProgress) {
      onProgress(i + 1, total);
    }
  }

  logger.debug("Repository processing completed", {
    repo,
    ref,
    totalRecords: records.length,
  });
  return records;
}

interface EntryInfo {
  fullPath: string;
  isDirectory: boolean;
}

/** Recursively list all files and directories, excluding .git */
function getAllEntries(dir: string): EntryInfo[] {
  const results: EntryInfo[] = [];

  function walk(currentDir: string): void {
    const items = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const item of items) {
      if (item.name === ".git") continue;
      const fullPath = path.join(currentDir, item.name);
      if (item.isDirectory()) {
        results.push({ fullPath, isDirectory: true });
        walk(fullPath);
      } else {
        results.push({ fullPath, isDirectory: false });
      }
    }
  }

  walk(dir);
  return results;
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
