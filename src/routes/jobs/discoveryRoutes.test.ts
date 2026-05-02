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

  it("queues claude tasks with the claude default model", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
    } as unknown as Queue;
    const originalClaudeModel = process.env.CLAUDE_MODEL;
    process.env.CLAUDE_MODEL = "opus";

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
          problem_statement: "Run this task with Claude",
          task: "claude",
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json() as { id: string };

      await expect(jobRepo.getAgentTaskJob(body.id)).resolves.toMatchObject({
        id: body.id,
        taskRunner: "claude",
        model: "opus",
      });

      expect(queue.add).toHaveBeenCalledWith(
        "create-claude-task",
        expect.objectContaining({
          task: "claude",
          model: "opus",
        }),
        expect.objectContaining({
          jobId: body.id,
          delay: 0,
        })
      );
    } finally {
      process.env.CLAUDE_MODEL = originalClaudeModel;
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

  it("passes an optional branch override through to the queued task payload", async () => {
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
          branch: "feature-03",
          problem_statement: "Use a requested branch name when starting the task",
          task: "codex",
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json() as { id: string };

      await expect(jobRepo.getAgentTaskJob(body.id)).resolves.toMatchObject({
        id: body.id,
        branch: "feature-03",
      });

      expect(queue.add).toHaveBeenCalledWith(
        "create-codex-task",
        expect.objectContaining({
          branch: "feature-03",
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

  it("accepts branch_title as an optional branch override", async () => {
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
          branch_title: "fd-agent/custom-name",
          problem_statement: "Use the frontend branch title when starting the task",
          task: "codex",
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json() as { id: string };

      await expect(jobRepo.getAgentTaskJob(body.id)).resolves.toMatchObject({
        id: body.id,
        branch: "fd-agent/custom-name",
      });

      expect(queue.add).toHaveBeenCalledWith(
        "create-codex-task",
        expect.objectContaining({
          branch: "fd-agent/custom-name",
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

  it("rejects conflicting branch and branch_title overrides", async () => {
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
          branch: "fd-agent/one-name",
          branch_title: "fd-agent/another-name",
          problem_statement: "Reject ambiguous branch override names",
          task: "codex",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "Fields 'branch' and 'branch_title' must match when both are provided.",
      });
      expect(queue.add).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await database.end();
    }
  });

  it("rejects an invalid branch override", async () => {
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
          branch: "bad..branch",
          problem_statement: "Reject invalid branch overrides",
          task: "codex",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error:
          "Field 'branch' must be a non-empty git ref, cannot start with '-' or '/', cannot contain '..', '@{', backslashes, or control characters.",
      });
      expect(queue.add).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await database.end();
    }
  });
});
