import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Queue } from "bullmq";
import type { DatabaseClient } from "../db/database";
import { createApp } from "../app";
import type { JobFilesResponse, StatsResponse, VersionResponse } from "../types";
import { JobRepository } from "../db/repository";
import { createTestDatabase } from "./helpers/testDatabase";

describe("createApp", () => {
  let db: DatabaseClient;
  let jobRepo: JobRepository;
  let mockQueue: Queue;
  const originalBuildVersion = process.env.BUILD_VERSION;
  const originalRequestDelayMs = process.env.REQUEST_DELAY_MS;

  beforeEach(async () => {
    db = await createTestDatabase();
    jobRepo = new JobRepository(db);
    mockQueue = {
      close: async () => undefined,
    } as unknown as Queue;
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
    await db.end();
  });

  it("does not add CORS headers to health checks", async () => {
    const { app } = await createApp({ db, queue: mockQueue });

    const response = await app.inject({
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

  it("returns the configured build version", async () => {
    process.env.BUILD_VERSION = "2026.03.10+abc1234";
    const { app } = await createApp({ db, queue: mockQueue });

    const response = await app.inject({
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
    const response = await app.inject({
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
    const response = await app.inject({
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

    const response = await app.inject({
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

    const response = await app.inject({
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

    const response = await app.inject({
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
          hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      ],
    });

    await app.close();
  });

  it("returns 404 for an unknown commit files endpoint", async () => {
    const { app } = await createApp({ db, queue: mockQueue });

    const response = await app.inject({
      method: "GET",
      url: "/api/commit/0123456789abcdef0123456789abcdef01234567/files",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: "Job not found.",
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

    const response = await app.inject({
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

    const response = await app.inject({
      method: "GET",
      url: "/api/commit/ab/files",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Multiple");

    await app.close();
  });
});
