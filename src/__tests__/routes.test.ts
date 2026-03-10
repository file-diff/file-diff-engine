import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { DatabaseClient } from "../db/database";
import { JobRepository } from "../db/repository";
import { createJobRoutes } from "../routes/jobs";
import { Queue } from "bullmq";
import type {
  ListRefsResponse,
  JobFilesResponse,
  JobInfo,
  JobSummary,
  ResolveCommitResponse,
} from "../types";
import { createTestDatabase } from "./helpers/testDatabase";
import * as repoProcessor from "../services/repoProcessor";
import { getJobId, getJobPermalink } from "../utils/jobIdentity";

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
  const commitHash = "0123456789abcdef0123456789abcdef01234567";

  beforeEach(async () => {
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

  it("POST /api/jobs - should create a job", async () => {
    const res = await makeRequest(app, "POST", "/api/jobs", {
      repo: "facebook/react",
      ref: "main",
      commit: commitHash.toUpperCase(),
    });
    expect(res.status).toBe(201);
    const resBody = res.body as JobSummary;
    expect(resBody.id).toBe(getJobId("facebook/react", commitHash));
    expect(resBody.status).toBe("waiting");
    expect(resBody.repo).toBe("facebook/react");
    expect(resBody.ref).toBe("main");
    expect(resBody.commit).toBe(commitHash);
    expect(resBody.commitShort).toBe(commitHash.slice(0, 7));
    expect(resBody.permalink).toBe(
      getJobPermalink("facebook/react", commitHash, "main")
    );
    expect(mockQueue.add).toHaveBeenCalledWith(
      "process-repo",
      {
        jobId: getJobId("facebook/react", commitHash),
        repoName: "facebook/react",
        ref: "main",
        commit: commitHash,
      },
      {
        jobId: getJobId("facebook/react", commitHash),
      }
    );
  });

  it("POST /api/jobs - should reuse an existing job for the same repository and commit", async () => {
    const firstResponse = await makeRequest(app, "POST", "/api/jobs", {
      repo: "facebook/react",
      commit: commitHash,
    });
    expect(firstResponse.status).toBe(201);

    const secondResponse = await makeRequest(app, "POST", "/api/jobs", {
      repo: "facebook/react",
      commit: commitHash,
    });
    expect(secondResponse.status).toBe(200);
    expect(secondResponse.body).toEqual({
      id: getJobId("facebook/react", commitHash),
      status: "waiting",
      repo: "facebook/react",
      permalink: getJobPermalink("facebook/react", commitHash),
      commit: commitHash,
      commitShort: commitHash.slice(0, 7),
    });
    expect(mockQueue.add).toHaveBeenCalledTimes(1);
  });

  it("POST /api/jobs - should create a separate job for the same commit in another repository", async () => {
    const firstResponse = await makeRequest(app, "POST", "/api/jobs", {
      repo: "facebook/react",
      commit: commitHash,
    });
    expect(firstResponse.status).toBe(201);

    const secondResponse = await makeRequest(app, "POST", "/api/jobs", {
      repo: "file-diff/file-diff-engine",
      commit: commitHash,
    });
    expect(secondResponse.status).toBe(201);
    expect(secondResponse.body).toEqual({
      id: getJobId("file-diff/file-diff-engine", commitHash),
      status: "waiting",
      repo: "file-diff/file-diff-engine",
      permalink: getJobPermalink("file-diff/file-diff-engine", commitHash),
      commit: commitHash,
      commitShort: commitHash.slice(0, 7),
    });
    expect(mockQueue.add).toHaveBeenCalledTimes(2);
  });

  it("POST /api/jobs - should backfill ref metadata for an existing repository commit", async () => {
    const firstResponse = await makeRequest(app, "POST", "/api/jobs", {
      repo: "facebook/react",
      commit: commitHash,
    });
    expect(firstResponse.status).toBe(201);

    const secondResponse = await makeRequest(app, "POST", "/api/jobs", {
      repo: "facebook/react",
      ref: "main",
      commit: commitHash,
    });
    expect(secondResponse.status).toBe(200);
    expect(secondResponse.body).toEqual({
      id: getJobId("facebook/react", commitHash),
      status: "waiting",
      repo: "facebook/react",
      ref: "main",
      permalink: getJobPermalink("facebook/react", commitHash, "main"),
      commit: commitHash,
      commitShort: commitHash.slice(0, 7),
    });

    const storedJob = await jobRepo.getJob(getJobId("facebook/react", commitHash));
    expect(storedJob?.ref).toBe("main");
    expect(storedJob?.permalink).toBe(
      getJobPermalink("facebook/react", commitHash, "main")
    );
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
    const jobId = getJobId("owner/repo", commitHash);
    await jobRepo.createJob(
      jobId,
      "owner/repo",
      commitHash,
      "main",
      getJobPermalink("owner/repo", commitHash, "main")
    );
    const res = await makeRequest(app, "GET", `/api/jobs/${jobId}`);
    expect(res.status).toBe(200);
    const resBody = res.body as JobInfo;
    expect(resBody.id).toBe(jobId);
    expect(resBody.repo).toBe("owner/repo");
    expect(resBody.ref).toBe("main");
    expect(resBody.status).toBe("waiting");
    expect(resBody.commit).toBe(commitHash);
    expect(resBody.commitShort).toBe(commitHash.slice(0, 7));
    expect(resBody.permalink).toBe(getJobPermalink("owner/repo", commitHash, "main"));
  });

  it("GET /api/jobs/:id - should return 404 for unknown job", async () => {
    const res = await makeRequest(app, "GET", "/api/jobs/unknown-id");
    expect(res.status).toBe(404);
  });

  it("GET /api/jobs/:id/files - should return files for a job", async () => {
    const jobId = getJobId("owner/repo", commitHash);
    await jobRepo.createJob(
      jobId,
      "owner/repo",
      commitHash,
      "main",
      getJobPermalink("owner/repo", commitHash, "main")
    );
    await jobRepo.insertFiles(jobId, [
      {
        file_type: "t",
        file_name: "README.md",
        file_size: 50,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: "deadbeef",
      },
    ]);
    const res = await makeRequest(app, "GET", `/api/jobs/${jobId}/files`);
    expect(res.status).toBe(200);
    const resBody = res.body as JobFilesResponse;
    expect(resBody.jobId).toBe(jobId);
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
});
