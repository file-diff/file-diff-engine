import type { Job, Queue } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../__tests__/helpers/testDatabase";
import { JobRepository } from "../db/repository";
import { recoverOrphanedWaitingJobs } from "./repoWorker";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const REPO = "file-diff/file-diff-engine";

describe("recoverOrphanedWaitingJobs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-enqueues 'waiting' jobs that have no BullMQ counterpart", async () => {
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);

    await jobRepo.createJob(COMMIT_A, REPO, COMMIT_A);

    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(undefined),
    } as unknown as Queue;

    try {
      const recovered = await recoverOrphanedWaitingJobs(database, queue);
      expect(recovered).toBe(1);
      expect(queue.getJob).toHaveBeenCalledWith(COMMIT_A);
      expect(queue.add).toHaveBeenCalledTimes(1);
      const [name, payload, options] = (queue.add as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      expect(name).toBe("process-repo");
      expect(payload).toEqual({ jobId: COMMIT_A, repoName: REPO, commit: COMMIT_A });
      expect((options as { jobId: string }).jobId).toMatch(
        new RegExp(`^${COMMIT_A}:recover-\\d+$`)
      );
    } finally {
      await database.end();
    }
  });

  it("skips jobs that already have a BullMQ counterpart", async () => {
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);

    await jobRepo.createJob(COMMIT_A, REPO, COMMIT_A);

    const existing = { id: COMMIT_A } as unknown as Job;
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(existing),
    } as unknown as Queue;

    try {
      const recovered = await recoverOrphanedWaitingJobs(database, queue);
      expect(recovered).toBe(0);
      expect(queue.add).not.toHaveBeenCalled();
    } finally {
      await database.end();
    }
  });

  it("skips non-waiting jobs even if Redis lost their entries", async () => {
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);

    await jobRepo.createJob(COMMIT_A, REPO, COMMIT_A);
    await jobRepo.updateJobStatus(COMMIT_A, "active");
    await jobRepo.createJob(COMMIT_B, REPO, COMMIT_B);
    await jobRepo.updateJobStatus(COMMIT_B, "completed");

    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(undefined),
    } as unknown as Queue;

    try {
      const recovered = await recoverOrphanedWaitingJobs(database, queue);
      expect(recovered).toBe(0);
      expect(queue.add).not.toHaveBeenCalled();
    } finally {
      await database.end();
    }
  });

  it("continues recovery when one re-enqueue fails", async () => {
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);

    await jobRepo.createJob(COMMIT_A, REPO, COMMIT_A);
    await jobRepo.createJob(COMMIT_B, REPO, COMMIT_B);

    const add = vi
      .fn()
      .mockRejectedValueOnce(new Error("Redis connection lost"))
      .mockResolvedValueOnce(undefined);
    const queue = {
      add,
      getJob: vi.fn().mockResolvedValue(undefined),
    } as unknown as Queue;

    try {
      const recovered = await recoverOrphanedWaitingJobs(database, queue);
      expect(recovered).toBe(1);
      expect(add).toHaveBeenCalledTimes(2);
    } finally {
      await database.end();
    }
  });
});
