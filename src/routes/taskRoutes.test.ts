import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../__tests__/helpers/testDatabase";
import { JobRepository } from "../db/repository";
import type { ManagedQueue } from "../services/queue";
import { createTaskRoutes } from "./taskRoutes";

describe("createTaskRoutes", () => {
  const originalAdminBearerToken = process.env.ADMIN_BEARER_TOKEN;

  beforeEach(() => {
    process.env.ADMIN_BEARER_TOKEN = "admin-token";
  });

  afterEach(() => {
    process.env.ADMIN_BEARER_TOKEN = originalAdminBearerToken;
    vi.restoreAllMocks();
  });

  it("lists completed agent task jobs until they are soft-deleted", async () => {
    const app = Fastify();
    const database = await createTestDatabase();
    const jobRepo = new JobRepository(database);
    const queue = {} as ManagedQueue;

    try {
      await jobRepo.createAgentTaskJob({
        id: "job-visible",
        repo: "file-diff/file-diff-engine",
        taskRunner: "codex",
        model: "gpt-5.2-codex",
        baseRef: "main",
      });
      await jobRepo.createAgentTaskJob({
        id: "job-hidden",
        repo: "file-diff/file-diff-engine",
        taskRunner: "opencode",
        model: "deepseek-v4-flash",
        baseRef: "main",
      });
      await jobRepo.updateAgentTaskJobStatus("job-visible", "completed");
      await jobRepo.updateAgentTaskJobStatus("job-hidden", "completed");
      await jobRepo.markAgentTaskJobDeleted("job-hidden");

      await app.register(createTaskRoutes(jobRepo, queue));

      const response = await app.inject({
        method: "GET",
        url: "/agents/repos/file-diff/file-diff-engine/tasks",
        headers: {
          authorization: "Bearer admin-token",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject([
        {
          id: "job-visible",
          status: "completed",
          deletedAt: null,
        },
      ]);
    } finally {
      await app.close();
      await database.end();
    }
  });
});
