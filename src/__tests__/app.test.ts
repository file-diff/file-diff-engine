import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { Queue } from "bullmq";
import { zstdDecompressSync } from "node:zlib";
import type { DatabaseClient } from "../db/database";
import { createApp } from "../app";
import type {
  CommitGrepResponse,
  HealthResponse,
  JobFilesResponse,
  StatsResponse,
  VersionResponse,
} from "../types";
import { JobRepository } from "../db/repository";
import { createTestDatabase } from "./helpers/testDatabase";
import { deserializeFiles } from "../utils/binarySerializer";
import * as githubApi from "../services/githubApi";

async function injectWithViewer(
  app: Awaited<ReturnType<typeof createApp>>["app"],
  options: Parameters<Awaited<ReturnType<typeof createApp>>["app"]["inject"]>[0]
) {
  const headers =
    "headers" in options && options.headers
      ? { authorization: "Bearer viewer-secret", ...options.headers }
      : { authorization: "Bearer viewer-secret" };
  return app.inject({
    ...options,
    headers,
  });
}

describe("createApp", () => {
  let db: DatabaseClient;
  let jobRepo: JobRepository;
  let mockQueue: Queue;
  const originalBuildVersion = process.env.BUILD_VERSION;
  const originalRequestDelayMs = process.env.REQUEST_DELAY_MS;
  const originalPublicGitHubToken = process.env.PUBLIC_GITHUB_TOKEN;
  const originalTmpDir = process.env.TMP_DIR;
  const originalAdminBearerToken = process.env.ADMIN_BEARER_TOKEN;
  const originalViewerBearerToken = process.env.VIEWER_BEARER_TOKEN;
  let tempDirs: string[];

  beforeEach(async () => {
    tempDirs = [];
    db = await createTestDatabase();
    jobRepo = new JobRepository(db);
    mockQueue = {
      add: vi.fn().mockResolvedValue({}),
      close: async () => undefined,
    } as unknown as Queue;
    vi.spyOn(githubApi, "getGitHubRateLimit").mockResolvedValue({
      limit: 60,
      remaining: 59,
      reset: 1_712_345_678,
      used: 1,
      resource: "core",
    });
    process.env.VIEWER_BEARER_TOKEN = "viewer-secret";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalBuildVersion === undefined) {
      delete process.env.BUILD_VERSION;
    } else {
      process.env.BUILD_VERSION = originalBuildVersion;
    }
    if (originalRequestDelayMs === undefined) {
      delete process.env.REQUEST_DELAY_MS;
    } else {
      process.env.REQUEST_DELAY_MS = originalRequestDelayMs;
    }
    if (originalPublicGitHubToken === undefined) {
      delete process.env.PUBLIC_GITHUB_TOKEN;
    } else {
      process.env.PUBLIC_GITHUB_TOKEN = originalPublicGitHubToken;
    }
    if (originalTmpDir === undefined) {
      delete process.env.TMP_DIR;
    } else {
      process.env.TMP_DIR = originalTmpDir;
    }
    if (originalViewerBearerToken === undefined) {
      delete process.env.VIEWER_BEARER_TOKEN;
    } else {
      process.env.VIEWER_BEARER_TOKEN = originalViewerBearerToken;
    }
    if (originalAdminBearerToken === undefined) {
      delete process.env.ADMIN_BEARER_TOKEN;
    } else {
      process.env.ADMIN_BEARER_TOKEN = originalAdminBearerToken;
    }
    for (const tempDir of tempDirs) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    await db.end();
  });

  it("requires the viewer bearer token for health checks", async () => {
    delete process.env.VIEWER_BEARER_TOKEN;
    const { app } = await createApp({ db, queue: mockQueue });

    const response = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: {
        authorization: "Bearer viewer-secret",
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Viewer bearer token is not configured.",
    });

    await app.close();
  });

  it("accepts the admin bearer token for health checks", async () => {
    process.env.ADMIN_BEARER_TOKEN = "admin-secret";
    const { app } = await createApp({ db, queue: mockQueue });

    const response = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: {
        authorization: "Bearer admin-secret",
      },
    });

    expect(response.statusCode).toBe(200);

    await app.close();
  });

  it("does not add CORS headers to health checks", async () => {
    const { app } = await createApp({ db, queue: mockQueue });

    const response = await injectWithViewer(app, {
      method: "GET",
      url: "/api/health",
      headers: {
        origin: "https://frontend.example",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();

    await app.close();
  });

  it("returns GitHub rate limit info in health checks", async () => {
    process.env.PUBLIC_GITHUB_TOKEN = " test-token ";
    vi.spyOn(githubApi, "getGitHubRateLimit").mockResolvedValueOnce({
      limit: 5000,
      remaining: 4999,
      reset: 1_712_345_679,
      used: 1,
      resource: "core",
    });
    const { app } = await createApp({ db, queue: mockQueue });

    const response = await injectWithViewer(app, {
      method: "GET",
      url: "/api/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<HealthResponse>()).toEqual({
      status: "ok",
      message: "API is healthy",
      github: {
        configured: true,
        status: "ok",
        rateLimit: {
          limit: 5000,
          remaining: 4999,
          reset: 1_712_345_679,
          used: 1,
          resource: "core",
        },
      },
    });

    await app.close();
  });

  it("returns GitHub health errors without failing the health endpoint", async () => {
    delete process.env.PUBLIC_GITHUB_TOKEN;
    vi.spyOn(githubApi, "getGitHubRateLimit").mockRejectedValueOnce(
      new githubApi.GitHubApiError("Bad credentials", 401)
    );
    const { app } = await createApp({ db, queue: mockQueue });

    const response = await injectWithViewer(app, {
      method: "GET",
      url: "/api/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<HealthResponse>()).toEqual({
      status: "ok",
      message: "API is healthy",
      github: {
        configured: false,
        status: "error",
        error: "Bad credentials",
      },
    });

    await app.close();
  });

  it("returns the configured build version", async () => {
    process.env.BUILD_VERSION = "2026.03.10+abc1234";
    const { app } = await createApp({ db, queue: mockQueue });

    const response = await injectWithViewer(app, {
      method: "GET",
      url: "/api/version",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<VersionResponse>()).toEqual({
      version: "2026.03.10+abc1234",
    });

    await app.close();
  });

  it("does not delay requests when REQUEST_DELAY_MS is unset", async () => {
    delete process.env.REQUEST_DELAY_MS;
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { app } = await createApp({ db, queue: mockQueue });

    const startedAt = Date.now();
    const response = await injectWithViewer(app, {
      method: "GET",
      url: "/api/health",
    });
    const elapsedMs = Date.now() - startedAt;

    expect(response.statusCode).toBe(200);
    expect(elapsedMs).toBeLessThan(100);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[app] Request delay hook is not enabled.")
    );

    await app.close();
  });

  it("delays requests when REQUEST_DELAY_MS is configured", async () => {
    process.env.REQUEST_DELAY_MS = "40";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app } = await createApp({ db, queue: mockQueue });

    const startedAt = Date.now();
    const response = await injectWithViewer(app, {
      method: "GET",
      url: "/api/health",
    });
    const elapsedMs = Date.now() - startedAt;

    expect(response.statusCode).toBe(200);
    expect(elapsedMs).toBeGreaterThanOrEqual(30);
    expect(elapsedMs).toBeLessThan(150);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[app] Request delay hook is enabled."),
      { requestDelayMs: 40 }
    );

    await app.close();
  });

  it("returns zeroed database storage statistics when no data is stored", async () => {
    const { app } = await createApp({ db, queue: mockQueue });

    const response = await injectWithViewer(app, {
      method: "GET",
      url: "/api/stats",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<StatsResponse>()).toEqual({
      jobsStored: 0,
      filesStored: 0,
      sizeStored: 0,
    });

    await app.close();
  });

  it("returns database storage statistics using stored jobs and file metadata", async () => {
    await jobRepo.createJob(
      "job-1",
      "owner/repo",
      "0123456789abcdef0123456789abcdef01234567"
    );
    await jobRepo.createJob(
      "job-2",
      "owner/repo",
      "1111111111111111111111111111111111111111"
    );
    await jobRepo.insertFiles("job-1", [
      {
        file_type: "t",
        file_name: "README.md",
        file_size: 12,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      {
        file_type: "b",
        file_name: "logo.png",
        file_size: 25,
        file_update_date: "2024-01-02T00:00:00Z",
        file_last_commit: "def456",
        file_git_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    ]);
    await jobRepo.insertFiles("job-2", [
      {
        file_type: "d",
        file_name: "src",
        file_size: 0,
        file_update_date: "2024-01-03T00:00:00Z",
        file_last_commit: "ghi789",
        file_git_hash: "",
      },
    ]);

    const { app } = await createApp({ db, queue: mockQueue });

    const response = await injectWithViewer(app, {
      method: "GET",
      url: "/api/stats",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<StatsResponse>()).toEqual({
      jobsStored: 2,
      filesStored: 3,
      sizeStored: 37,
    });

    await app.close();
  });

  it("returns files for the latest job matching a commit", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    await jobRepo.createJob("job-by-commit", "owner/repo", commit);
    await jobRepo.insertFiles("job-by-commit", [
      {
        file_type: "t",
        file_name: "README.md",
        file_size: 12,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ]);

    const { app } = await createApp({ db, queue: mockQueue });

    const response = await injectWithViewer(app, {
      method: "GET",
      url: `/api/commit/${commit}/files`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<JobFilesResponse>()).toEqual({
      jobId: "job-by-commit",
      commit,
      commitShort: "0123456",
      status: "waiting",
      progress: 0,
      files: [
        {
          t: "t",
          path: "README.md",
          s: 12,
          update: "2024-01-01T00:00:00Z",
          commit: "abc123",
          hash: "aaaaaaaa",
        },
      ],
    });

    await app.close();
  });

  it("returns zstd-compressed json for commit files when requested", async () => {
    const commit = "1123456789abcdef0123456789abcdef01234567";
    await jobRepo.createJob("job-zstd-json", "owner/repo", commit);
    await jobRepo.insertFiles("job-zstd-json", [
      {
        file_type: "t",
        file_name: "README.md",
        file_size: 12,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc12345",
        file_git_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ]);

    const { app } = await createApp({ db, queue: mockQueue });

    const response = await injectWithViewer(app, {
      method: "GET",
      url: `/api/commit/${commit}/files`,
      headers: {
        "accept-encoding": "gzip, zstd",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("zstd");
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["vary"]).toContain("Accept-Encoding");

    const decompressed = zstdDecompressSync(
      (response as unknown as { rawPayload: Buffer }).rawPayload
    ).toString("utf8");

    expect(JSON.parse(decompressed)).toEqual({
      jobId: "job-zstd-json",
      commit,
      commitShort: "1123456",
      status: "waiting",
      progress: 0,
      files: [
        {
          t: "t",
          path: "README.md",
          s: 12,
          update: "2024-01-01T00:00:00Z",
          commit: "abc12345",
          hash: "aaaaaaaa",
        },
      ],
    });

    await app.close();
  });

  it("returns zstd-compressed csv for commit files when requested", async () => {
    const commit = "2123456789abcdef0123456789abcdef01234567";
    await jobRepo.createJob("job-zstd-csv", "owner/repo", commit);
    await jobRepo.insertFiles("job-zstd-csv", [
      {
        file_type: "b",
        file_name: "assets/logo.png",
        file_size: 25,
        file_update_date: "2024-01-02T00:00:00Z",
        file_last_commit: "def4567890",
        file_git_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    ]);

    const { app } = await createApp({ db, queue: mockQueue });

    const response = await injectWithViewer(app, {
      method: "GET",
      url: `/api/commit/${commit}/files?format=csv`,
      headers: {
        "accept-encoding": "zstd",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("zstd");
    expect(response.headers["content-type"]).toContain("text/csv");

    const decompressed = zstdDecompressSync(
      (response as unknown as { rawPayload: Buffer }).rawPayload
    ).toString("utf8");

    expect(decompressed).toBe(
      "jobId,commit,commitShort,status,progress,file_type,file_name,file_size,file_update_date,file_last_commit,file_git_hash\n" +
        "job-zstd-csv,2123456789abcdef0123456789abcdef01234567,2123456,waiting,0,b,assets/logo.png,25,2024-01-02T00:00:00Z,def45678,bbbbbbbb"
    );

    await app.close();
  });

  it("returns zstd-compressed binary for commit files when requested", async () => {
    const commit = "3123456789abcdef0123456789abcdef01234567";
    await jobRepo.createJob("job-zstd-binary", "owner/repo", commit);
    await jobRepo.insertFiles("job-zstd-binary", [
      {
        file_type: "x",
        file_name: "bin/run.sh",
        file_size: 42,
        file_update_date: "2024-01-03T00:00:00Z",
        file_last_commit: "fedcba9876543210",
        file_git_hash: "cccccccccccccccccccccccccccccccccccccccc",
      },
    ]);

    const { app } = await createApp({ db, queue: mockQueue });

    const response = await injectWithViewer(app, {
      method: "GET",
      url: `/api/commit/${commit}/files?format=binary`,
      headers: {
        "accept-encoding": "br, zstd;q=1.0",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("zstd");
    expect(response.headers["content-type"]).toContain("application/octet-stream");

    const decompressed = zstdDecompressSync(
      (response as unknown as { rawPayload: Buffer }).rawPayload
    );

    expect(deserializeFiles(decompressed)).toEqual([
      {
        fileType: "x",
        fileName: "bin/run.sh",
        updateTimestamp: Math.floor(new Date("2024-01-03T00:00:00Z").getTime() / 1000),
        fileSize: 42,
        commitHex: "fedcba98",
        hashHex: "cccccccc",
      },
    ]);

    await app.close();
  });

  it("returns 404 for an unknown commit files endpoint", async () => {
    const { app } = await createApp({ db, queue: mockQueue });

    const response = await injectWithViewer(app, {
      method: "GET",
      url: "/api/commit/0123456789abcdef0123456789abcdef01234567/files",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: "Job not found.",
    });

    await app.close();
  });

  it("greps text files for a processed commit without creating a new job", async () => {
    const commit = "4123456789abcdef0123456789abcdef01234567";
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-commit-grep-"));
    tempDirs.push(tmpDir);
    process.env.TMP_DIR = tmpDir;

    const treeDir = path.join(tmpDir, "fde-job-grep", "tree", "src");
    fs.mkdirSync(treeDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "fde-job-grep", "tree", "README.md"),
      "hello world\nfind me here\n"
    );
    fs.writeFileSync(
      path.join(treeDir, "index.ts"),
      "const value = 'find me here';\nconst other = 'nope';\n"
    );
    fs.writeFileSync(path.join(tmpDir, "fde-job-grep", "tree", "image.bin"), Buffer.from([0, 1, 2]));

    await jobRepo.createJob("job-grep", "owner/repo", commit);
    await jobRepo.insertFiles("job-grep", [
      {
        file_type: "t",
        file_name: "README.md",
        file_disk_path: "README.md",
        file_size: 24,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      {
        file_type: "x",
        file_name: "src/index.ts",
        file_disk_path: "src/index.ts",
        file_size: 54,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "def456",
        file_git_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      {
        file_type: "b",
        file_name: "image.bin",
        file_disk_path: "image.bin",
        file_size: 3,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "ghi789",
        file_git_hash: "cccccccccccccccccccccccccccccccccccccccc",
      },
    ]);

    const { app } = await createApp({ db, queue: mockQueue });

    const response = await injectWithViewer(app, {
      method: "GET",
      url: `/api/commit/${commit}/grep?query=find%20me%20here`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<CommitGrepResponse>()).toEqual({
      jobId: "job-grep",
      commit,
      commitShort: "4123456",
      status: "waiting",
      progress: 0,
      query: "find me here",
      matches: [
        {
          path: "README.md",
          lineNumber: 2,
          line: "find me here",
        },
        {
          path: "src/index.ts",
          lineNumber: 1,
          line: "const value = 'find me here';",
        },
      ],
    });
    expect((mockQueue as unknown as { add: ReturnType<typeof vi.fn> }).add).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 400 when commit grep query is missing", async () => {
    const commit = "5123456789abcdef0123456789abcdef01234567";
    await jobRepo.createJob("job-grep-empty", "owner/repo", commit);

    const { app } = await createApp({ db, queue: mockQueue });

    const response = await injectWithViewer(app, {
      method: "GET",
      url: `/api/commit/${commit}/grep`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Query parameter 'query' is required.",
    });

    await app.close();
  });

  it("returns files for a job found by short commit prefix", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    await jobRepo.createJob("job-short-commit", "owner/repo", commit);
    await jobRepo.insertFiles("job-short-commit", [
      {
        file_type: "t",
        file_name: "README.md",
        file_size: 12,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ]);

    const { app } = await createApp({ db, queue: mockQueue });
    const shortCommit = commit.slice(0, 8);

    const response = await injectWithViewer(app, {
      method: "GET",
      url: `/api/commit/${shortCommit}/files`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<JobFilesResponse>();
    expect(body.commit).toBe(commit);
    expect(body.files).toHaveLength(1);

    await app.close();
  });

  it("returns 400 for an ambiguous short commit prefix", async () => {
    const commit1 = "ab11111111111111111111111111111111111111";
    const commit2 = "ab22222222222222222222222222222222222222";
    await jobRepo.createJob("job-ambig-a", "owner/repo", commit1);
    await jobRepo.createJob("job-ambig-b", "owner/repo", commit2);

    const { app } = await createApp({ db, queue: mockQueue });

    const response = await injectWithViewer(app, {
      method: "GET",
      url: "/api/commit/ab/files",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Multiple");

    await app.close();
  });
});
