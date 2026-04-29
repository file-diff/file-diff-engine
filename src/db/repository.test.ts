import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../__tests__/helpers/testDatabase";
import { JobRepository } from "./repository";

describe("JobRepository", () => {
  it("persists opencode session metadata on agent task jobs", async () => {
    const database = await createTestDatabase();
    const repository = new JobRepository(database);

    await repository.createAgentTaskJob(
      "job-1",
      "file-diff/file-diff-engine",
      undefined,
      undefined,
      undefined,
      0,
      null,
      "deepseek-v4-flash",
      "main"
    );

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
      opencodeSessionId: "ses_123",
      opencodeSessionExport: {
        title: "Agent session",
        messages: [{ role: "assistant", content: "done" }],
      },
    });
  });
});
