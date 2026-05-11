import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../__tests__/helpers/testDatabase";
import { JobRepository } from "../../db/repository";
import * as repoProcessor from "../../services/repoProcessor";
import type { ManagedQueue } from "../../services/queue";
import { registerIndexTaskRoutes } from "./indexTaskRoutes";

const COMMIT = "a".repeat(40);
const RESOLVED_COMMIT = "b".repeat(40);
const OLDER_COMMIT = "c".repeat(40);
const NEWER_COMMIT = "d".repeat(40);
const REPO = "file-diff/file-diff-engine";
const VIEWER_TOKEN = "viewer-token";

describe("registerIndexTaskRoutes", () => {
  const originalViewerBearerToken = process.env.VIEWER_BEARER_TOKEN;
  const originalAdminBearerToken = process.env.ADMIN_BEARER_TOKEN;

  beforeEach(() => {
    process.env.VIEWER_BEARER_TOKEN = VIEWER_TOKEN;
    process.env.ADMIN_BEARER_TOKEN = VIEWER_TOKEN;
  });

  afterEach(() => {
    process.env.VIEWER_BEARER_TOKEN = originalViewerBearerToken;
    process.env.ADMIN_BEARER_TOKEN = originalAdminBearerToken;
    vi.restoreAllMocks();
  });

  it("creates a file index task from a specific commit", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(undefined),
    } as unknown as ManagedQueue;

    try {
      registerIndexTaskRoutes(app, queue, jobRepo);

      const response = await app.inject({
        method: "POST",
        url: "/index-task",
        headers: { authorization: `Bearer ${VIEWER_TOKEN}` },
        payload: { repo: REPO, commit: COMMIT },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        id: COMMIT,
        status: "waiting",
        commit: COMMIT,
      });

      await expect(jobRepo.getJob(COMMIT)).resolves.toMatchObject({
        id: COMMIT,
        repo: REPO,
        commit: COMMIT,
        status: "waiting",
      });
      expect(queue.add).toHaveBeenCalledWith(
        "process-repo",
        { jobId: COMMIT, repoName: REPO, commit: COMMIT },
        { jobId: COMMIT }
      );
    } finally {
      await app.close();
      await database.end();
    }
  });

  it("resolves a git ref before creating a file index task", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(undefined),
    } as unknown as ManagedQueue;
    vi.spyOn(repoProcessor, "resolveRefToCommitHash").mockResolvedValue(
      RESOLVED_COMMIT
    );

    try {
      registerIndexTaskRoutes(app, queue, jobRepo);

      const response = await app.inject({
        method: "POST",
        url: "/index-task",
        headers: { authorization: `Bearer ${VIEWER_TOKEN}` },
        payload: { repo: REPO, ref: "main" },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        id: RESOLVED_COMMIT,
        status: "waiting",
        commit: RESOLVED_COMMIT,
      });
      expect(repoProcessor.resolveRefToCommitHash).toHaveBeenCalledWith(
        repoProcessor.getRepositoryUrl(REPO),
        "main"
      );
      expect(queue.add).toHaveBeenCalledWith(
        "process-repo",
        { jobId: RESOLVED_COMMIT, repoName: REPO, commit: RESOLVED_COMMIT },
        { jobId: RESOLVED_COMMIT }
      );
    } finally {
      await app.close();
      await database.end();
    }
  });

  it("lists file index tasks from newest to oldest", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(undefined),
    } as unknown as ManagedQueue;

    try {
      await jobRepo.createJob(OLDER_COMMIT, REPO, OLDER_COMMIT);
      await jobRepo.createJob(NEWER_COMMIT, REPO, NEWER_COMMIT);
      await jobRepo.updateJobProgress(NEWER_COMMIT, 1, 4);
      await jobRepo.updateJobStatus(NEWER_COMMIT, "completed");
      await database.query(
        "UPDATE jobs SET created_at = $1, updated_at = $1 WHERE id = $2",
        ["2026-01-01T00:00:00.000Z", OLDER_COMMIT]
      );
      await database.query(
        "UPDATE jobs SET created_at = $1, updated_at = $1 WHERE id = $2",
        ["2026-01-02T00:00:00.000Z", NEWER_COMMIT]
      );
      registerIndexTaskRoutes(app, queue, jobRepo);

      const response = await app.inject({
        method: "GET",
        url: "/index-task",
        headers: { authorization: `Bearer ${VIEWER_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        expect.objectContaining({
          id: NEWER_COMMIT,
          repo: REPO,
          commit: NEWER_COMMIT,
          commitShort: NEWER_COMMIT.slice(0, 7),
          status: "completed",
          progress: 25,
          totalFiles: 4,
          processedFiles: 1,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        }),
        expect.objectContaining({
          id: OLDER_COMMIT,
          repo: REPO,
          commit: OLDER_COMMIT,
          commitShort: OLDER_COMMIT.slice(0, 7),
          status: "waiting",
          progress: 0,
          totalFiles: 0,
          processedFiles: 0,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        }),
      ]);
    } finally {
      await app.close();
      await database.end();
    }
  });

  it("requires viewer authorization to list file index tasks", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(undefined),
    } as unknown as ManagedQueue;

    try {
      registerIndexTaskRoutes(app, queue, jobRepo);

      const response = await app.inject({
        method: "GET",
        url: "/index-task",
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "Bearer token is required." });
    } finally {
      await app.close();
      await database.end();
    }
  });

  it("returns indexed file metadata under the canonical files scope", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(undefined),
    } as unknown as ManagedQueue;

    try {
      await jobRepo.createJob(COMMIT, REPO, COMMIT);
      await jobRepo.insertFiles(COMMIT, [
        {
          file_type: "t",
          file_name: "README.md",
          file_disk_path: "README.md",
          file_size: 10,
          file_update_date: "2026-01-01T00:00:00Z",
          file_last_commit: COMMIT,
          file_git_hash: "c".repeat(40),
        },
      ]);
      registerIndexTaskRoutes(app, queue, jobRepo);

      const response = await app.inject({
        method: "GET",
        url: `/index-task/${COMMIT}/files`,
        headers: { authorization: `Bearer ${VIEWER_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        jobId: COMMIT,
        commit: COMMIT,
        files: [
          {
            t: "t",
            path: "README.md",
            s: 10,
            commit: COMMIT,
            hash: "c".repeat(40),
          },
        ],
      });
    } finally {
      await app.close();
      await database.end();
    }
  });
});
