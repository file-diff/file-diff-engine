import type { Job } from "bullmq";
import { Worker } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../__tests__/helpers/testDatabase";
import { JobRepository } from "../db/repository";
import { DEFAULT_BASELOAD_WORKERS_CONFIG } from "../services/baseloadWorkerConfig";
import type { ManagedQueue } from "../services/queue";
import { createWorker, recoverOrphanedWaitingJobs } from "./repoWorker";

vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    queueName,
    processor,
    options
  ) {
    this.queueName = queueName;
    this.processor = processor;
    this.options = options;
    this.on = vi.fn();
    this.close = vi.fn().mockResolvedValue(undefined);
  }),
}));

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const REPO = "file-diff/file-diff-engine";

describe("recoverOrphanedWaitingJobs", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("re-enqueues 'waiting' jobs that have no BullMQ counterpart", async () => {
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);

    await jobRepo.createJob(COMMIT_A, REPO, COMMIT_A);

    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(undefined),
    } as unknown as ManagedQueue;

    try {
      const recovered = await recoverOrphanedWaitingJobs(database, queue);
      expect(recovered).toBe(1);
      expect(queue.getJob).toHaveBeenCalledWith(COMMIT_A, "process-repo");
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
    } as unknown as ManagedQueue;

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
    } as unknown as ManagedQueue;

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
    } as unknown as ManagedQueue;

    try {
      const recovered = await recoverOrphanedWaitingJobs(database, queue);
      expect(recovered).toBe(1);
      expect(add).toHaveBeenCalledTimes(2);
    } finally {
      await database.end();
    }
  });
});

describe("createWorker", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("uses baseload worker config concurrency per queue kind", async () => {
    const database = await createTestDatabase();
    const config = {
      ...DEFAULT_BASELOAD_WORKERS_CONFIG,
      workers: {
        repo: { concurrency: 1 },
        opencode: { concurrency: 2 },
        codex: { concurrency: 3 },
        claude: { concurrency: 4 },
      },
    };

    try {
      const manager = await createWorker(database, {
        baseloadWorkersConfig: config,
      });

      expect(Worker).toHaveBeenCalledTimes(4);
      expect((Worker as unknown as ReturnType<typeof vi.fn>).mock.calls).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            "repo-processing",
            expect.any(Function),
            expect.objectContaining({ concurrency: 1 }),
          ]),
          expect.arrayContaining([
            "repo-processing-opencode",
            expect.any(Function),
            expect.objectContaining({ concurrency: 2 }),
          ]),
          expect.arrayContaining([
            "repo-processing-codex",
            expect.any(Function),
            expect.objectContaining({ concurrency: 3 }),
          ]),
          expect.arrayContaining([
            "repo-processing-claude",
            expect.any(Function),
            expect.objectContaining({ concurrency: 4 }),
          ]),
        ])
      );

      await manager.close();
    } finally {
      await database.end();
    }
  });
});
