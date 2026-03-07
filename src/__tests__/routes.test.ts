import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { DatabaseClient } from "../db/database";
import { JobRepository } from "../db/repository";
import { createJobRoutes } from "../routes/jobs";
import { Queue } from "bullmq";
import { createTestDatabase } from "./helpers/testDatabase";

// Helper to make requests without supertest
async function makeRequest(
  app: express.Express,
  method: string,
  url: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const server = app.listen(0, async () => {
      const addr = server.address() as { port: number };
      const fetchOptions: RequestInit = {
        method,
        headers: { "Content-Type": "application/json" },
      };
      if (body) {
        fetchOptions.body = JSON.stringify(body);
      }
      const res = await fetch(`http://127.0.0.1:${addr.port}${url}`, fetchOptions);
      const json = await res.json();
      server.close();
      resolve({ status: res.status, body: json });
    });
  });
}

describe("Job Routes", () => {
  let db: DatabaseClient;
  let jobRepo: JobRepository;
  let app: express.Express;
  let mockQueue: Queue;

  beforeEach(async () => {
    db = await createTestDatabase();
    jobRepo = new JobRepository(db);

    mockQueue = {
      add: vi.fn().mockResolvedValue({}),
    } as unknown as Queue;

    app = express();
    app.use(express.json());
    app.use("/api/jobs", createJobRoutes(mockQueue, jobRepo));
  });

  afterEach(async () => {
    await db.end();
  });

  it("POST /api/jobs - should create a job", async () => {
    const res = await makeRequest(app, "POST", "/api/jobs", {
      repo: "facebook/react",
      ref: "v18.0.0",
    });
    expect(res.status).toBe(201);
    const resBody = res.body as { id: string; status: string };
    expect(resBody.id).toBeDefined();
    expect(resBody.status).toBe("waiting");
    expect(mockQueue.add).toHaveBeenCalled();
  });

  it("POST /api/jobs - should reject missing fields", async () => {
    const res = await makeRequest(app, "POST", "/api/jobs", {
      repo: "facebook/react",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/jobs - should reject invalid repo format", async () => {
    const res = await makeRequest(app, "POST", "/api/jobs", {
      repo: "invalid-format",
      ref: "v1.0.0",
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/jobs/:id - should return job info", async () => {
    await jobRepo.createJob("test-job-1", "owner/repo", "main");
    const res = await makeRequest(app, "GET", "/api/jobs/test-job-1");
    expect(res.status).toBe(200);
    const resBody = res.body as { id: string; status: string };
    expect(resBody.id).toBe("test-job-1");
    expect(resBody.status).toBe("waiting");
  });

  it("GET /api/jobs/:id - should return 404 for unknown job", async () => {
    const res = await makeRequest(app, "GET", "/api/jobs/unknown-id");
    expect(res.status).toBe(404);
  });

  it("GET /api/jobs/:id/files - should return files for a job", async () => {
    await jobRepo.createJob("test-job-2", "owner/repo", "main");
    await jobRepo.insertFiles("test-job-2", [
      {
        file_type: "t",
        file_name: "README.md",
        file_size: 50,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: "deadbeef",
      },
    ]);
    const res = await makeRequest(app, "GET", "/api/jobs/test-job-2/files");
    expect(res.status).toBe(200);
    const resBody = res.body as { files: unknown[] };
    expect(resBody.files).toHaveLength(1);
    expect((resBody.files[0] as { file_git_hash: string }).file_git_hash).toBe(
      "deadbeef"
    );
  });

  it("GET /api/jobs/:id/files - should return 404 for unknown job", async () => {
    const res = await makeRequest(app, "GET", "/api/jobs/unknown-id/files");
    expect(res.status).toBe(404);
  });
});
