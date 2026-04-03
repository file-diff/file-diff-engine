import path from "path";
import { timingSafeEqual } from "crypto";
import { Queue } from "bullmq";
import { JobRepository } from "../../db/repository";
import { createLogger } from "../../utils/logger";

export const POSTGRES_UNIQUE_VIOLATION = "23505";
export const DEFAULT_DOWNLOAD_RATE_LIMIT_MAX = 30;
export const DEFAULT_DOWNLOAD_RATE_LIMIT_WINDOW_MS = 60_000;
export const REVERT_TO_COMMIT_BEARER_TOKEN_ENV = "REVERT_TO_COMMIT_BEARER_TOKEN";
export const MERGE_BRANCH_BEARER_TOKEN_ENV = "MERGE_BRANCH_BEARER_TOKEN";
export const CREATE_TASK_BEARER_TOKEN_ENV = "CREATE_TASK_BEARER_TOKEN";
export const logger = createLogger("job-routes");

export interface JobRoutesDependencies {
  queue: Queue;
  jobRepo: JobRepository;
}

export function normalizeRepo(repo: string): string {
  return repo.replace("https://github.com/", "").replace(".git", "").trim();
}

export function isValidRepo(repo: string): boolean {
  return /^[\w.\-]+\/[\w.\-]+$/.test(repo);
}

export function isValidOrganization(organization: string): boolean {
  return /^[\w.\-]+$/.test(organization);
}

export function resolveJobFilePath(jobId: string, storedPath: string): string {
  const tmpDir = process.env.TMP_DIR || "tmp";
  const jobRoot = path.resolve(tmpDir, `fde-${jobId}`, "tree");
  const resolvedPath = path.resolve(jobRoot, storedPath);
  const relativePath = path.relative(jobRoot, resolvedPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(
      `Stored file path '${storedPath}' for job '${jobId}' resolves outside the job directory.`
    );
  }

  return resolvedPath;
}

export function getDownloadFilename(fileName: string): string {
  const sanitizedBaseName = path
    .basename(fileName)
    .replace(/[^A-Za-z0-9._-]/g, "_");

  return sanitizedBaseName || "file";
}

export function parsePositiveInteger(
  value: string | undefined,
  fallback: number
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export function getConfiguredBearerToken(envName: string): string | null {
  const token = process.env[envName]?.trim();
  return token ? token : null;
}

export function matchesBearerToken(
  authorizationHeader: string | string[] | undefined,
  expectedToken: string
): boolean {
  if (typeof authorizationHeader !== "string") {
    return false;
  }

  const [scheme, ...credentials] = authorizationHeader.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || credentials.length !== 1) {
    return false;
  }

  const providedToken = credentials[0];
  const expectedBuffer = Buffer.from(expectedToken, "utf8");
  const providedBuffer = Buffer.from(providedToken, "utf8");

  return (
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer)
  );
}
