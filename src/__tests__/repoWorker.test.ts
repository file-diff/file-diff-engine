import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileRecord } from "../types";

const processRepositoryMock = vi.fn();
const workerConstructorMock = vi.fn();
const fetchCopilotAuthorizationHeaderMock = vi.fn();
const createTaskMock = vi.fn();
const getTaskMock = vi.fn();
const findOpenPullRequestByHeadBranchMock = vi.fn();
const markPullRequestReadyMock = vi.fn();
const mergePullRequestMock = vi.fn();
const deleteRemoteBranchMock = vi.fn();
const archiveTaskMock = vi.fn();
const sendAgentTaskFinishedSlackNotificationMock = vi.fn();

const repoMethods = {
  updateJobStatus: vi.fn(),
  insertFiles: vi.fn(),
  updateJobProgress: vi.fn(),
  updateFile: vi.fn(),
  getAgentTaskJob: vi.fn(),
  updateAgentTaskJobStatus: vi.fn(),
  attachAgentTaskToJob: vi.fn(),
  updateAgentTaskStatus: vi.fn(),
};

vi.mock("../services/repoProcessor", () => ({
  processRepository: processRepositoryMock,
}));

vi.mock("../db/repository", () => ({
  JobRepository: vi.fn(function MockJobRepository() {
    return repoMethods;
  }),
}));

vi.mock("../services/githubApi", () => ({
  fetchCopilotAuthorizationHeader: fetchCopilotAuthorizationHeaderMock,
  createTask: createTaskMock,
  getTask: getTaskMock,
  findOpenPullRequestByHeadBranch: findOpenPullRequestByHeadBranchMock,
  markPullRequestReady: markPullRequestReadyMock,
  mergePullRequest: mergePullRequestMock,
  deleteRemoteBranch: deleteRemoteBranchMock,
  archiveTask: archiveTaskMock,
  GitHubApiError: class GitHubApiError extends Error {
    constructor(
      message: string,
      public readonly statusCode: number
    ) {
      super(message);
    }
  },
}));

vi.mock("../services/slack", () => ({
  sendAgentTaskFinishedSlackNotification: sendAgentTaskFinishedSlackNotificationMock,
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
    delete process.env.AGENT_TASK_POLL_INTERVAL_MS;
    delete process.env.AGENT_TASK_MAX_POLL_DURATION_MS;
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
    fetchCopilotAuthorizationHeaderMock.mockReset();
    createTaskMock.mockReset();
    getTaskMock.mockReset();
    findOpenPullRequestByHeadBranchMock.mockReset();
    markPullRequestReadyMock.mockReset();
    mergePullRequestMock.mockReset();
    deleteRemoteBranchMock.mockReset();
    archiveTaskMock.mockReset();
    sendAgentTaskFinishedSlackNotificationMock.mockReset();
    repoMethods.getAgentTaskJob.mockResolvedValue(undefined);
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

  it("should create and monitor an agent task job until completion", async () => {
    process.env.AGENT_TASK_POLL_INTERVAL_MS = "0";
    const order: string[] = [];
    vi.useFakeTimers();
    vi.setSystemTime(2_000);

    repoMethods.updateAgentTaskJobStatus.mockImplementation(async (_jobId, status) => {
      order.push(`status:${status}`);
    });
    repoMethods.attachAgentTaskToJob.mockImplementation(async (_jobId, createdTaskId, taskStatus) => {
      order.push(`attach:${createdTaskId}:${taskStatus ?? "null"}`);
    });
    repoMethods.updateAgentTaskStatus.mockImplementation(async (_jobId, taskStatus, branchName) => {
      order.push(`task-status:${taskStatus}:${branchName ?? "null"}`);
    });
    fetchCopilotAuthorizationHeaderMock.mockResolvedValue("GitHub-Bearer copilot-token");
    sendAgentTaskFinishedSlackNotificationMock.mockResolvedValue(undefined);
    const createdTaskId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    createTaskMock.mockResolvedValue({
      id: createdTaskId,
    });
    getTaskMock
      .mockImplementationOnce(async () => ({ state: "queued" }))
      .mockImplementationOnce(async () => {
        vi.setSystemTime(4_000);
        return {
          state: "in_progress",
          sessions: [{ head_ref: "refs/heads/copilot/fix-1" }],
        };
      })
      .mockImplementationOnce(async () => {
        vi.setSystemTime(7_000);
        return {
          state: "completed",
          sessions: [{ head_ref: "copilot/fix-1" }],
        };
      });

    const { createWorker } = await import("../workers/repoWorker");
    const worker = (await createWorker({} as never)) as unknown as {
      handler: (job: unknown) => Promise<void>;
    };

    await worker.handler({
      id: "queue-job-2",
      name: "create-agent-task",
      timestamp: 1_000,
        data: {
          jobId: "task-job-1",
          owner: "owner",
          repoName: "repo",
          createTaskBody: {
            problem_statement: "Investigate and fix the login button issue",
            base_ref: "main",
          },
        },
      });

    expect(order).toEqual([
      "status:active",
      `attach:${createdTaskId}:queued`,
      "task-status:queued:null",
      "task-status:in_progress:copilot/fix-1",
      "task-status:completed:copilot/fix-1",
      "status:completed",
    ]);
    expect(fetchCopilotAuthorizationHeaderMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock).toHaveBeenCalledWith(
      "owner",
      "repo",
      {
        problem_statement: "Investigate and fix the login button issue",
        base_ref: "main",
      },
      "GitHub-Bearer copilot-token"
    );
    expect(getTaskMock).toHaveBeenCalledTimes(3);
    expect(getTaskMock).toHaveBeenNthCalledWith(
      1,
      "owner",
      "repo",
      createdTaskId,
      "GitHub-Bearer copilot-token"
    );
    expect(sendAgentTaskFinishedSlackNotificationMock).toHaveBeenCalledWith({
      owner: "owner",
      repoName: "repo",
      taskId: createdTaskId,
      status: "completed",
      branch: "copilot/fix-1",
      durationMs: 6_000,
      pullRequestActions: [],
    });
    expect(findOpenPullRequestByHeadBranchMock).not.toHaveBeenCalled();
    expect(markPullRequestReadyMock).not.toHaveBeenCalled();
    expect(mergePullRequestMock).not.toHaveBeenCalled();
    expect(deleteRemoteBranchMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("should mark the created pull request ready when AutoReady is requested", async () => {
    process.env.AGENT_TASK_POLL_INTERVAL_MS = "0";
    vi.useFakeTimers();

    repoMethods.updateAgentTaskJobStatus.mockResolvedValue(undefined);
    repoMethods.updateAgentTaskStatus.mockResolvedValue(undefined);
    fetchCopilotAuthorizationHeaderMock.mockResolvedValue("GitHub-Bearer copilot-token");
    createTaskMock.mockResolvedValue({
      id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
    getTaskMock.mockResolvedValue({
      state: "completed",
      sessions: [{ head_ref: "copilot/fix-1" }],
    });
    findOpenPullRequestByHeadBranchMock.mockResolvedValue({
      number: 123,
      title: "Fix login button",
      url: "https://github.com/owner/repo/pull/123",
      state: "open",
      draft: true,
      baseBranch: "main",
    });
    markPullRequestReadyMock.mockResolvedValue(undefined);
    sendAgentTaskFinishedSlackNotificationMock.mockResolvedValue(undefined);

    const { createWorker } = await import("../workers/repoWorker");
    const worker = (await createWorker({} as never)) as unknown as {
      handler: (job: unknown) => Promise<void>;
    };

    await worker.handler({
      id: "queue-job-4",
      name: "create-agent-task",
        data: {
          jobId: "task-job-3",
          owner: "owner",
          repoName: "repo",
          createTaskBody: {
            problem_statement: "Investigate",
            base_ref: "main",
          },
          pullRequestCompletionMode: "AutoReady",
        },
      });

    expect(findOpenPullRequestByHeadBranchMock).toHaveBeenCalledWith(
      "owner/repo",
      "copilot/fix-1"
    );
    expect(markPullRequestReadyMock).toHaveBeenCalledWith(
      "owner/repo",
      123,
      "test-token"
    );
    expect(mergePullRequestMock).not.toHaveBeenCalled();
    expect(deleteRemoteBranchMock).not.toHaveBeenCalled();
    expect(sendAgentTaskFinishedSlackNotificationMock).toHaveBeenCalledWith({
      owner: "owner",
      repoName: "repo",
      taskId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      status: "completed",
      branch: "copilot/fix-1",
      durationMs: expect.any(Number),
      pullRequestActions: ["Marked pull request #123 ready for review"],
    });
    vi.useRealTimers();
  });

  it("should delete the branch after a successful AutoMerge", async () => {
    process.env.AGENT_TASK_POLL_INTERVAL_MS = "0";
    vi.useFakeTimers();

    repoMethods.updateAgentTaskJobStatus.mockResolvedValue(undefined);
    repoMethods.updateAgentTaskStatus.mockResolvedValue(undefined);
    fetchCopilotAuthorizationHeaderMock.mockResolvedValue("GitHub-Bearer copilot-token");
    createTaskMock.mockResolvedValue({
      id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
    getTaskMock.mockResolvedValue({
      state: "completed",
      sessions: [{ head_ref: "copilot/fix-1" }],
    });
    findOpenPullRequestByHeadBranchMock.mockResolvedValue({
      number: 123,
      title: "Fix login button",
      url: "https://github.com/owner/repo/pull/123",
      state: "open",
      draft: false,
      baseBranch: "main",
    });
    mergePullRequestMock.mockResolvedValue({
      merged: true,
      message: "Pull Request successfully merged",
      sha: "deadbeef",
    });
    deleteRemoteBranchMock.mockResolvedValue(undefined);
    archiveTaskMock.mockResolvedValue({});
    sendAgentTaskFinishedSlackNotificationMock.mockResolvedValue(undefined);

    const { createWorker } = await import("../workers/repoWorker");
    const worker = (await createWorker({} as never)) as unknown as {
      handler: (job: unknown) => Promise<void>;
    };

    await worker.handler({
      id: "queue-job-5",
      name: "create-agent-task",
        data: {
          jobId: "task-job-4",
          owner: "owner",
          repoName: "repo",
          createTaskBody: {
            problem_statement: "Investigate",
            base_ref: "main",
          },
          pullRequestCompletionMode: "AutoMerge",
        },
      });

    expect(markPullRequestReadyMock).not.toHaveBeenCalled();
    expect(mergePullRequestMock).toHaveBeenCalledWith("owner/repo", 123, {
      token: "test-token",
    });
    expect(deleteRemoteBranchMock).toHaveBeenCalledWith(
      "owner/repo",
      "copilot/fix-1",
      "test-token"
    );
    expect(archiveTaskMock).toHaveBeenCalledWith(
      "owner",
      "repo",
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "GitHub-Bearer copilot-token"
    );
    expect(sendAgentTaskFinishedSlackNotificationMock).toHaveBeenCalledWith({
      owner: "owner",
      repoName: "repo",
      taskId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      status: "completed",
      branch: "copilot/fix-1",
      durationMs: expect.any(Number),
      pullRequestActions: ["Merged pull request #123, target branch: main"],
    });
    expect(repoMethods.updateAgentTaskJobStatus).toHaveBeenLastCalledWith(
      "task-job-4",
      "completed"
    );
    vi.useRealTimers();
  });

  it("should ignore unmergeable AutoMerge results", async () => {
    process.env.AGENT_TASK_POLL_INTERVAL_MS = "0";
    vi.useFakeTimers();

    repoMethods.updateAgentTaskJobStatus.mockResolvedValue(undefined);
    repoMethods.updateAgentTaskStatus.mockResolvedValue(undefined);
    fetchCopilotAuthorizationHeaderMock.mockResolvedValue("GitHub-Bearer copilot-token");
    createTaskMock.mockResolvedValue({
      id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
    getTaskMock.mockResolvedValue({
      state: "completed",
      sessions: [{ head_ref: "copilot/fix-1" }],
    });
    findOpenPullRequestByHeadBranchMock.mockResolvedValue({
      number: 123,
      title: "Fix login button",
      url: "https://github.com/owner/repo/pull/123",
      state: "open",
      draft: false,
      baseBranch: "main",
    });
    sendAgentTaskFinishedSlackNotificationMock.mockResolvedValue(undefined);

    const { GitHubApiError } = await import("../services/githubApi");
    mergePullRequestMock.mockRejectedValue(new GitHubApiError("Merge conflict", 409));

    const { createWorker } = await import("../workers/repoWorker");
    const worker = (await createWorker({} as never)) as unknown as {
      handler: (job: unknown) => Promise<void>;
    };

    await worker.handler({
      id: "queue-job-6",
      name: "create-agent-task",
        data: {
          jobId: "task-job-5",
          owner: "owner",
          repoName: "repo",
          createTaskBody: {
            problem_statement: "Investigate",
            base_ref: "main",
          },
          pullRequestCompletionMode: "AutoMerge",
        },
      });

    expect(markPullRequestReadyMock).not.toHaveBeenCalled();
    expect(mergePullRequestMock).toHaveBeenCalledWith("owner/repo", 123, {
      token: "test-token",
    });
    expect(deleteRemoteBranchMock).not.toHaveBeenCalled();
    expect(archiveTaskMock).not.toHaveBeenCalled();
    expect(sendAgentTaskFinishedSlackNotificationMock).toHaveBeenCalledWith({
      owner: "owner",
      repoName: "repo",
      taskId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      status: "completed",
      branch: "copilot/fix-1",
      durationMs: expect.any(Number),
      pullRequestActions: [],
    });
    expect(repoMethods.updateAgentTaskJobStatus).toHaveBeenLastCalledWith(
      "task-job-5",
      "completed"
    );
    vi.useRealTimers();
  });

  it("should fail an agent task job when monitoring times out", async () => {
    process.env.AGENT_TASK_POLL_INTERVAL_MS = "0";
    process.env.AGENT_TASK_MAX_POLL_DURATION_MS = "1";
    const statusUpdates: Array<{ status: string; error?: string }> = [];
    vi.useFakeTimers();
    vi.setSystemTime(0);

    repoMethods.updateAgentTaskJobStatus.mockImplementation(async (_jobId, status, error) => {
      statusUpdates.push({ status, error });
    });
    fetchCopilotAuthorizationHeaderMock.mockResolvedValue("GitHub-Bearer copilot-token");
    createTaskMock.mockResolvedValue({
      id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
    getTaskMock.mockImplementation(async () => {
      vi.setSystemTime(2);
      return { state: "in_progress" };
    });

    const { createWorker } = await import("../workers/repoWorker");
    const worker = (await createWorker({} as never)) as unknown as {
      handler: (job: unknown) => Promise<void>;
    };

    await worker.handler({
      id: "queue-job-3",
      name: "create-agent-task",
        data: {
          jobId: "task-job-2",
          owner: "owner",
          repoName: "repo",
          createTaskBody: {
            problem_statement: "Investigate",
            base_ref: "main",
          },
        },
      });

    expect(repoMethods.updateAgentTaskStatus).toHaveBeenLastCalledWith(
      "task-job-2",
      "timeout"
    );
    expect(statusUpdates).toEqual([
      { status: "active", error: undefined },
      {
        status: "failed",
        error: "Agent task monitoring timed out before reaching a terminal state.",
      },
    ]);

    expect(sendAgentTaskFinishedSlackNotificationMock).toHaveBeenCalledWith({
      owner: "owner",
      repoName: "repo",
      taskId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      status: "timeout",
      branch: null,
      durationMs: 2,
      pullRequestActions: [],
      details: "Agent task monitoring timed out before reaching a terminal state.",
    });
    vi.useRealTimers();
  });

  it("should send a Slack notification when an agent task job fails unexpectedly", async () => {
    process.env.AGENT_TASK_POLL_INTERVAL_MS = "0";
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    repoMethods.updateAgentTaskJobStatus.mockResolvedValue(undefined);
    fetchCopilotAuthorizationHeaderMock.mockRejectedValue(new Error("Copilot auth failed"));
    sendAgentTaskFinishedSlackNotificationMock.mockResolvedValue(undefined);

    const { createWorker } = await import("../workers/repoWorker");
    const worker = (await createWorker({} as never)) as unknown as {
      handler: (job: unknown) => Promise<void>;
    };

    await expect(
      worker.handler({
        id: "queue-job-7",
        name: "create-agent-task",
        timestamp: 9_000,
        data: {
          jobId: "task-job-6",
          owner: "owner",
          repoName: "repo",
          createTaskBody: {
            problem_statement: "Investigate",
            base_ref: "main",
          },
        },
      })
    ).rejects.toThrow("Copilot auth failed");

    expect(sendAgentTaskFinishedSlackNotificationMock).toHaveBeenCalledWith({
      owner: "owner",
      repoName: "repo",
      taskId: "task-job-6",
      status: "failed",
      branch: null,
      durationMs: 1_000,
      pullRequestActions: [],
      details: "Copilot auth failed",
    });
    vi.useRealTimers();
  });

  it("should skip canceled delayed agent task jobs", async () => {
    repoMethods.getAgentTaskJob.mockResolvedValue({
      id: "task-job-canceled",
      repo: "owner/repo",
      status: "canceled",
      branch: null,
      taskDelayMs: 1_000,
      scheduledAt: "2024-01-01T00:00:01.000Z",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });

    const { createWorker } = await import("../workers/repoWorker");
    const worker = (await createWorker({} as never)) as unknown as {
      handler: (job: unknown) => Promise<void>;
    };

    await worker.handler({
      id: "queue-job-canceled",
      name: "create-agent-task",
      data: {
        jobId: "task-job-canceled",
        owner: "owner",
        repoName: "repo",
        createTaskBody: {
          problem_statement: "Investigate",
          base_ref: "main",
        },
      },
    });

    expect(createTaskMock).not.toHaveBeenCalled();
    expect(fetchCopilotAuthorizationHeaderMock).not.toHaveBeenCalled();
    expect(repoMethods.updateAgentTaskJobStatus).not.toHaveBeenCalled();
  });
});
