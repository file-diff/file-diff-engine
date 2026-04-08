import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileRecord } from "../types";

const processRepositoryMock = vi.fn();
const workerConstructorMock = vi.fn();
const fetchCopilotAuthorizationHeaderMock = vi.fn();
const createTaskMock = vi.fn();
const getTaskMock = vi.fn();

const repoMethods = {
  updateJobStatus: vi.fn(),
  insertFiles: vi.fn(),
  updateJobProgress: vi.fn(),
  updateFile: vi.fn(),
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
    processRepositoryMock.mockReset();
    repoMethods.updateJobStatus.mockReset();
    repoMethods.insertFiles.mockReset();
    repoMethods.updateJobProgress.mockReset();
    repoMethods.updateFile.mockReset();
    repoMethods.updateAgentTaskJobStatus.mockReset();
    repoMethods.attachAgentTaskToJob.mockReset();
    repoMethods.updateAgentTaskStatus.mockReset();
    fetchCopilotAuthorizationHeaderMock.mockReset();
    createTaskMock.mockReset();
    getTaskMock.mockReset();
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

    repoMethods.updateAgentTaskJobStatus.mockImplementation(async (_jobId, status) => {
      order.push(`status:${status}`);
    });
    repoMethods.attachAgentTaskToJob.mockImplementation(async (_jobId, taskId, taskStatus) => {
      order.push(`task:${taskId}:${taskStatus}`);
    });
    repoMethods.updateAgentTaskStatus.mockImplementation(async (_jobId, taskStatus) => {
      order.push(`task-status:${taskStatus}`);
    });
    fetchCopilotAuthorizationHeaderMock.mockResolvedValue("GitHub-Bearer copilot-token");
    createTaskMock.mockResolvedValue({
      id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
    getTaskMock
      .mockResolvedValueOnce({ state: "queued" })
      .mockResolvedValueOnce({ state: "in_progress" })
      .mockResolvedValueOnce({ state: "completed" });

    const { createWorker } = await import("../workers/repoWorker");
    const worker = (await createWorker({} as never)) as unknown as {
      handler: (job: unknown) => Promise<void>;
    };

    await worker.handler({
      id: "queue-job-2",
      name: "create-agent-task",
      data: {
        jobId: "task-job-1",
        owner: "owner",
        repoName: "repo",
        body: {
          event_content: "Fix the failing workflow",
          problem_statement: "Investigate and fix the job",
          base_ref: "main",
        },
      },
    });

    expect(order).toEqual([
      "status:active",
      "task:a1b2c3d4-e5f6-7890-abcd-ef1234567890:queued",
      "task-status:queued",
      "task-status:in_progress",
      "task-status:completed",
      "status:completed",
    ]);
    expect(fetchCopilotAuthorizationHeaderMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock).toHaveBeenCalledWith(
      "owner",
      "repo",
      {
        event_content: "Fix the failing workflow",
        problem_statement: "Investigate and fix the job",
        base_ref: "main",
      },
      "GitHub-Bearer copilot-token"
    );
    expect(getTaskMock).toHaveBeenCalledTimes(3);
  });

  it("should fail an agent task job when monitoring times out", async () => {
    process.env.AGENT_TASK_POLL_INTERVAL_MS = "0";
    process.env.AGENT_TASK_MAX_POLL_DURATION_MS = "1";
    const statusUpdates: Array<{ status: string; error?: string }> = [];

    repoMethods.updateAgentTaskJobStatus.mockImplementation(async (_jobId, status, error) => {
      statusUpdates.push({ status, error });
    });
    fetchCopilotAuthorizationHeaderMock.mockResolvedValue("GitHub-Bearer copilot-token");
    createTaskMock.mockResolvedValue({
      id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
    getTaskMock.mockResolvedValue({ state: "in_progress" });

    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(2);

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
        body: {
          event_content: "Fix the failing workflow",
          problem_statement: "Investigate and fix the job",
          base_ref: "main",
        },
      },
    });

    expect(repoMethods.updateAgentTaskStatus).toHaveBeenCalledWith(
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

    nowSpy.mockRestore();
  });
});
