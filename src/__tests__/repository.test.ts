import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseClient } from "../db/database";
import { JobRepository } from "../db/repository";
import type { FileRecord } from "../types";
import { createTestDatabase } from "./helpers/testDatabase";

describe("JobRepository", () => {
  let repo: JobRepository;
  let db: DatabaseClient;
  const commitHash = "0123456789abcdef0123456789abcdef01234567";

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new JobRepository(db);
  });

  afterEach(async () => {
    await db.end();
  });

  it("should create and retrieve a job", async () => {
    await repo.createJob(commitHash, "owner/repo", commitHash);
    const job = await repo.getJob(commitHash);
    expect(job).toBeDefined();
    expect(job!.id).toBe(commitHash);
    expect(job!.repo).toBe("owner/repo");
    expect(job!.commit).toBe(commitHash);
    expect(job!.commitShort).toBe(commitHash.slice(0, 7));
    expect(job!.status).toBe("waiting");
    expect(job!.progress).toBe(0);
  });

  it("should return undefined for non-existent job", async () => {
    const job = await repo.getJob("non-existent");
    expect(job).toBeUndefined();
  });

  it("should update job status", async () => {
    await repo.createJob(commitHash, "owner/repo", commitHash);
    await repo.updateJobStatus(commitHash, "active");
    let job = await repo.getJob(commitHash);
    expect(job!.status).toBe("active");

    await repo.updateJobStatus(commitHash, "failed", "Something went wrong");
    job = await repo.getJob(commitHash);
    expect(job!.status).toBe("failed");
    expect(job!.error).toBe("Something went wrong");
  });

  it("should update job progress", async () => {
    await repo.createJob(commitHash, "owner/repo", commitHash);
    await repo.updateJobProgress(commitHash, 5, 10);
    const job = await repo.getJob(commitHash);
    expect(job!.processed_files).toBe(5);
    expect(job!.total_files).toBe(10);
    expect(job!.progress).toBe(50);
  });

  it("should insert and retrieve files", async () => {
    await repo.createJob(commitHash, "owner/repo", commitHash);
    const files: FileRecord[] = [
      {
        file_type: "d",
        file_name: "src",
        file_size: 0,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: "",
      },
      {
        file_type: "t",
        file_name: "src/index.ts",
        file_size: 100,
        file_update_date: "2024-01-02T00:00:00Z",
        file_last_commit: "def456",
        file_git_hash: "a1b2c3d4e5f6",
      },
      {
        file_type: "b",
        file_name: "assets/logo.png",
        file_size: 2048,
        file_update_date: "2024-01-03T00:00:00Z",
        file_last_commit: "ghi789",
        file_git_hash: "f6e5d4c3b2a1",
      },
      {
        file_type: "x",
        file_name: "bin/run.sh",
        file_size: 32,
        file_update_date: "2024-01-04T00:00:00Z",
        file_last_commit: "jkl012",
        file_git_hash: "1234567890abcdef",
      },
      {
        file_type: "s",
        file_name: "hello-link",
        file_size: 9,
        file_update_date: "2024-01-05T00:00:00Z",
        file_last_commit: "mno345",
        file_git_hash: "fedcba0987654321",
      },
    ];

    await repo.insertFiles(commitHash, files);
    const retrieved = await repo.getFiles(commitHash);
    expect(retrieved).toHaveLength(5);
    expect(retrieved[0].file_type).toBe("d");
    expect(retrieved[0].file_name).toBe("src");
    expect(retrieved[1].file_type).toBe("t");
    expect(retrieved[1].file_name).toBe("src/index.ts");
    expect(retrieved[1].file_size).toBe(100);
    expect(retrieved[2].file_type).toBe("b");
    expect(retrieved[2].file_git_hash).toBe("f6e5d4c3b2a1");
    expect(retrieved[3].file_type).toBe("x");
    expect(retrieved[3].file_name).toBe("bin/run.sh");
    expect(retrieved[4].file_type).toBe("s");
    expect(retrieved[4].file_name).toBe("hello-link");
  });

  it("should update file metadata after initial insert", async () => {
    await repo.createJob(commitHash, "owner/repo", commitHash);
    await repo.insertFiles(commitHash, [
      {
        file_type: "t",
        file_name: "README.md",
        file_size: 0,
        file_update_date: "",
        file_last_commit: "",
        file_git_hash: "",
      },
    ]);

    await repo.updateFile(commitHash, {
      file_type: "x",
      file_name: "README.md",
      file_size: 50,
      file_update_date: "2024-01-01T00:00:00Z",
      file_last_commit: "abc123",
      file_git_hash: "deadbeef",
    });

    const [updated] = await repo.getFiles(commitHash);
    expect(updated.file_type).toBe("x");
    expect(updated.file_size).toBe(50);
    expect(updated.file_update_date).toBe("2024-01-01T00:00:00Z");
    expect(updated.file_last_commit).toBe("abc123");
    expect(updated.file_git_hash).toBe("deadbeef");
  });

  it("should return empty array for job with no files", async () => {
    await repo.createJob(commitHash, "owner/repo", commitHash);
    const files = await repo.getFiles(commitHash);
    expect(files).toEqual([]);
  });
});
