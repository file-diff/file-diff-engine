import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Fastify, { type FastifyInstance } from "fastify";
import type { DatabaseClient } from "../db/database";
import { JobRepository } from "../db/repository";
import { createJobRoutes } from "../routes/jobs";
import {
  difftCommandRunner,
  shikiTokenizer,
} from "../routes/jobs/downloadRoutes";
import { Queue } from "bullmq";
import type {
  ListCommitsGraphResponse,
  GitCacheStatsResponse,
  ListCommitsResponse,
  ListRefsResponse,
  ListOrganizationRepositoriesResponse,
  JobFilesResponse,
  JobInfo,
  JobSummary,
  RevertToCommitResponse,
  ResolveCommitResponse,
  ResolvePullRequestResponse,
} from "../types";
import { createTestDatabase } from "./helpers/testDatabase";
import * as githubOperations from "../github/operations";
import * as githubApi from "../services/githubApi";
import * as repoProcessor from "../services/repoProcessor";

async function makeRequest(
  app: FastifyInstance,
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; body: unknown }> {
  const response = await app.inject({
    method,
    url,
    payload: body,
    headers: body
      ? { "content-type": "application/json", ...headers }
      : headers,
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
  const otherFileHash = "2222222222222222222222222222222222222222";
  const originalTmpDir = process.env.TMP_DIR;
  const originalDownloadRateLimitMax = process.env.DOWNLOAD_BY_HASH_RATE_LIMIT_MAX;
  const originalDownloadRateLimitWindowMs =
    process.env.DOWNLOAD_BY_HASH_RATE_LIMIT_WINDOW_MS;
  const originalRevertBearerToken = process.env.REVERT_TO_COMMIT_BEARER_TOKEN;

  beforeEach(async () => {
    tempDirs = [];
    db = await createTestDatabase();
    jobRepo = new JobRepository(db);

    mockQueue = {
      add: vi.fn().mockResolvedValue({}),
      getJob: vi.fn().mockResolvedValue(undefined),
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
    if (originalRevertBearerToken === undefined) {
      delete process.env.REVERT_TO_COMMIT_BEARER_TOKEN;
    } else {
      process.env.REVERT_TO_COMMIT_BEARER_TOKEN = originalRevertBearerToken;
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

  it("POST /api/jobs/revert-to-commit - should run the revert operation", async () => {
    process.env.REVERT_TO_COMMIT_BEARER_TOKEN = " route-secret ";
    const revertResponse: RevertToCommitResponse = {
      repo: "facebook/react",
      branch: "main",
      commit: commitHash,
      commitShort: commitHash.slice(0, 7),
      revertBranch: "revert-to-0123456-1",
      revertCommit: fileHash,
      revertCommitShort: fileHash.slice(0, 7),
      pullRequest: {
        number: 42,
        title: "Restore main to 0123456",
        url: "https://github.com/facebook/react/pull/42",
      },
      log: [
        {
          message:
            "Cloned branch 'main' from 'https://github.com/facebook/react.git' into the temporary workspace.",
        },
        { message: "Pushed branch 'revert-to-0123456-1' to 'origin'." },
      ],
    };
    const revertSpy = vi
      .spyOn(githubOperations, "revertToCommit")
      .mockResolvedValue(revertResponse);

    const res = await makeRequest(app, "POST", "/api/jobs/revert-to-commit", {
      repo: "https://github.com/facebook/react.git",
      commit: commitHash,
      githubKey: " portal-token ",
    }, {
      authorization: "Bearer route-secret",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(revertResponse);
    expect(revertSpy).toHaveBeenCalledWith(expect.objectContaining({
      repo: "facebook/react",
      commit: commitHash,
      branch: "main",
      githubKey: "portal-token",
    }));
    const calledOptions = revertSpy.mock.calls[0][0];
    expect(calledOptions.workDir).toContain(path.join("operations", "fde-github-revert-"));
  });

  it("POST /api/jobs/revert-to-commit - should require a valid bearer token", async () => {
    process.env.REVERT_TO_COMMIT_BEARER_TOKEN = "route-secret";

    const res = await makeRequest(app, "POST", "/api/jobs/revert-to-commit", {
      repo: "facebook/react",
      commit: commitHash,
    });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: "Bearer token is required.",
    });
  });

  it("POST /api/jobs/revert-to-commit - should fail closed when bearer auth is not configured", async () => {
    delete process.env.REVERT_TO_COMMIT_BEARER_TOKEN;

    const res = await makeRequest(
      app,
      "POST",
      "/api/jobs/revert-to-commit",
      {
        repo: "facebook/react",
        commit: commitHash,
      },
      {
        authorization: "Bearer route-secret",
      }
    );

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: "Revert-to-commit bearer token is not configured.",
    });
  });

  it("POST /api/jobs/revert-to-commit - should reject invalid commit hashes", async () => {
    process.env.REVERT_TO_COMMIT_BEARER_TOKEN = "route-secret";

    const res = await makeRequest(app, "POST", "/api/jobs/revert-to-commit", {
      repo: "facebook/react",
      commit: "abc123",
    }, {
      authorization: "Bearer route-secret",
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Field 'commit' must be a full 40-character commit SHA.",
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

  it("POST /api/jobs/commits - should list commits for a repository", async () => {
    const listRepositoryCommitsSpy = vi
      .spyOn(repoProcessor, "listRepositoryCommits")
      .mockResolvedValue([
        {
          commit: commitHash,
          date: "2026-03-20T12:00:00Z",
          author: "Test User",
          title: "Add feature",
          branch: "main",
          parents: [fileHash],
          pullRequest: {
            number: 123,
            title: "Add feature",
            url: "https://github.com/facebook/react/pull/123",
          },
          tags: ["v1.0.0"],
        },
      ]);

    const res = await makeRequest(app, "POST", "/api/jobs/commits", {
      repo: "https://github.com/facebook/react.git",
      limit: 5,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual<ListCommitsResponse>({
      repo: "facebook/react",
      commits: [
        {
          commit: commitHash,
          date: "2026-03-20T12:00:00Z",
          author: "Test User",
          title: "Add feature",
          branch: "main",
          parents: [fileHash],
          pullRequest: {
            number: 123,
            title: "Add feature",
            url: "https://github.com/facebook/react/pull/123",
          },
          tags: ["v1.0.0"],
        },
      ],
    });
    expect(listRepositoryCommitsSpy).toHaveBeenCalledWith(
      "https://github.com/facebook/react.git",
      5
    );
  });

  it("POST /api/jobs/commits - should reject an invalid limit", async () => {
    const res = await makeRequest(app, "POST", "/api/jobs/commits", {
      repo: "facebook/react",
      limit: 0,
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Field 'limit' must be a positive integer.",
    });
  });

  it("POST /api/jobs/commits/graph - should list visualization items for a repository", async () => {
    const mergeCommitHash = "3333333333333333333333333333333333333333";
    const graphCommits: ListCommitsResponse["commits"] = [
      {
        commit: commitHash,
        date: "2026-03-20T12:00:00Z",
        author: "Test User",
        title: "Add feature",
        branch: "main",
        parents: [fileHash],
        pullRequest: null,
        tags: [],
      },
      {
        commit: fileHash,
        date: "2026-03-19T12:00:00Z",
        author: "Test User",
        title: "Base commit",
        branch: null,
        parents: [],
        pullRequest: null,
        tags: [],
      },
      {
        commit: mergeCommitHash,
        date: "2026-03-18T12:00:00Z",
        author: "Test User",
        title: "Merge feature",
        branch: "release",
        parents: [commitHash, otherFileHash],
        pullRequest: null,
        tags: [],
      },
    ];

    const listRepositoryCommitsSpy = vi
      .spyOn(repoProcessor, "listRepositoryCommits")
      .mockResolvedValue(graphCommits);

    const res = await makeRequest(app, "POST", "/api/jobs/commits/graph", {
      repo: "https://github.com/facebook/react.git",
      limit: 5,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual<ListCommitsGraphResponse>([
      {
        id: commitHash,
        type: "node",
        colorKey: "main",
      },
      {
        id: fileHash,
        type: "node",
      },
      {
        id: mergeCommitHash,
        type: "node",
        colorKey: "release",
      },
      {
        id: `${fileHash}->${commitHash}`,
        type: "edge",
        source: fileHash,
        target: commitHash,
      },
      {
        id: `${commitHash}->${mergeCommitHash}`,
        type: "edge",
        source: commitHash,
        target: mergeCommitHash,
      },
    ]);
    expect(listRepositoryCommitsSpy).toHaveBeenCalledWith(
      "https://github.com/facebook/react.git",
      5
    );
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
            pushedAt: "2011-01-26T19:06:43Z",
            createdAt: "2011-01-26T19:01:12Z",
            updatedAt: "2011-01-26T19:14:43Z",
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
          pushedAt: "2011-01-26T19:06:43Z",
          createdAt: "2011-01-26T19:01:12Z",
          updatedAt: "2011-01-26T19:14:43Z",
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

  it("GET /api/jobs/cache - should list git cache folders and their sizes from disk", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-cache-stats-"));
    tempDirs.push(tmpDir);
    process.env.TMP_DIR = tmpDir;

    const cacheRoot = path.join(tmpDir, "repo-cache");
    const firstCacheDir = path.join(cacheRoot, "aaa-cache");
    const secondCacheDir = path.join(cacheRoot, "bbb-cache");

    fs.mkdirSync(path.join(firstCacheDir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(secondCacheDir, "objects"), { recursive: true });
    fs.writeFileSync(path.join(firstCacheDir, ".git", "HEAD"), "ref: main\n");
    fs.writeFileSync(path.join(secondCacheDir, "objects", "pack"), "1234567");
    fs.writeFileSync(path.join(cacheRoot, "ignore.txt"), "ignored");

    const res = await makeRequest(app, "GET", "/api/jobs/cache");

    expect(res.status).toBe(200);
    expect(res.body).toEqual<GitCacheStatsResponse>({
      count: 2,
      totalSize: 17,
      folders: [
        {
          name: "aaa-cache",
          size: 10,
        },
        {
          name: "bbb-cache",
          size: 7,
        },
      ],
    });
  });

  it("GET /api/jobs/cache - should return empty stats when the cache folder is missing", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-cache-empty-"));
    tempDirs.push(tmpDir);
    process.env.TMP_DIR = tmpDir;

    const res = await makeRequest(app, "GET", "/api/jobs/cache");

    expect(res.status).toBe(200);
    expect(res.body).toEqual<GitCacheStatsResponse>({
      count: 0,
      totalSize: 0,
      folders: [],
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

  it("POST /api/jobs - should restart a failed job for the same commit", async () => {
    await jobRepo.createJob(commitHash, "facebook/react", commitHash);
    await jobRepo.updateJobStatus(commitHash, "failed", "Something went wrong");
    await jobRepo.updateJobProgress(commitHash, 2, 4);
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

    const remove = vi.fn().mockResolvedValue(undefined);
    const queueWithGetJob = mockQueue as unknown as {
      add: ReturnType<typeof vi.fn>;
      getJob: ReturnType<typeof vi.fn>;
    };
    queueWithGetJob.getJob.mockResolvedValue({ remove });

    const res = await makeRequest(app, "POST", "/api/jobs", {
      repo: "facebook/react",
      commit: commitHash,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual<JobSummary>({
      id: commitHash,
      status: "waiting",
      commit: commitHash,
      commitShort: commitHash.slice(0, 7),
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(queueWithGetJob.add).toHaveBeenCalledWith(
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

    const restartedJob = await jobRepo.getJob(commitHash);
    expect(restartedJob).toBeDefined();
    expect(restartedJob!.status).toBe("waiting");
    expect(restartedJob!.error).toBeUndefined();
    expect(restartedJob!.processedFiles).toBe(0);
    expect(restartedJob!.totalFiles).toBe(0);
    expect(restartedJob!.progress).toBe(0);
    expect(await jobRepo.getFiles(commitHash)).toEqual([]);
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

  it("GET /api/jobs/files/hash/:hash/download - should stream the file contents by hash only", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-download-by-hash-"));
    tempDirs.push(tmpDir);
    process.env.TMP_DIR = tmpDir;

    const otherCommitHash = "89abcdef012345670123456789abcdef01234567";
    const treeDir = path.join(tmpDir, `fde-${otherCommitHash}`, "tree");
    fs.mkdirSync(treeDir, { recursive: true });
    fs.writeFileSync(path.join(treeDir, "README.md"), "download by hash only");

    await jobRepo.createJob(otherCommitHash, "owner/repo", otherCommitHash);
    await jobRepo.insertFiles(otherCommitHash, [
      {
        file_type: "t",
        file_name: "README.md",
        file_disk_path: "README.md",
        file_size: 21,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: fileHash,
      },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/api/jobs/files/hash/${fileHash.slice(0, 7)}/download`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/octet-stream");
    expect(response.headers["content-disposition"]).toContain('filename="README.md"');
    expect((response as unknown as { rawPayload: Buffer }).rawPayload.toString("utf8")).toBe(
      "download by hash only"
    );
  });

  it("GET /api/jobs/files/hash/:hash/download - should report when the hash is missing from the database", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/jobs/files/hash/${fileHash}/download`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: `File with hash '${fileHash}' was not found in the database.`,
    });
  });

  it("GET /api/jobs/files/hash/:hash/download - should return 400 for ambiguous short file hash", async () => {
    const hash1 = "cc11111111111111111111111111111111111111";
    const hash2 = "cc22222222222222222222222222222222222222";
    const jobId = "dddd111111111111111111111111111111111111";

    await jobRepo.createJob(jobId, "owner/repo", jobId);
    await jobRepo.insertFiles(jobId, [
      {
        file_type: "t",
        file_name: "a.txt",
        file_disk_path: "a.txt",
        file_size: 5,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc",
        file_git_hash: hash1,
      },
      {
        file_type: "t",
        file_name: "b.txt",
        file_disk_path: "b.txt",
        file_size: 5,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "def",
        file_git_hash: hash2,
      },
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/api/jobs/files/hash/cc/download",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error:
        "Multiple files match the short hash 'cc'. Please use a longer hash to uniquely identify the file.",
    });
  });

  it("GET /api/jobs/files/hash/:leftHash/diff/:rightHash - should return difft JSON output across jobs", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-difft-"));
    tempDirs.push(tmpDir);
    process.env.TMP_DIR = tmpDir;
    const otherCommitHash = "89abcdef012345670123456789abcdef01234567";
    const leftTreeDir = path.join(tmpDir, `fde-${commitHash}`, "tree");
    const rightTreeDir = path.join(tmpDir, `fde-${otherCommitHash}`, "tree");
    fs.mkdirSync(leftTreeDir, { recursive: true });
    fs.mkdirSync(rightTreeDir, { recursive: true });

    const leftPath = path.join(leftTreeDir, "README.md");
    const rightPath = path.join(rightTreeDir, "README.next.md");
    fs.writeFileSync(leftPath, "hello from disk");
    fs.writeFileSync(rightPath, "hello from difft");

    await jobRepo.createJob(commitHash, "owner/repo", commitHash);
    await jobRepo.createJob(otherCommitHash, "owner/repo", otherCommitHash);
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
    await jobRepo.insertFiles(otherCommitHash, [
      {
        file_type: "t",
        file_name: "README.next.md",
        file_disk_path: "README.next.md",
        file_size: 16,
        file_update_date: "2024-01-02T00:00:00Z",
        file_last_commit: "def456",
        file_git_hash: otherFileHash,
      },
    ]);

    const diffPayload = { status: "different", changes: [{ line: 1 }] };
    const execFileSpy = vi
      .spyOn(difftCommandRunner, "execFile")
      .mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (
          error: (Error & { code?: number; stdout?: string }) | null,
          stdout: string,
          stderr: string
        ) => void;
        callback(
          Object.assign(new Error("files differ"), {
            code: 1,
            stdout: JSON.stringify(diffPayload),
          }),
          JSON.stringify(diffPayload),
          ""
        );
        return {} as ReturnType<typeof difftCommandRunner.execFile>;
      });

    const response = await app.inject({
      method: "GET",
      url: `/api/jobs/files/hash/${fileHash}/diff/${otherFileHash}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(diffPayload);
    expect(execFileSpy).toHaveBeenCalledWith(
      "difft",
      ["--display", "json", leftPath, rightPath],
      { maxBuffer: 10 * 1024 * 1024 },
      expect.any(Function)
    );
  });

  it("GET /api/jobs/files/hash/:leftHash/diff/:rightHash - should report when a hash is missing from the database", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-difft-missing-"));
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
      url: `/api/jobs/files/hash/${fileHash}/diff/${otherFileHash}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: `File with hash '${otherFileHash}' was not found in the database.`,
    });
  });

  it("GET /api/jobs/files/hash/:leftHash/diff/:rightHash - should report difft execution failures", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-difft-error-"));
    tempDirs.push(tmpDir);
    process.env.TMP_DIR = tmpDir;
    const treeDir = path.join(tmpDir, `fde-${commitHash}`, "tree");
    fs.mkdirSync(treeDir, { recursive: true });
    fs.writeFileSync(path.join(treeDir, "README.md"), "hello from disk");
    fs.writeFileSync(path.join(treeDir, "README.next.md"), "hello from difft");

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
      {
        file_type: "t",
        file_name: "README.next.md",
        file_disk_path: "README.next.md",
        file_size: 16,
        file_update_date: "2024-01-02T00:00:00Z",
        file_last_commit: "def456",
        file_git_hash: otherFileHash,
      },
    ]);

    vi.spyOn(difftCommandRunner, "execFile").mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (
        error: (Error & { code?: string }) | null,
        stdout: string,
        stderr: string
      ) => void;
      callback(
        Object.assign(new Error("spawn difft ENOENT"), {
          code: "ENOENT",
        }),
        "",
        ""
      );
      return {} as ReturnType<typeof difftCommandRunner.execFile>;
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/jobs/files/hash/${fileHash}/diff/${otherFileHash}`,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: "Failed to run difft command. spawn difft ENOENT",
    });
  });

  it("GET /api/jobs/files/hash/:hash/tokenize - should return shiki JSON tokens for a file hash", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-shiki-success-"));
    tempDirs.push(tmpDir);
    process.env.TMP_DIR = tmpDir;
    const treeDir = path.join(tmpDir, `fde-${commitHash}`, "tree");
    fs.mkdirSync(treeDir, { recursive: true });

    const filePath = path.join(treeDir, "README.md");
    const fileContents = "# Hello from Shiki\n";
    fs.writeFileSync(filePath, fileContents);

    await jobRepo.createJob(commitHash, "owner/repo", commitHash);
    await jobRepo.insertFiles(commitHash, [
      {
        file_type: "t",
        file_name: "README.md",
        file_disk_path: "README.md",
        file_size: fileContents.length,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: fileHash,
      },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/api/jobs/files/hash/${fileHash}/tokenize`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      themeName: "github-dark",
      fg: expect.any(String),
      bg: expect.any(String),
      tokens: expect.any(Array),
    });
  });

  it("GET /api/jobs/files/hash/:hash/tokenize - should allow overriding the shiki theme", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-shiki-theme-"));
    tempDirs.push(tmpDir);
    process.env.TMP_DIR = tmpDir;
    const treeDir = path.join(tmpDir, `fde-${commitHash}`, "tree");
    fs.mkdirSync(treeDir, { recursive: true });

    const filePath = path.join(treeDir, "README.md");
    fs.writeFileSync(filePath, "# Hello from Shiki\n");

    await jobRepo.createJob(commitHash, "owner/repo", commitHash);
    await jobRepo.insertFiles(commitHash, [
      {
        file_type: "t",
        file_name: "README.md",
        file_disk_path: "README.md",
        file_size: 19,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: fileHash,
      },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/api/jobs/files/hash/${fileHash}/tokenize?theme=github-light`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      themeName: "github-light",
      fg: expect.any(String),
      bg: expect.any(String),
      tokens: expect.any(Array),
    });
  });

  it("GET /api/jobs/files/hash/:hash/tokenize - should allow overriding the shiki language and support auto detection", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-shiki-language-"));
    tempDirs.push(tmpDir);
    process.env.TMP_DIR = tmpDir;
    const treeDir = path.join(tmpDir, `fde-${commitHash}`, "tree");
    fs.mkdirSync(treeDir, { recursive: true });

    const filePath = path.join(treeDir, "README.md");
    fs.writeFileSync(filePath, "# Hello from Shiki\n");

    await jobRepo.createJob(commitHash, "owner/repo", commitHash);
    await jobRepo.insertFiles(commitHash, [
      {
        file_type: "t",
        file_name: "README.md",
        file_disk_path: "README.md",
        file_size: 19,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: fileHash,
      },
    ]);

    const autoResponse = await app.inject({
      method: "GET",
      url: `/api/jobs/files/hash/${fileHash}/tokenize?language=auto`,
    });
    const overrideResponse = await app.inject({
      method: "GET",
      url: `/api/jobs/files/hash/${fileHash}/tokenize?language=javascript`,
    });
    const autoTokens = autoResponse.json() as {
      themeName: string;
      tokens: Array<Array<{ content: string; color: string; fontStyle: number }>>;
    };
    const overrideTokens = overrideResponse.json() as {
      themeName: string;
      tokens: Array<Array<{ content: string; color: string; fontStyle: number }>>;
    };

    expect(autoResponse.statusCode).toBe(200);
    expect(overrideResponse.statusCode).toBe(200);
    expect(autoTokens).toMatchObject({
      themeName: "github-dark",
    });
    expect(autoTokens.tokens[0]?.[0]).toMatchObject({
      content: "# Hello from Shiki",
      color: "#79B8FF",
      fontStyle: 2,
    });
    expect(overrideTokens).toMatchObject({
      themeName: "github-dark",
    });
    expect(overrideTokens.tokens[0]?.[0]).toMatchObject({
      content: "# Hello from Shiki",
      color: "#E1E4E8",
      fontStyle: 0,
    });
  });

  it("GET /api/jobs/files/hash/:hash/tokenize - should reject unsupported shiki query options", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-shiki-invalid-"));
    tempDirs.push(tmpDir);
    process.env.TMP_DIR = tmpDir;
    const treeDir = path.join(tmpDir, `fde-${commitHash}`, "tree");
    fs.mkdirSync(treeDir, { recursive: true });

    const filePath = path.join(treeDir, "README.md");
    fs.writeFileSync(filePath, "# Hello from Shiki\n");

    await jobRepo.createJob(commitHash, "owner/repo", commitHash);
    await jobRepo.insertFiles(commitHash, [
      {
        file_type: "t",
        file_name: "README.md",
        file_disk_path: "README.md",
        file_size: 19,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: fileHash,
      },
    ]);

    const themeResponse = await app.inject({
      method: "GET",
      url: `/api/jobs/files/hash/${fileHash}/tokenize?theme=not-a-theme`,
    });
    const languageResponse = await app.inject({
      method: "GET",
      url: `/api/jobs/files/hash/${fileHash}/tokenize?language=not-a-language`,
    });

    expect(themeResponse.statusCode).toBe(400);
    expect(themeResponse.json()).toEqual({
      error: "Unsupported shiki theme 'not-a-theme'.",
    });
    expect(languageResponse.statusCode).toBe(400);
    expect(languageResponse.json()).toEqual({
      error: "Unsupported shiki language 'not-a-language'.",
    });
  });

  it("GET /api/jobs/files/hash/:hash/tokenize - should report when a hash is missing from the database", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/jobs/files/hash/${fileHash}/tokenize`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: `File with hash '${fileHash}' was not found in the database.`,
    });
  });

  it("GET /api/jobs/files/hash/:hash/tokenize - should report shiki tokenization failures", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-shiki-error-"));
    tempDirs.push(tmpDir);
    process.env.TMP_DIR = tmpDir;
    const treeDir = path.join(tmpDir, `fde-${commitHash}`, "tree");
    fs.mkdirSync(treeDir, { recursive: true });

    const filePath = path.join(treeDir, "README.md");
    fs.writeFileSync(filePath, "# Hello from Shiki\n");

    await jobRepo.createJob(commitHash, "owner/repo", commitHash);
    await jobRepo.insertFiles(commitHash, [
      {
        file_type: "t",
        file_name: "README.md",
        file_disk_path: "README.md",
        file_size: 19,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: fileHash,
      },
    ]);

    vi.spyOn(shikiTokenizer, "codeToTokens").mockRejectedValue(
      new Error("shiki tokenization failed")
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/jobs/files/hash/${fileHash}/tokenize`,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: "shiki tokenization failed",
    });
  });

  describe("short hash support", () => {
    it("GET /api/jobs/:id - should find a job by short id prefix", async () => {
      await jobRepo.createJob(commitHash, "owner/repo", commitHash);
      const shortId = commitHash.slice(0, 8);
      const res = await makeRequest(app, "GET", `/api/jobs/${shortId}`);
      expect(res.status).toBe(200);
      const resBody = res.body as JobInfo;
      expect(resBody.id).toBe(commitHash);
    });

    it("GET /api/jobs/:id - should return 400 for ambiguous short id", async () => {
      const hash1 = "ab11111111111111111111111111111111111111";
      const hash2 = "ab22222222222222222222222222222222222222";
      await jobRepo.createJob(hash1, "owner/repo", hash1);
      await jobRepo.createJob(hash2, "owner/repo", hash2);
      const res = await makeRequest(app, "GET", "/api/jobs/ab");
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toContain("Multiple");
    });

    it("GET /api/jobs/:id/files - should find files by short job id prefix", async () => {
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
      const shortId = commitHash.slice(0, 10);
      const res = await makeRequest(app, "GET", `/api/jobs/${shortId}/files`);
      expect(res.status).toBe(200);
      const resBody = res.body as JobFilesResponse;
      expect(resBody.jobId).toBe(commitHash);
      expect(resBody.files).toHaveLength(1);
    });

    it("GET /api/jobs/:id/files/hash/:hash/download - should stream file using short job id and short file hash", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-short-hash-"));
      tempDirs.push(tmpDir);
      process.env.TMP_DIR = tmpDir;
      const treeDir = path.join(tmpDir, `fde-${commitHash}`, "tree");
      fs.mkdirSync(treeDir, { recursive: true });
      fs.writeFileSync(path.join(treeDir, "README.md"), "short hash content");

      await jobRepo.createJob(commitHash, "owner/repo", commitHash);
      await jobRepo.insertFiles(commitHash, [
        {
          file_type: "t",
          file_name: "README.md",
          file_disk_path: "README.md",
          file_size: 18,
          file_update_date: "2024-01-01T00:00:00Z",
          file_last_commit: "abc123",
          file_git_hash: fileHash,
        },
      ]);

      const shortJobId = commitHash.slice(0, 7);
      const shortFileHash = fileHash.slice(0, 7);
      const response = await app.inject({
        method: "GET",
        url: `/api/jobs/${shortJobId}/files/hash/${shortFileHash}/download`,
      });

      expect(response.statusCode).toBe(200);
      expect((response as unknown as { rawPayload: Buffer }).rawPayload.toString("utf8")).toBe(
        "short hash content"
      );
    });

    it("GET /api/jobs/files/hash/:leftHash/diff/:rightHash - should accept short file hashes for diff", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-short-diff-"));
      tempDirs.push(tmpDir);
      process.env.TMP_DIR = tmpDir;

      const leftJobId = "aaaa111111111111111111111111111111111111";
      const rightJobId = "bbbb111111111111111111111111111111111111";

      const leftTree = path.join(tmpDir, `fde-${leftJobId}`, "tree");
      const rightTree = path.join(tmpDir, `fde-${rightJobId}`, "tree");
      fs.mkdirSync(leftTree, { recursive: true });
      fs.mkdirSync(rightTree, { recursive: true });
      fs.writeFileSync(path.join(leftTree, "left.txt"), "left content");
      fs.writeFileSync(path.join(rightTree, "right.txt"), "right content");

      await jobRepo.createJob(leftJobId, "owner/repo", leftJobId);
      await jobRepo.createJob(rightJobId, "owner/repo", rightJobId);
      await jobRepo.insertFiles(leftJobId, [
        {
          file_type: "t",
          file_name: "left.txt",
          file_disk_path: "left.txt",
          file_size: 12,
          file_update_date: "2024-01-01T00:00:00Z",
          file_last_commit: "abc",
          file_git_hash: fileHash,
        },
      ]);
      await jobRepo.insertFiles(rightJobId, [
        {
          file_type: "t",
          file_name: "right.txt",
          file_disk_path: "right.txt",
          file_size: 13,
          file_update_date: "2024-01-01T00:00:00Z",
          file_last_commit: "def",
          file_git_hash: otherFileHash,
        },
      ]);

      const fakeDiffResult = { status: "different", changes: [] };
      vi.spyOn(difftCommandRunner, "execFile").mockImplementation(
        ((_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
          (cb as (err: null, stdout: string, stderr: string) => void)(
            null,
            JSON.stringify(fakeDiffResult),
            ""
          );
        }) as typeof difftCommandRunner.execFile
      );

      const shortLeft = fileHash.slice(0, 5);
      const shortRight = otherFileHash.slice(0, 5);
      const response = await app.inject({
        method: "GET",
        url: `/api/jobs/files/hash/${shortLeft}/diff/${shortRight}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(fakeDiffResult);
    });

    it("GET /api/jobs/files/hash/:leftHash/diff/:rightHash - should return 400 for ambiguous short file hash in diff", async () => {
      const hash1 = "cc11111111111111111111111111111111111111";
      const hash2 = "cc22222222222222222222222222222222222222";
      const jobId = "dddd111111111111111111111111111111111111";

      await jobRepo.createJob(jobId, "owner/repo", jobId);
      await jobRepo.insertFiles(jobId, [
        {
          file_type: "t",
          file_name: "a.txt",
          file_disk_path: "a.txt",
          file_size: 5,
          file_update_date: "2024-01-01T00:00:00Z",
          file_last_commit: "abc",
          file_git_hash: hash1,
        },
        {
          file_type: "t",
          file_name: "b.txt",
          file_disk_path: "b.txt",
          file_size: 5,
          file_update_date: "2024-01-01T00:00:00Z",
          file_last_commit: "def",
          file_git_hash: hash2,
        },
      ]);

      const response = await app.inject({
        method: "GET",
        url: `/api/jobs/files/hash/cc/diff/${otherFileHash}`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain("Multiple");
    });

    it("GET /api/jobs/files/hash/:hash/tokenize - should accept a short file hash for tokenization", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-short-token-"));
      tempDirs.push(tmpDir);
      process.env.TMP_DIR = tmpDir;

      const jobId = "eeee111111111111111111111111111111111111";
      const treeDir = path.join(tmpDir, `fde-${jobId}`, "tree");
      fs.mkdirSync(treeDir, { recursive: true });
      fs.writeFileSync(path.join(treeDir, "hello.ts"), 'const x = 1;');

      await jobRepo.createJob(jobId, "owner/repo", jobId);
      await jobRepo.insertFiles(jobId, [
        {
          file_type: "t",
          file_name: "hello.ts",
          file_disk_path: "hello.ts",
          file_size: 12,
          file_update_date: "2024-01-01T00:00:00Z",
          file_last_commit: "abc",
          file_git_hash: fileHash,
        },
      ]);

      const fakeTokenResult = { tokens: [], bg: "#000" };
      vi.spyOn(shikiTokenizer, "codeToTokens").mockResolvedValue(
        fakeTokenResult as never
      );

      const shortHash = fileHash.slice(0, 6);
      const response = await app.inject({
        method: "GET",
        url: `/api/jobs/files/hash/${shortHash}/tokenize`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(fakeTokenResult);
    });
  });
});
