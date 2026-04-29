import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../__tests__/helpers/testDatabase";
import { JobRepository } from "./repository";

describe("JobRepository", () => {
  it("persists task runner settings and opencode session metadata on agent task jobs", async () => {
    const database = await createTestDatabase();
    const repository = new JobRepository(database);

    await repository.createAgentTaskJob({
      id: "job-1",
      repo: "file-diff/file-diff-engine",
      taskRunner: "codex",
      model: "gpt-5.2-codex",
      reasoningEffort: "high",
      reasoningSummary: "auto",
      verbosity: "medium",
      codexWebSearch: true,
      baseRef: "main",
    });

    await repository.updateAgentTaskLogs("job-1", {
      output: "combined output",
      stdout: "stdout",
      stderr: "stderr",
      opencodeSessionId: "ses_123",
      opencodeSessionExport: {
        title: "Agent session",
        messages: [{ role: "assistant", content: "done" }],
      },
    });

    await expect(repository.getAgentTaskJob("job-1")).resolves.toMatchObject({
      id: "job-1",
      taskRunner: "codex",
      model: "gpt-5.2-codex",
      reasoningEffort: "high",
      reasoningSummary: "auto",
      verbosity: "medium",
      codexWebSearch: true,
      opencodeSessionId: "ses_123",
      opencodeSessionExport: {
        title: "Agent session",
        messages: [{ role: "assistant", content: "done" }],
      },
    });
  });

  it("persists task cancellation and soft deletion without removing the row", async () => {
    const database = await createTestDatabase();
    const repository = new JobRepository(database);

    await repository.createAgentTaskJob({
      id: "job-2",
      repo: "file-diff/file-diff-engine",
      taskRunner: "opencode",
      model: "deepseek-v4-flash",
      baseRef: "main",
    });

    await repository.updateAgentTaskJobStatus("job-2", "active");
    await repository.requestAgentTaskCancellation("job-2");
    await repository.markAgentTaskJobDeleted("job-2");

    await expect(repository.getAgentTaskJob("job-2")).resolves.toMatchObject({
      id: "job-2",
      status: "active",
      cancelRequestedAt: expect.any(String),
      deletedAt: expect.any(String),
    });
    await expect(
      repository.isAgentTaskCancellationRequested("job-2")
    ).resolves.toBe(true);
    await expect(repository.listActiveAgentTaskJobs()).resolves.toEqual([]);
  });
});
