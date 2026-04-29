import Fastify from "fastify";
import { type Queue } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../__tests__/helpers/testDatabase";
import { JobRepository } from "../../db/repository";
import { registerDiscoveryRoutes } from "./discoveryRoutes";

describe("registerDiscoveryRoutes", () => {
  const originalAdminBearerToken = process.env.ADMIN_BEARER_TOKEN;

  beforeEach(() => {
    process.env.ADMIN_BEARER_TOKEN = "admin-token";
  });

  afterEach(() => {
    process.env.ADMIN_BEARER_TOKEN = originalAdminBearerToken;
    vi.restoreAllMocks();
  });

  it("defaults codex reasoning settings when they are omitted", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
    } as unknown as Queue;

    try {
      registerDiscoveryRoutes(app, queue, jobRepo);

      const response = await app.inject({
        method: "POST",
        url: "/create-task",
        headers: {
          authorization: "Bearer admin-token",
        },
        payload: {
          repo: "file-diff/file-diff-engine",
          base_ref: "main",
          problem_statement: "Investigate and fix the login flow bug",
          task: "codex",
          model: "gpt-5.2-codex",
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json() as { id: string };
      expect(body.id).toEqual(expect.any(String));

      await expect(jobRepo.getAgentTaskJob(body.id)).resolves.toMatchObject({
        id: body.id,
        reasoningEffort: "medium",
        reasoningSummary: "auto",
        taskRunner: "codex",
        model: "gpt-5.2-codex",
      });

      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        "create-codex-task",
        expect.objectContaining({
          reasoningEffort: "medium",
          reasoningSummary: "auto",
          task: "codex",
          model: "gpt-5.2-codex",
        }),
        expect.objectContaining({
          jobId: body.id,
          delay: 0,
        })
      );
    } finally {
      await app.close();
      await database.end();
    }
  });

  it("maps auto_merge compatibility input to pull request completion mode for codex tasks", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
    } as unknown as Queue;

    try {
      registerDiscoveryRoutes(app, queue, jobRepo);

      const response = await app.inject({
        method: "POST",
        url: "/create-task",
        headers: {
          authorization: "Bearer admin-token",
        },
        payload: {
          repo: "file-diff/file-diff-engine",
          base_ref: "main",
          problem_statement: "Enable PR auto merge after the task succeeds",
          task: "codex",
          auto_merge: true,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json() as { id: string };

      await expect(jobRepo.getAgentTaskJob(body.id)).resolves.toMatchObject({
        id: body.id,
        taskRunner: "codex",
        pullRequestCompletionMode: "AutoMerge",
      });

      expect(queue.add).toHaveBeenCalledWith(
        "create-codex-task",
        expect.objectContaining({
          task: "codex",
          pullRequestCompletionMode: "AutoMerge",
        }),
        expect.objectContaining({
          jobId: body.id,
        })
      );
    } finally {
      await app.close();
      await database.end();
    }
  });

  it("rejects conflicting auto_ready and pull_request_completion_mode values", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
    } as unknown as Queue;

    try {
      registerDiscoveryRoutes(app, queue, jobRepo);

      const response = await app.inject({
        method: "POST",
        url: "/create-task",
        headers: {
          authorization: "Bearer admin-token",
        },
        payload: {
          repo: "file-diff/file-diff-engine",
          base_ref: "main",
          problem_statement: "Trigger conflicting PR completion options",
          task: "opencode",
          auto_ready: true,
          pull_request_completion_mode: "AutoMerge",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error:
          "Fields 'auto_ready'/'auto_merge' conflict with 'pull_request_completion_mode'.",
      });
      expect(queue.add).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await database.end();
    }
  });
});
