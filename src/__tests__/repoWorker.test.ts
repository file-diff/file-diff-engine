import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileRecord } from "../types";

const processRepositoryMock = vi.fn();
const workerConstructorMock = vi.fn();

const repoMethods = {
  updateJobStatus: vi.fn(),
  updateJobPermalink: vi.fn(),
  insertFiles: vi.fn(),
  updateJobProgress: vi.fn(),
  updateFile: vi.fn(),
};

vi.mock("../services/repoProcessor", () => ({
  processRepository: processRepositoryMock,
}));

vi.mock("../db/repository", () => ({
  JobRepository: vi.fn(function MockJobRepository() {
    return repoMethods;
  }),
}));

vi.mock("bullmq", () => ({
  Worker: workerConstructorMock.mockImplementation(function MockWorker(
    _queueName: string,
    handler: (job: unknown) => Promise<void>
  ) {
    return {
      handler,
    };
  }),
}));

describe("repoWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processRepositoryMock.mockReset();
    repoMethods.updateJobStatus.mockReset();
    repoMethods.updateJobPermalink.mockReset();
    repoMethods.insertFiles.mockReset();
    repoMethods.updateJobProgress.mockReset();
    repoMethods.updateFile.mockReset();
  });

  it("should insert discovered files before updating processed metadata", async () => {
    const order: string[] = [];
    const commitHash = "0123456789abcdef0123456789abcdef01234567";

    repoMethods.updateJobStatus.mockImplementation(async (_jobId, status) => {
      order.push(`status:${status}`);
    });
    repoMethods.updateJobPermalink.mockImplementation(async () => {
      order.push("permalink");
    });
    repoMethods.insertFiles.mockImplementation(async () => {
      order.push("insertFiles");
    });
    repoMethods.updateJobProgress.mockImplementation(async (_jobId, processed, total) => {
      order.push(`progress:${processed}/${total}`);
    });
    repoMethods.updateFile.mockImplementation(async () => {
      order.push("updateFile");
    });

    const initialFiles: FileRecord[] = [
      {
        file_type: "t",
        file_name: "README.md",
        file_size: 0,
        file_update_date: "",
        file_last_commit: "",
        file_git_hash: "",
      },
    ];
    const processedFile: FileRecord = {
      file_type: "x",
      file_name: "README.md",
      file_size: 12,
      file_update_date: "2024-01-01T00:00:00Z",
      file_last_commit: "abc123",
      file_git_hash: "deadbeef",
    };

    processRepositoryMock.mockImplementation(async (_repo, _commit, _workDir, hooks) => {
      await hooks.onFilesDiscovered(initialFiles);
      await hooks.onFileProcessed(processedFile, 1, 1);
      return [processedFile];
    });

    const { createWorker } = await import("../workers/repoWorker");
    const worker = (await createWorker({} as never)) as unknown as {
      handler: (job: unknown) => Promise<void>;
    };

    await worker.handler({
      id: "queue-job-1",
      data: {
        jobId: commitHash,
        repoName: "owner/repo",
        ref: "main",
        commit: commitHash,
      },
    });

    expect(order).toEqual([
      "status:active",
      "permalink",
      "insertFiles",
      "progress:0/1",
      "updateFile",
      "progress:1/1",
      "status:completed",
    ]);
    expect(processRepositoryMock).toHaveBeenCalledWith(
      "owner/repo",
      commitHash,
      `tmp/fde-${commitHash}`,
      expect.any(Object)
    );
    expect(repoMethods.insertFiles).toHaveBeenCalledWith(commitHash, initialFiles);
    expect(repoMethods.updateFile).toHaveBeenCalledWith(commitHash, processedFile);
    expect(repoMethods.updateJobPermalink).toHaveBeenCalledWith(
      commitHash,
      "main",
      "/?repo=owner%2Frepo&ref=main&commit=0123456789abcdef0123456789abcdef01234567"
    );
  });
});
