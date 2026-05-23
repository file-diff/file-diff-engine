import { describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import { createTestDatabase } from "../__tests__/helpers/testDatabase";
import { getDatabase } from "./database";
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
      previousSession: "previous-job",
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
      codexSessionId: "019ddb3e-de18-7122-8c4c-8d6b9b3c4fbf",
      codexSessionFilePath:
        "/home/ubuntu/.codex/sessions/2026/04/29/rollout.jsonl",
      codexSessionExport: {
        sessionId: "019ddb3e-de18-7122-8c4c-8d6b9b3c4fbf",
        sessionFilePath:
          "/home/ubuntu/.codex/sessions/2026/04/29/rollout.jsonl",
        testDetails: ["{\"message\":\"npm test passed\"}"],
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
      previousSession: "previous-job",
      opencodeSessionId: "ses_123",
      opencodeSessionExport: {
        title: "Agent session",
        messages: [{ role: "assistant", content: "done" }],
      },
      codexSessionId: "019ddb3e-de18-7122-8c4c-8d6b9b3c4fbf",
      codexSessionFilePath:
        "/home/ubuntu/.codex/sessions/2026/04/29/rollout.jsonl",
      codexSessionExport: {
        sessionId: "019ddb3e-de18-7122-8c4c-8d6b9b3c4fbf",
        sessionFilePath:
          "/home/ubuntu/.codex/sessions/2026/04/29/rollout.jsonl",
        testDetails: ["{\"message\":\"npm test passed\"}"],
      },
    });

    await expect(
      repository.getAgentTaskJobByIdOrCodexSessionId(
        "019ddb3e-de18-7122-8c4c-8d6b9b3c4fbf"
      )
    ).resolves.toMatchObject({
      id: "job-1",
      codexSessionId: "019ddb3e-de18-7122-8c4c-8d6b9b3c4fbf",
    });

    await expect(
      repository.getAgentTaskJobByIdOrCodexSessionId("ses_123")
    ).resolves.toMatchObject({
      id: "job-1",
      opencodeSessionId: "ses_123",
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

  it("lists completed visible agent task jobs until they are soft-deleted", async () => {
    const database = await createTestDatabase();
    const repository = new JobRepository(database);

    await repository.createAgentTaskJob({
      id: "job-visible",
      repo: "file-diff/file-diff-engine",
      taskRunner: "codex",
      model: "gpt-5.2-codex",
      baseRef: "main",
    });
    await repository.createAgentTaskJob({
      id: "job-hidden",
      repo: "file-diff/file-diff-engine",
      taskRunner: "opencode",
      model: "deepseek-v4-flash",
      baseRef: "main",
    });
    await repository.updateAgentTaskJobStatus("job-visible", "completed");
    await repository.updateAgentTaskJobStatus("job-hidden", "completed");
    await repository.markAgentTaskJobDeleted("job-hidden");

    await expect(repository.listActiveAgentTaskJobs()).resolves.toEqual([]);
    await expect(
      repository.listVisibleAgentTaskJobs("file-diff/file-diff-engine")
    ).resolves.toMatchObject([
      {
        id: "job-visible",
        status: "completed",
        deletedAt: null,
      },
    ]);

    await database.end();
  });

  it("resets legacy agent task rows once and recreates a clean table", async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();

    await pool.query(`
      CREATE TABLE agent_task_jobs (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'waiting',
        github_task_id TEXT,
        task_status TEXT,
        branch_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      INSERT INTO agent_task_jobs (
        id,
        repo,
        status,
        github_task_id,
        task_status,
        branch_name
      )
      VALUES (
        'legacy-job',
        'file-diff/file-diff-engine',
        'completed',
        'github-task-1',
        'done',
        'legacy-branch'
      )
    `);

    const database = await getDatabase({ pool });
    const repository = new JobRepository(database);

    await expect(repository.listVisibleAgentTaskJobs()).resolves.toEqual([]);
    const columns = await database.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = 'agent_task_jobs'
       ORDER BY column_name`
    );
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining(["github_task_id", "task_status"])
    );

    await repository.createAgentTaskJob({
      id: "new-job",
      repo: "file-diff/file-diff-engine",
      taskRunner: "codex",
      model: "gpt-5.2-codex",
      baseRef: "main",
    });

    await expect(repository.listVisibleAgentTaskJobs()).resolves.toMatchObject([
      { id: "new-job" },
    ]);

    const migrations = await database.query(
      "SELECT * FROM schema_migrations WHERE id = '2026-05-21-reset-agent-task-jobs'"
    );
    expect(migrations.rowCount).toBe(1);

    await database.end();
  });
});
