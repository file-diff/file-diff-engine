import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../../__tests__/helpers/testDatabase";
import { JobRepository } from "../../db/repository";
import type { ManagedQueue } from "../../services/queue";
import { registerAgentCreateTaskRoutes } from "./createTaskRoutes";

describe("registerAgentCreateTaskRoutes", () => {
  const originalAdminBearerToken = process.env.ADMIN_BEARER_TOKEN;
  const originalViewerBearerToken = process.env.VIEWER_BEARER_TOKEN;

  beforeEach(() => {
    process.env.ADMIN_BEARER_TOKEN = "admin-token";
    process.env.VIEWER_BEARER_TOKEN = "viewer-token";
  });

  afterEach(() => {
    process.env.ADMIN_BEARER_TOKEN = originalAdminBearerToken;
    process.env.VIEWER_BEARER_TOKEN = originalViewerBearerToken;
    vi.restoreAllMocks();
  });

  it("creates an agent task under the canonical agents scope", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
    } as unknown as ManagedQueue;

    try {
      registerAgentCreateTaskRoutes(app, queue, jobRepo);

      const response = await app.inject({
        method: "POST",
        url: "/create-task",
        headers: {
          authorization: "Bearer admin-token",
        },
        payload: {
          repo: "file-diff/file-diff-engine",
          base_ref: "main",
          problem_statement: "Separate task APIs",
          task: "codex",
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json() as { id: string };
      expect(body.id).toEqual(expect.any(String));

      await expect(jobRepo.getAgentTaskJob(body.id)).resolves.toMatchObject({
        id: body.id,
        repo: "file-diff/file-diff-engine",
        baseRef: "main",
        taskRunner: "codex",
        reasoningEffort: "medium",
        reasoningSummary: "auto",
      });

      expect(queue.add).toHaveBeenCalledWith(
        "create-codex-task",
        expect.objectContaining({
          repoName: "file-diff/file-diff-engine",
          baseRef: "main",
          problemStatement: "Separate task APIs",
          task: "codex",
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

  it("passes a custom system prompt through to opencode queue jobs", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
    } as unknown as ManagedQueue;

    try {
      registerAgentCreateTaskRoutes(app, queue, jobRepo);

      const response = await app.inject({
        method: "POST",
        url: "/create-task",
        headers: {
          authorization: "Bearer admin-token",
        },
        payload: {
          repo: "file-diff/file-diff-engine",
          base_ref: "main",
          problem_statement: "Separate task APIs",
          task: "opencode",
          system_prompt: "  Run exactly this custom prompt.\n",
        },
      });

      expect(response.statusCode).toBe(201);
      expect(queue.add).toHaveBeenCalledWith(
        "create-opencode-task",
        expect.objectContaining({
          task: "opencode",
          systemPrompt: "  Run exactly this custom prompt.\n",
        }),
        expect.any(Object)
      );
    } finally {
      await app.close();
      await database.end();
    }
  });

  it("treats an empty or no system prompt as the default prompt behavior", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
    } as unknown as ManagedQueue;

    try {
      registerAgentCreateTaskRoutes(app, queue, jobRepo);

      const response = await app.inject({
        method: "POST",
        url: "/create-task",
        headers: {
          authorization: "Bearer admin-token",
        },
        payload: {
          repo: "file-diff/file-diff-engine",
          base_ref: "main",
          problem_statement: "Separate task APIs",
          task: "codex",
          system_prompt: " no ",
        },
      });

      expect(response.statusCode).toBe(201);
      const queuedPayload = vi.mocked(queue.add).mock.calls[0]?.[1] as
        | Record<string, unknown>
        | undefined;
      expect(queuedPayload).not.toHaveProperty("systemPrompt");
    } finally {
      await app.close();
      await database.end();
    }
  });

  it("rejects non-string custom system prompts", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
    } as unknown as ManagedQueue;

    try {
      registerAgentCreateTaskRoutes(app, queue, jobRepo);

      const response = await app.inject({
        method: "POST",
        url: "/create-task",
        headers: {
          authorization: "Bearer admin-token",
        },
        payload: {
          repo: "file-diff/file-diff-engine",
          base_ref: "main",
          problem_statement: "Separate task APIs",
          task: "codex",
          system_prompt: 123,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "Field 'system_prompt' must be a string.",
      });
      expect(queue.add).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await database.end();
    }
  });

  it("rejects custom system prompts for claude tasks", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
    } as unknown as ManagedQueue;

    try {
      registerAgentCreateTaskRoutes(app, queue, jobRepo);

      const response = await app.inject({
        method: "POST",
        url: "/create-task",
        headers: {
          authorization: "Bearer admin-token",
        },
        payload: {
          repo: "file-diff/file-diff-engine",
          base_ref: "main",
          problem_statement: "Separate task APIs",
          task: "claude",
          system_prompt: "Run exactly this custom prompt.",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "Field 'system_prompt' is only supported for codex and opencode tasks.",
      });
      expect(queue.add).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await database.end();
    }
  });

  it("returns agent task status under the canonical agents scope", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
    } as unknown as ManagedQueue;

    try {
      await jobRepo.createAgentTaskJob({
        id: "agent-task-1",
        repo: "file-diff/file-diff-engine",
        baseRef: "main",
        taskRunner: "codex",
        model: "gpt-5.2-codex",
      });
      registerAgentCreateTaskRoutes(app, queue, jobRepo);

      const response = await app.inject({
        method: "GET",
        url: "/create-task/agent-task-1",
        headers: {
          authorization: "Bearer viewer-token",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: "agent-task-1",
        repo: "file-diff/file-diff-engine",
        baseRef: "main",
        taskRunner: "codex",
        model: "gpt-5.2-codex",
      });
    } finally {
      await app.close();
      await database.end();
    }
  });
});
