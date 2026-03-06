import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { getDatabase } from "../db/database";
import { JobRepository } from "../db/repository";
import type { FileRecord } from "../types";

describe("JobRepository", () => {
  let dbPath: string;
  let repo: JobRepository;
  let db: ReturnType<typeof getDatabase>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fde-test-${Date.now()}.db`);
    db = getDatabase(dbPath);
    repo = new JobRepository(db);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    // Clean WAL and SHM files
    for (const ext of ["-wal", "-shm"]) {
      const f = dbPath + ext;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("should create and retrieve a job", () => {
    repo.createJob("job-1", "owner/repo", "v1.0.0");
    const job = repo.getJob("job-1");
    expect(job).toBeDefined();
    expect(job!.id).toBe("job-1");
    expect(job!.repo).toBe("owner/repo");
    expect(job!.ref).toBe("v1.0.0");
    expect(job!.status).toBe("waiting");
    expect(job!.progress).toBe(0);
  });

  it("should return undefined for non-existent job", () => {
    const job = repo.getJob("non-existent");
    expect(job).toBeUndefined();
  });

  it("should update job status", () => {
    repo.createJob("job-2", "owner/repo", "main");
    repo.updateJobStatus("job-2", "active");
    let job = repo.getJob("job-2");
    expect(job!.status).toBe("active");

    repo.updateJobStatus("job-2", "failed", "Something went wrong");
    job = repo.getJob("job-2");
    expect(job!.status).toBe("failed");
    expect(job!.error).toBe("Something went wrong");
  });

  it("should update job progress", () => {
    repo.createJob("job-3", "owner/repo", "main");
    repo.updateJobProgress("job-3", 5, 10);
    const job = repo.getJob("job-3");
    expect(job!.processed_files).toBe(5);
    expect(job!.total_files).toBe(10);
    expect(job!.progress).toBe(50);
  });

  it("should insert and retrieve files", () => {
    repo.createJob("job-4", "owner/repo", "main");
    const files: FileRecord[] = [
      {
        file_type: "d",
        file_name: "src",
        file_size: 0,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_sha256_hash: "",
      },
      {
        file_type: "t",
        file_name: "src/index.ts",
        file_size: 100,
        file_update_date: "2024-01-02T00:00:00Z",
        file_last_commit: "def456",
        file_sha256_hash: "a1b2c3d4e5f6",
      },
      {
        file_type: "b",
        file_name: "assets/logo.png",
        file_size: 2048,
        file_update_date: "2024-01-03T00:00:00Z",
        file_last_commit: "ghi789",
        file_sha256_hash: "f6e5d4c3b2a1",
      },
    ];

    repo.insertFiles("job-4", files);
    const retrieved = repo.getFiles("job-4");
    expect(retrieved).toHaveLength(3);
    expect(retrieved[0].file_type).toBe("d");
    expect(retrieved[0].file_name).toBe("src");
    expect(retrieved[1].file_type).toBe("t");
    expect(retrieved[1].file_name).toBe("src/index.ts");
    expect(retrieved[1].file_size).toBe(100);
    expect(retrieved[2].file_type).toBe("b");
    expect(retrieved[2].file_sha256_hash).toBe("f6e5d4c3b2a1");
  });

  it("should return empty array for job with no files", () => {
    repo.createJob("job-5", "owner/repo", "main");
    const files = repo.getFiles("job-5");
    expect(files).toEqual([]);
  });
});
