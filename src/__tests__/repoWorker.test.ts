import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileRecord } from "../types";

const processRepositoryMock = vi.fn();
const workerConstructorMock = vi.fn();
const sendAgentTaskFinishedSlackNotificationMock = vi.fn();
const prepareOpencodeTaskBranchMock = vi.fn();
const executeOpencodeOnPreparedBranchMock = vi.fn();

const repoMethods = {
  updateJobStatus: vi.fn(),
  insertFiles: vi.fn(),
  updateJobProgress: vi.fn(),
  updateFile: vi.fn(),
  getAgentTaskJob: vi.fn(),
  updateAgentTaskJobStatus: vi.fn(),
  attachAgentTaskToJob: vi.fn(),
  updateAgentTaskStatus: vi.fn(),
  updateAgentTaskBootstrap: vi.fn(),
  updateAgentTaskOutput: vi.fn(),
};

vi.mock("../services/repoProcessor", () => ({
  processRepository: processRepositoryMock,
}));

vi.mock("../db/repository", () => ({
  JobRepository: vi.fn(function MockJobRepository() {
    return repoMethods;
  }),
}));

vi.mock("../services/slack", () => ({
  sendAgentTaskFinishedSlackNotification: sendAgentTaskFinishedSlackNotificationMock,
}));

vi.mock("../services/opencodeTask", () => ({
  prepareOpencodeTaskBranch: prepareOpencodeTaskBranchMock,
  executeOpencodeOnPreparedBranch: executeOpencodeOnPreparedBranchMock,
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
    process.env.PUBLIC_GITHUB_TOKEN = "test-token";
    processRepositoryMock.mockReset();
    repoMethods.updateJobStatus.mockReset();
    repoMethods.insertFiles.mockReset();
    repoMethods.updateJobProgress.mockReset();
    repoMethods.updateFile.mockReset();
    repoMethods.getAgentTaskJob.mockReset();
    repoMethods.updateAgentTaskJobStatus.mockReset();
    repoMethods.attachAgentTaskToJob.mockReset();
    repoMethods.updateAgentTaskStatus.mockReset();
    repoMethods.updateAgentTaskBootstrap.mockReset();
    repoMethods.updateAgentTaskOutput.mockReset();
    sendAgentTaskFinishedSlackNotificationMock.mockReset();
    prepareOpencodeTaskBranchMock.mockReset();
    executeOpencodeOnPreparedBranchMock.mockReset();
    repoMethods.getAgentTaskJob.mockResolvedValue(undefined);
  });

  it("should prepare a branch, run opencode, and store output for opencode task jobs", async () => {
    repoMethods.updateAgentTaskJobStatus.mockResolvedValue(undefined);
    repoMethods.updateAgentTaskStatus.mockResolvedValue(undefined);
    repoMethods.updateAgentTaskBootstrap.mockResolvedValue(undefined);
    repoMethods.updateAgentTaskOutput.mockResolvedValue(undefined);
    sendAgentTaskFinishedSlackNotificationMock.mockResolvedValue(undefined);
    prepareOpencodeTaskBranchMock.mockResolvedValue({
      branch: "fde-agent/20260428-abc12345",
      pullRequest: {
        number: 42,
        title: "Agent task",
        url: "https://github.com/owner/repo/pull/42",
      },
    });
    executeOpencodeOnPreparedBranchMock.mockResolvedValue("opencode output");

    const { createWorker } = await import("../workers/repoWorker");
    const worker = (await createWorker({} as never)) as unknown as {
      handler: (job: unknown) => Promise<void>;
    };

    await worker.handler({
      id: "queue-job-opencode",
      name: "create-opencode-task",
      data: {
        jobId: "task-job-opencode",
        repoName: "owner/repo",
        baseRef: "main",
        problemStatement: "Build the feature",
        model: "deepseek-v4-flash",
        githubKey: "github-token",
        deepseekApiKey: "deepseek-token",
      },
    });

    expect(prepareOpencodeTaskBranchMock).toHaveBeenCalledWith({
      jobId: "task-job-opencode",
      repo: "owner/repo",
      baseRef: "main",
      problemStatement: "Build the feature",
      model: "deepseek-v4-flash",
      githubKey: "github-token",
      deepseekApiKey: "deepseek-token",
    });
    expect(repoMethods.updateAgentTaskBootstrap).toHaveBeenCalledWith(
      "task-job-opencode",
      "fde-agent/20260428-abc12345",
      "https://github.com/owner/repo/pull/42",
      42
    );
    expect(repoMethods.updateAgentTaskStatus).toHaveBeenCalledWith(
      "task-job-opencode",
      "working",
      "fde-agent/20260428-abc12345"
    );
    expect(executeOpencodeOnPreparedBranchMock).toHaveBeenCalledWith(
      {
        jobId: "task-job-opencode",
        repo: "owner/repo",
        baseRef: "main",
        problemStatement: "Build the feature",
        model: "deepseek-v4-flash",
        githubKey: "github-token",
        deepseekApiKey: "deepseek-token",
      },
      "fde-agent/20260428-abc12345"
    );
    expect(repoMethods.updateAgentTaskOutput).toHaveBeenCalledWith(
      "task-job-opencode",
      "opencode output"
    );
    expect(repoMethods.updateAgentTaskJobStatus).toHaveBeenLastCalledWith(
      "task-job-opencode",
      "completed"
    );
    expect(sendAgentTaskFinishedSlackNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "owner",
        repoName: "repo",
        taskId: "task-job-opencode",
        status: "completed",
        branch: "fde-agent/20260428-abc12345",
        pullRequestActions: [],
      })
    );
  });

  it("should mark an opencode task job as failed and notify Slack on errors", async () => {
    repoMethods.updateAgentTaskJobStatus.mockResolvedValue(undefined);
    repoMethods.updateAgentTaskStatus.mockResolvedValue(undefined);
    repoMethods.updateAgentTaskOutput.mockResolvedValue(undefined);
    sendAgentTaskFinishedSlackNotificationMock.mockResolvedValue(undefined);
    prepareOpencodeTaskBranchMock.mockRejectedValue(new Error("clone failed"));

    const { createWorker } = await import("../workers/repoWorker");
    const worker = (await createWorker({} as never)) as unknown as {
      handler: (job: unknown) => Promise<void>;
    };

    await expect(
      worker.handler({
        id: "queue-job-opencode-fail",
        name: "create-opencode-task",
        data: {
          jobId: "task-job-fail",
          repoName: "owner/repo",
          baseRef: "main",
          problemStatement: "Investigate",
          model: "deepseek-v4-flash",
        },
      })
    ).rejects.toThrow("clone failed");

    expect(repoMethods.updateAgentTaskJobStatus).toHaveBeenLastCalledWith(
      "task-job-fail",
      "failed",
      "clone failed"
    );
    expect(repoMethods.updateAgentTaskOutput).toHaveBeenCalledWith(
      "task-job-fail",
      "clone failed"
    );
    expect(sendAgentTaskFinishedSlackNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "owner",
        repoName: "repo",
        taskId: "task-job-fail",
        status: "failed",
        details: "clone failed",
      })
    );
  });

  it("should skip canceled opencode task jobs", async () => {
    repoMethods.getAgentTaskJob.mockResolvedValue({
      id: "task-job-canceled",
      repo: "owner/repo",
      status: "canceled",
      branch: null,
      taskDelayMs: 0,
      scheduledAt: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });

    const { createWorker } = await import("../workers/repoWorker");
    const worker = (await createWorker({} as never)) as unknown as {
      handler: (job: unknown) => Promise<void>;
    };

    await worker.handler({
      id: "queue-job-canceled",
      name: "create-opencode-task",
      data: {
        jobId: "task-job-canceled",
        repoName: "owner/repo",
        baseRef: "main",
        problemStatement: "Investigate",
        model: "deepseek-v4-flash",
      },
    });

    expect(prepareOpencodeTaskBranchMock).not.toHaveBeenCalled();
    expect(executeOpencodeOnPreparedBranchMock).not.toHaveBeenCalled();
    expect(repoMethods.updateAgentTaskJobStatus).not.toHaveBeenCalled();
  });

  it("should insert discovered files before updating processed metadata", async () => {
    const order: string[] = [];
    const commitHash = "0123456789abcdef0123456789abcdef01234567";

    repoMethods.updateJobStatus.mockImplementation(async (_jobId, status) => {
      order.push(`status:${status}`);
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
        commit: commitHash,
      },
    });

    expect(order).toEqual([
      "status:active",
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
  });
});
