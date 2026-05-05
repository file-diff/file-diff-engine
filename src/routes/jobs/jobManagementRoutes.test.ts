import Fastify from "fastify";
import { type Job, type Queue } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../__tests__/helpers/testDatabase";
import { JobRepository } from "../../db/repository";
import { registerJobManagementRoutes } from "./jobManagementRoutes";

const COMMIT_A = "a".repeat(40);
const REPO = "file-diff/file-diff-engine";
const VIEWER_TOKEN = "viewer-token";

describe("registerJobManagementRoutes POST /", () => {
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

  it("creates a fresh job and enqueues it for an unseen commit", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(undefined),
    } as unknown as Queue;

    try {
      registerJobManagementRoutes(app, queue, jobRepo);

      const response = await app.inject({
        method: "POST",
        url: "/",
        headers: { authorization: `Bearer ${VIEWER_TOKEN}` },
        payload: { repo: REPO, commit: COMMIT_A },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        id: COMMIT_A,
        status: "waiting",
        commit: COMMIT_A,
      });

      const persisted = await jobRepo.getJob(COMMIT_A);
      expect(persisted?.status).toBe("waiting");

      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        "process-repo",
        { jobId: COMMIT_A, repoName: REPO, commit: COMMIT_A },
        { jobId: COMMIT_A }
      );
    } finally {
      await app.close();
      await database.end();
    }
  });

  it("retries a failed job: resets DB, removes old queued job, re-enqueues a fresh one", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);

    await jobRepo.createJob(COMMIT_A, REPO, COMMIT_A);
    await jobRepo.insertFiles(COMMIT_A, [
      {
        file_type: "blob",
        file_name: "README.md",
        file_disk_path: "README.md",
        file_size: 10,
        file_update_date: "2026-01-01T00:00:00Z",
        file_last_commit: COMMIT_A,
        file_git_hash: "deadbeef",
      },
    ]);
    await jobRepo.updateJobProgress(COMMIT_A, 1, 1);
    await jobRepo.updateJobStatus(COMMIT_A, "failed", "boom");

    const removedJobs: string[] = [];
    const oldQueuedJob = {
      id: COMMIT_A,
      remove: vi.fn(async () => {
        removedJobs.push(COMMIT_A);
      }),
    } as unknown as Job;
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(oldQueuedJob),
    } as unknown as Queue;

    try {
      registerJobManagementRoutes(app, queue, jobRepo);

      const response = await app.inject({
        method: "POST",
        url: "/",
        headers: { authorization: `Bearer ${VIEWER_TOKEN}` },
        payload: { repo: REPO, commit: COMMIT_A },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: COMMIT_A,
        status: "waiting",
        commit: COMMIT_A,
      });

      const persisted = await jobRepo.getJob(COMMIT_A);
      expect(persisted?.status).toBe("waiting");
      expect(persisted?.error).toBeUndefined();
      expect(persisted?.progress).toBe(0);
      expect(persisted?.processedFiles).toBe(0);
      expect(persisted?.totalFiles).toBe(0);

      const files = await jobRepo.getFiles(COMMIT_A);
      expect(files).toHaveLength(0);

      expect(queue.getJob).toHaveBeenCalledWith(COMMIT_A);
      expect(removedJobs).toEqual([COMMIT_A]);
      expect(queue.add).toHaveBeenCalledTimes(1);
      const [addName, addData, addOptions] = (queue.add as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(addName).toBe("process-repo");
      expect(addData).toEqual({ jobId: COMMIT_A, repoName: REPO, commit: COMMIT_A });
      expect(addOptions.jobId).toMatch(new RegExp(`^${COMMIT_A}:retry-\\d+$`));
    } finally {
      await app.close();
      await database.end();
    }
  });

  it("retries a failed job even when the prior BullMQ job is already gone (e.g. removeOnFail)", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);

    await jobRepo.createJob(COMMIT_A, REPO, COMMIT_A);
    await jobRepo.updateJobStatus(COMMIT_A, "failed", "boom");

    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(undefined),
    } as unknown as Queue;

    try {
      registerJobManagementRoutes(app, queue, jobRepo);

      const response = await app.inject({
        method: "POST",
        url: "/",
        headers: { authorization: `Bearer ${VIEWER_TOKEN}` },
        payload: { repo: REPO, commit: COMMIT_A },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: COMMIT_A, status: "waiting" });

      const persisted = await jobRepo.getJob(COMMIT_A);
      expect(persisted?.status).toBe("waiting");
      expect(queue.add).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      await database.end();
    }
  });

  it("retries a failed job even when removing the prior BullMQ job throws", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);

    await jobRepo.createJob(COMMIT_A, REPO, COMMIT_A);
    await jobRepo.updateJobStatus(COMMIT_A, "failed", "boom");

    const oldQueuedJob = {
      id: COMMIT_A,
      remove: vi.fn().mockRejectedValue(new Error("Lock not held")),
    } as unknown as Job;
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(oldQueuedJob),
    } as unknown as Queue;

    try {
      registerJobManagementRoutes(app, queue, jobRepo);

      const response = await app.inject({
        method: "POST",
        url: "/",
        headers: { authorization: `Bearer ${VIEWER_TOKEN}` },
        payload: { repo: REPO, commit: COMMIT_A },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: COMMIT_A, status: "waiting" });

      const persisted = await jobRepo.getJob(COMMIT_A);
      expect(persisted?.status).toBe("waiting");
      expect(queue.add).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      await database.end();
    }
  });

  it("returns existing status for a non-failed job without resetting or re-enqueuing", async () => {
    const cases: Array<"waiting" | "active" | "completed"> = [
      "waiting",
      "active",
      "completed",
    ];

    for (const status of cases) {
      const app = Fastify();
      const database = await createTestDatabase();
      const jobRepo = new JobRepository(database);
      const queue = {
        add: vi.fn().mockResolvedValue(undefined),
        getJob: vi.fn().mockResolvedValue(undefined),
      } as unknown as Queue;

      try {
        await jobRepo.createJob(COMMIT_A, REPO, COMMIT_A);
        await jobRepo.updateJobStatus(COMMIT_A, status);

        registerJobManagementRoutes(app, queue, jobRepo);

        const response = await app.inject({
          method: "POST",
          url: "/",
          headers: { authorization: `Bearer ${VIEWER_TOKEN}` },
          payload: { repo: REPO, commit: COMMIT_A },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ id: COMMIT_A, status });
        expect(queue.add).not.toHaveBeenCalled();
        expect(queue.getJob).not.toHaveBeenCalled();
      } finally {
        await app.close();
        await database.end();
      }
    }
  });
});
