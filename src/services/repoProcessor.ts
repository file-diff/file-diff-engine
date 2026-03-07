import fs from "fs";
import path from "path";
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

function getRepositoryUrl(repo: string): string {
  if (repo.includes("://") || path.isAbsolute(repo)) {
    return repo;
  }

  return `https://github.com/${repo}.git`;
}

export async function resolveRefToCommitHash(
  repoUrl: string,
  ref: string
): Promise<string> {
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
    "ls-remote",
    repoUrl,
    ...refCandidates,
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
 * Clone or download a GitHub repository at a given ref and compute metadata
 * for every file and directory in it.
 */
export async function processRepository(
  repo: string,
  ref: string,
  workDir: string,
  hooks: ProcessRepositoryHooks = {}
): Promise<FileRecord[]> {
  logger.debug("Starting repository processing", { repo, ref, workDir });
  const repoUrl = getRepositoryUrl(repo);
  const cloneDir = path.join(workDir, "tree");

  logger.debug("Using clone directory", { cloneDir });
  fs.mkdirSync(cloneDir, { recursive: true });

  await runGitCommand(cloneDir, ["init"]);
  await runGitCommand(cloneDir, ["remote", "add", "origin", repoUrl]);
  await runGitCommand(cloneDir, ["fetch", "--depth=1", "origin", ref]);
  await runGitCommand(cloneDir, [
    "-c",
    "advice.detachedHead=false",
    "checkout",
    "--detach",
    "FETCH_HEAD",
  ]);

  // Gather all file/directory entries (excluding .git)
  const entries = getAllEntries(cloneDir);
  const total = entries.length;
  logger.debug("Discovered repository entries", { repo, ref, total });
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
      const gitEntry = await getGitEntryInfo(cloneDir, relativePath);
      if (!gitEntry) {
        throw new Error(`Failed to read git metadata for path: ${relativePath}`);
      }
      const lastCommit = getLastCommit(cloneDir, relativePath);
      const updateDate = getLastUpdateDate(cloneDir, relativePath);

      record = {
        file_type: getFileTypeFromGitMode(gitEntry.mode, binary),
        file_name: relativePath,
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
    ref,
    totalRecords: records.length,
  });
  return records;
}

interface EntryInfo {
  fullPath: string;
  kind: "directory" | "file" | "symlink";
}

function createInitialRecord(repoDir: string, entry: EntryInfo): FileRecord {
  return {
    file_type: getInitialFileType(entry.kind),
    file_name: path.relative(repoDir, entry.fullPath),
    file_size: 0,
    file_update_date: "",
    file_last_commit: "",
    file_git_hash: "",
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
function getAllEntries(dir: string): EntryInfo[] {
  const results: EntryInfo[] = [];

  function walk(currentDir: string): void {
    const items = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const item of items) {
      if (item.name === ".git") continue;
      const fullPath = path.join(currentDir, item.name);
      if (item.isSymbolicLink()) {
        results.push({ fullPath, kind: "symlink" });
      } else if (item.isDirectory()) {
        results.push({ fullPath, kind: "directory" });
        walk(fullPath);
      } else {
        results.push({ fullPath, kind: "file" });
      }
    }
  }

  walk(dir);
  return results;
}

async function getGitEntryInfo(
  repoDir: string,
  relativePath: string
): Promise<{ mode: string; hash: string } | null> {
  const rel = relativePath.split(path.sep).join("/");
  const out = await runGitCommand(repoDir, ["ls-files", "--stage", "--", rel]);
  if (!out) {
    return null;
  }

  const match = out.match(/^(\d{6}) ([a-f0-9]{40}) \d+\t/);
  if (!match) {
    throw new Error(`Unexpected git ls-files output for path '${rel}': ${out}`);
  }

  return {
    mode: match[1],
    hash: match[2],
  };
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
