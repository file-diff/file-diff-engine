import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Fastify, { type FastifyInstance } from "fastify";
import type { DatabaseClient } from "../db/database";
import { JobRepository } from "../db/repository";
import { createJobRoutes } from "../routes/jobs";
import { Queue } from "bullmq";
import type {
  ListRefsResponse,
  ListOrganizationRepositoriesResponse,
  JobFilesResponse,
  JobInfo,
  JobSummary,
  ResolveCommitResponse,
  ResolvePullRequestResponse,
} from "../types";
import { createTestDatabase } from "./helpers/testDatabase";
import * as githubApi from "../services/githubApi";
import * as repoProcessor from "../services/repoProcessor";

async function makeRequest(
  app: FastifyInstance,
  method: string,
  url: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const response = await app.inject({
    method,
    url,
    payload: body,
    headers: body ? { "content-type": "application/json" } : undefined,
  });

  return {
    status: response.statusCode,
    body: response.json(),
  };
}

describe("Job Routes", () => {
  let db: DatabaseClient;
  let jobRepo: JobRepository;
  let app: FastifyInstance;
  let mockQueue: Queue;
  let tempDirs: string[];
  const commitHash = "0123456789abcdef0123456789abcdef01234567";
  const fileHash = "1111111111111111111111111111111111111111";
  const originalTmpDir = process.env.TMP_DIR;
  const originalDownloadRateLimitMax = process.env.DOWNLOAD_BY_HASH_RATE_LIMIT_MAX;
  const originalDownloadRateLimitWindowMs =
    process.env.DOWNLOAD_BY_HASH_RATE_LIMIT_WINDOW_MS;

  beforeEach(async () => {
    tempDirs = [];
    db = await createTestDatabase();
    jobRepo = new JobRepository(db);

    mockQueue = {
      add: vi.fn().mockResolvedValue({}),
    } as unknown as Queue;

    app = Fastify();
    await app.register(createJobRoutes(mockQueue, jobRepo), {
      prefix: "/api/jobs",
    });
  });

  afterEach(async () => {
    if (originalTmpDir === undefined) {
      delete process.env.TMP_DIR;
    } else {
      process.env.TMP_DIR = originalTmpDir;
    }
    if (originalDownloadRateLimitMax === undefined) {
      delete process.env.DOWNLOAD_BY_HASH_RATE_LIMIT_MAX;
    } else {
      process.env.DOWNLOAD_BY_HASH_RATE_LIMIT_MAX = originalDownloadRateLimitMax;
    }
    if (originalDownloadRateLimitWindowMs === undefined) {
      delete process.env.DOWNLOAD_BY_HASH_RATE_LIMIT_WINDOW_MS;
    } else {
      process.env.DOWNLOAD_BY_HASH_RATE_LIMIT_WINDOW_MS =
        originalDownloadRateLimitWindowMs;
    }
    for (const tempDir of tempDirs) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    await app.close();
    await db.end();
  });

  it("POST /api/jobs/resolve - should resolve a ref to a commit", async () => {
    const resolveSpy = vi
      .spyOn(repoProcessor, "resolveRefToCommitHash")
      .mockResolvedValue(commitHash);

    const res = await makeRequest(app, "POST", "/api/jobs/resolve", {
      repo: "https://github.com/facebook/react.git",
      ref: " main ",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual<ResolveCommitResponse>({
      repo: "facebook/react",
      ref: "main",
      commit: commitHash,
      commitShort: commitHash.slice(0, 7),
    });
    expect(resolveSpy).toHaveBeenCalledWith(
      "https://github.com/facebook/react.git",
      "main"
    );
  });

  it("POST /api/jobs/resolve - should reject missing fields", async () => {
    const res = await makeRequest(app, "POST", "/api/jobs/resolve", {
      repo: "facebook/react",
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Both 'repo' and 'ref' are required.",
    });
  });

  it("POST /api/jobs/resolve - should return 404 when the ref cannot be resolved", async () => {
    vi.spyOn(repoProcessor, "resolveRefToCommitHash").mockRejectedValue(
      new Error(
        "Unable to resolve git ref 'missing-branch' for repository 'https://github.com/facebook/react.git'."
      )
    );

    const res = await makeRequest(app, "POST", "/api/jobs/resolve", {
      repo: "facebook/react",
      ref: "missing-branch",
    });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error:
        "Unable to resolve git ref 'missing-branch' for repository 'https://github.com/facebook/react.git'.",
    });
  });

  it("POST /api/jobs/refs - should list refs for a repository", async () => {
    const refs: ListRefsResponse["refs"] = [
      {
        name: "main",
        ref: "refs/heads/main",
        type: "branch",
        commit: commitHash,
        commitShort: commitHash.slice(0, 7),
      },
      {
        name: "v1.0.0",
        ref: "refs/tags/v1.0.0",
        type: "tag",
        commit: commitHash,
        commitShort: commitHash.slice(0, 7),
      },
    ];
    const listRefsSpy = vi
      .spyOn(repoProcessor, "listRepositoryRefs")
      .mockResolvedValue(refs);

    const res = await makeRequest(app, "POST", "/api/jobs/refs", {
      repo: "https://github.com/facebook/react.git",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual<ListRefsResponse>({
      repo: "facebook/react",
      refs,
    });
    expect(listRefsSpy).toHaveBeenCalledWith("https://github.com/facebook/react.git");
  });

  it("POST /api/jobs/refs - should reject missing repo", async () => {
    const res = await makeRequest(app, "POST", "/api/jobs/refs", {});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Field 'repo' is required.",
    });
  });

  it("POST /api/jobs/refs - should return 500 when refs cannot be listed", async () => {
    vi.spyOn(repoProcessor, "listRepositoryRefs").mockRejectedValue(
      new Error("Unable to list refs for repository 'https://github.com/facebook/react.git'.")
    );

    const res = await makeRequest(app, "POST", "/api/jobs/refs", {
      repo: "facebook/react",
    });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Unable to list refs for repository 'https://github.com/facebook/react.git'.",
    });
  });

  it("POST /api/jobs/pull-request/resolve - should resolve a pull request URL", async () => {
    const resolvePullRequestSpy = vi
      .spyOn(githubApi, "resolvePullRequest")
      .mockResolvedValue({
        repo: "facebook/react",
        repositoryUrl: "https://github.com/facebook/react",
        sourceCommit: commitHash,
        sourceCommitShort: commitHash.slice(0, 7),
        targetCommit: fileHash,
        targetCommitShort: fileHash.slice(0, 7),
      });

    const res = await makeRequest(app, "POST", "/api/jobs/pull-request/resolve", {
      pullRequestUrl: " https://github.com/facebook/react/pull/123 ",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual<ResolvePullRequestResponse>({
      repo: "facebook/react",
      repositoryUrl: "https://github.com/facebook/react",
      sourceCommit: commitHash,
      sourceCommitShort: commitHash.slice(0, 7),
      targetCommit: fileHash,
      targetCommitShort: fileHash.slice(0, 7),
    });
    expect(resolvePullRequestSpy).toHaveBeenCalledWith(
      "https://github.com/facebook/react/pull/123"
    );
  });

  it("POST /api/jobs/pull-request/resolve - should reject missing pullRequestUrl", async () => {
    const res = await makeRequest(app, "POST", "/api/jobs/pull-request/resolve", {});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Field 'pullRequestUrl' is required.",
    });
  });

  it("POST /api/jobs/pull-request/resolve - should surface GitHub API errors", async () => {
    vi.spyOn(githubApi, "resolvePullRequest").mockRejectedValue(
      new githubApi.GitHubApiError(
        "Invalid pull request URL. Expected a full GitHub pull request URL.",
        400
      )
    );

    const res = await makeRequest(app, "POST", "/api/jobs/pull-request/resolve", {
      pullRequestUrl: "not-a-url",
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Invalid pull request URL. Expected a full GitHub pull request URL.",
    });
  });

  it("GET /api/jobs/organizations/:organization/repositories - should list repositories", async () => {
    const listOrganizationRepositoriesSpy = vi
      .spyOn(githubApi, "listOrganizationRepositories")
      .mockResolvedValue({
        organization: "facebook",
        repositories: [
          {
            name: "react",
            repo: "facebook/react",
            repositoryUrl: "https://github.com/facebook/react",
          },
        ],
      });

    const res = await makeRequest(
      app,
      "GET",
      "/api/jobs/organizations/facebook/repositories"
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual<ListOrganizationRepositoriesResponse>({
      organization: "facebook",
      repositories: [
        {
          name: "react",
          repo: "facebook/react",
          repositoryUrl: "https://github.com/facebook/react",
        },
      ],
    });
    expect(listOrganizationRepositoriesSpy).toHaveBeenCalledWith("facebook");
  });

  it("GET /api/jobs/organizations/:organization/repositories - should reject invalid organization", async () => {
    const res = await makeRequest(
      app,
      "GET",
      "/api/jobs/organizations/facebook/react/repositories"
    );

    expect(res.status).toBe(404);
  });

  it("GET /api/jobs/organizations/:organization/repositories - should surface GitHub API errors", async () => {
    vi.spyOn(githubApi, "listOrganizationRepositories").mockRejectedValue(
      new githubApi.GitHubApiError("GitHub organization 'missing-org' was not found.", 404)
    );

    const res = await makeRequest(
      app,
      "GET",
      "/api/jobs/organizations/missing-org/repositories"
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: "GitHub organization 'missing-org' was not found.",
    });
  });

  it("POST /api/jobs - should create a job", async () => {
    const res = await makeRequest(app, "POST", "/api/jobs", {
      repo: "facebook/react",
      commit: commitHash.toUpperCase(),
    });
    expect(res.status).toBe(201);
    const resBody = res.body as JobSummary;
    expect(resBody.id).toBe(commitHash);
    expect(resBody.status).toBe("waiting");
    expect(resBody.commit).toBe(commitHash);
    expect(resBody.commitShort).toBe(commitHash.slice(0, 7));
    expect(mockQueue.add).toHaveBeenCalledWith(
      "process-repo",
      {
        jobId: commitHash,
        repoName: "facebook/react",
        commit: commitHash,
      },
      {
        jobId: commitHash,
      }
    );
  });

  it("POST /api/jobs - should reuse an existing job for the same commit", async () => {
    const firstResponse = await makeRequest(app, "POST", "/api/jobs", {
      repo: "facebook/react",
      commit: commitHash,
    });
    expect(firstResponse.status).toBe(201);

    const secondResponse = await makeRequest(app, "POST", "/api/jobs", {
      repo: "file-diff/file-diff-engine",
      commit: commitHash,
    });
    expect(secondResponse.status).toBe(200);
    expect(secondResponse.body).toEqual({
      id: commitHash,
      status: "waiting",
      commit: commitHash,
      commitShort: commitHash.slice(0, 7),
    });
    expect(mockQueue.add).toHaveBeenCalledTimes(1);
  });

  it("POST /api/jobs - should reject missing fields", async () => {
    const res = await makeRequest(app, "POST", "/api/jobs", {
      repo: "facebook/react",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/jobs - should reject invalid repo format", async () => {
    const res = await makeRequest(app, "POST", "/api/jobs", {
      repo: "invalid-format",
      commit: commitHash,
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/jobs - should reject invalid commit format", async () => {
    const res = await makeRequest(app, "POST", "/api/jobs", {
      repo: "facebook/react",
      commit: "main",
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/jobs/:id - should return job info", async () => {
    await jobRepo.createJob(commitHash, "owner/repo", commitHash);
    const res = await makeRequest(app, "GET", `/api/jobs/${commitHash}`);
    expect(res.status).toBe(200);
    const resBody = res.body as JobInfo;
    expect(resBody.id).toBe(commitHash);
    expect(resBody.status).toBe("waiting");
    expect(resBody.commit).toBe(commitHash);
    expect(resBody.commitShort).toBe(commitHash.slice(0, 7));
  });

  it("GET /api/jobs/:id - should return 404 for unknown job", async () => {
    const res = await makeRequest(app, "GET", "/api/jobs/unknown-id");
    expect(res.status).toBe(404);
  });

  it("GET /api/jobs/:id/files - should return files for a job", async () => {
    await jobRepo.createJob(commitHash, "owner/repo", commitHash);
    await jobRepo.insertFiles(commitHash, [
      {
        file_type: "t",
        file_name: "README.md",
        file_size: 50,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: "deadbeef",
      },
    ]);
    const res = await makeRequest(app, "GET", `/api/jobs/${commitHash}/files`);
    expect(res.status).toBe(200);
    const resBody = res.body as JobFilesResponse;
    expect(resBody.jobId).toBe(commitHash);
    expect(resBody.commit).toBe(commitHash);
    expect(resBody.commitShort).toBe(commitHash.slice(0, 7));
    expect(resBody.status).toBe("waiting");
    expect(resBody.progress).toBe(0);
    expect(resBody.files).toHaveLength(1);
    expect(resBody.files[0]).toEqual({
      t: "t",
      path: "README.md",
      s: 50,
      update: "2024-01-01T00:00:00Z",
      commit: "abc123",
      hash: "deadbeef",
    });
  });

  it("GET /api/jobs/:id/files - should return 404 for unknown job", async () => {
    const res = await makeRequest(app, "GET", "/api/jobs/unknown-id/files");
    expect(res.status).toBe(404);
  });

  it("GET /api/jobs/:id/files/hash/:hash/download - should stream the file contents", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-download-"));
    tempDirs.push(tmpDir);
    process.env.TMP_DIR = tmpDir;
    const treeDir = path.join(tmpDir, `fde-${commitHash}`, "tree");
    fs.mkdirSync(treeDir, { recursive: true });
    fs.writeFileSync(path.join(treeDir, "README.md"), "hello from disk");

    await jobRepo.createJob(commitHash, "owner/repo", commitHash);
    await jobRepo.insertFiles(commitHash, [
      {
        file_type: "t",
        file_name: "README.md",
        file_disk_path: "README.md",
        file_size: 15,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: fileHash,
      },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/api/jobs/${commitHash}/files/hash/${fileHash}/download`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers["content-type"]).toContain("application/octet-stream");
    expect(response.headers["content-disposition"]).toContain('filename="README.md"');
    expect((response as unknown as { rawPayload: Buffer }).rawPayload.toString("utf8")).toBe(
      "hello from disk"
    );
  });

  it("GET /api/jobs/:id/files/hash/:hash/download - should report when the hash is missing from the database", async () => {
    await jobRepo.createJob(commitHash, "owner/repo", commitHash);

    const response = await app.inject({
      method: "GET",
      url: `/api/jobs/${commitHash}/files/hash/${fileHash}/download`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: `File with hash '${fileHash}' was not found for job '${commitHash}' in the database.`,
    });
  });

  it("GET /api/jobs/:id/files/hash/:hash/download - should report when the file is missing on disk", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-download-missing-"));
    tempDirs.push(tmpDir);
    process.env.TMP_DIR = tmpDir;

    await jobRepo.createJob(commitHash, "owner/repo", commitHash);
    await jobRepo.insertFiles(commitHash, [
      {
        file_type: "t",
        file_name: "README.md",
        file_disk_path: "README.md",
        file_size: 15,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: fileHash,
      },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/api/jobs/${commitHash}/files/hash/${fileHash}/download`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error:
        `File with hash '${fileHash}' was found in the database for job '${commitHash}', ` +
        `but the file is missing or unreadable on disk at '${path.join(
          tmpDir,
          `fde-${commitHash}`,
          "tree",
          "README.md"
        )}'. ENOENT: no such file or directory, access '${path.join(
          tmpDir,
          `fde-${commitHash}`,
          "tree",
          "README.md"
        )}'`,
    });
  });

  it("GET /api/jobs/:id/files/hash/:hash/download - should rate limit repeated download attempts", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-download-rate-limit-"));
    tempDirs.push(tmpDir);
    process.env.TMP_DIR = tmpDir;
    process.env.DOWNLOAD_BY_HASH_RATE_LIMIT_MAX = "1";
    process.env.DOWNLOAD_BY_HASH_RATE_LIMIT_WINDOW_MS = "60000";
    await app.close();
    app = Fastify();
    await app.register(createJobRoutes(mockQueue, jobRepo), {
      prefix: "/api/jobs",
    });

    const treeDir = path.join(tmpDir, `fde-${commitHash}`, "tree");
    fs.mkdirSync(treeDir, { recursive: true });
    fs.writeFileSync(path.join(treeDir, "README.md"), "hello from disk");

    await jobRepo.createJob(commitHash, "owner/repo", commitHash);
    await jobRepo.insertFiles(commitHash, [
      {
        file_type: "t",
        file_name: "README.md",
        file_disk_path: "README.md",
        file_size: 15,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: fileHash,
      },
    ]);

    const firstResponse = await app.inject({
      method: "GET",
      url: `/api/jobs/${commitHash}/files/hash/${fileHash}/download`,
    });
    expect(firstResponse.statusCode).toBe(200);

    const secondResponse = await app.inject({
      method: "GET",
      url: `/api/jobs/${commitHash}/files/hash/${fileHash}/download`,
    });

    expect(secondResponse.statusCode).toBe(429);
    expect(secondResponse.headers["retry-after"]).toBe("60");
    expect(secondResponse.json()).toEqual({
      statusCode: 429,
      error: "Too Many Requests",
      message: "Rate limit exceeded, retry in 1 minute",
    });
  });
});
