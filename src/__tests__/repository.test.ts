import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseClient } from "../db/database";
import { JobRepository, AmbiguousHashError } from "../db/repository";
import type { FileRecord } from "../types";
import { createTestDatabase } from "./helpers/testDatabase";

describe("JobRepository", () => {
  let repo: JobRepository;
  let db: DatabaseClient;

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new JobRepository(db);
  });

  afterEach(async () => {
    await db.end();
  });

  it("should create and retrieve a job", async () => {
    await repo.createJob("job-1", "owner/repo", "0123456789abcdef0123456789abcdef01234567");
    const job = await repo.getJob("job-1");
    expect(job).toBeDefined();
    expect(job!.id).toBe("job-1");
    expect(job!.repo).toBe("owner/repo");
    expect(job!.commit).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(job!.commitShort).toBe("0123456");
    expect(job!.status).toBe("waiting");
    expect(job!.progress).toBe(0);
  });

  it("should return undefined for non-existent job", async () => {
    const job = await repo.getJob("non-existent");
    expect(job).toBeUndefined();
  });

  it("should update job status", async () => {
    await repo.createJob("job-2", "owner/repo", "main");
    await repo.updateJobStatus("job-2", "active");
    let job = await repo.getJob("job-2");
    expect(job!.status).toBe("active");

    await repo.updateJobStatus("job-2", "failed", "Something went wrong");
    job = await repo.getJob("job-2");
    expect(job!.status).toBe("failed");
    expect(job!.error).toBe("Something went wrong");
  });

  it("should update job progress", async () => {
    await repo.createJob("job-3", "owner/repo", "main");
    await repo.updateJobProgress("job-3", 5, 10);
    const job = await repo.getJob("job-3");
    expect(job!.processedFiles).toBe(5);
    expect(job!.totalFiles).toBe(10);
    expect(job!.progress).toBe(50);
  });

  it("should reset a failed job for retry", async () => {
    await repo.createJob("job-retry", "owner/repo", "main");
    await repo.updateJobStatus("job-retry", "failed", "Something went wrong");
    await repo.updateJobProgress("job-retry", 2, 4);
    await repo.insertFiles("job-retry", [
      {
        file_type: "t",
        file_name: "README.md",
        file_size: 50,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: "deadbeef",
      },
    ]);

    await repo.resetJobForRetry("job-retry");

    const job = await repo.getJob("job-retry");
    expect(job).toBeDefined();
    expect(job!.status).toBe("waiting");
    expect(job!.error).toBeUndefined();
    expect(job!.processedFiles).toBe(0);
    expect(job!.totalFiles).toBe(0);
    expect(job!.progress).toBe(0);
    expect(await repo.getFiles("job-retry")).toEqual([]);
  });

  it("should insert and retrieve files", async () => {
    await repo.createJob("job-4", "owner/repo", "main");
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

    await repo.insertFiles("job-4", files);
    const retrieved = await repo.getFiles("job-4");
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
    await repo.createJob("job-6", "owner/repo", "main");
    await repo.insertFiles("job-6", [
      {
        file_type: "t",
        file_name: "README.md",
        file_size: 0,
        file_update_date: "",
        file_last_commit: "",
        file_git_hash: "",
      },
    ]);

    await repo.updateFile("job-6", {
      file_type: "x",
      file_name: "README.md",
      file_size: 50,
      file_update_date: "2024-01-01T00:00:00Z",
      file_last_commit: "abc123",
      file_git_hash: "deadbeef",
    });

    const [updated] = await repo.getFiles("job-6");
    expect(updated.file_type).toBe("x");
    expect(updated.file_size).toBe(50);
    expect(updated.file_update_date).toBe("2024-01-01T00:00:00Z");
    expect(updated.file_last_commit).toBe("abc123");
    expect(updated.file_git_hash).toBe("deadbeef");
  });

  it("should return empty array for job with no files", async () => {
    await repo.createJob("job-5", "owner/repo", "main");
    const files = await repo.getFiles("job-5");
    expect(files).toEqual([]);
  });

  it("should find a file by hash and expose its stored disk path", async () => {
    await repo.createJob("job-7", "owner/repo", "main");
    await repo.insertFiles("job-7", [
      {
        file_type: "t",
        file_name: "docs/readme.txt",
        file_disk_path: "docs/readme.txt",
        file_size: 12,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: "1111111111111111111111111111111111111111",
      },
    ]);

    const file = await repo.getFileByHash(
      "job-7",
      "1111111111111111111111111111111111111111"
    );

    expect(file).toEqual({
      jobId: "job-7",
      fileName: "docs/readme.txt",
      fileDiskPath: "docs/readme.txt",
      fileHash: "1111111111111111111111111111111111111111",
    });
  });

  it("should find files by hash across jobs", async () => {
    const sharedHash = "3333333333333333333333333333333333333333";
    await repo.createJob("job-8", "owner/repo", "main");
    await repo.createJob("job-9", "owner/repo", "feature");
    await repo.insertFiles("job-8", [
      {
        file_type: "t",
        file_name: "docs/left.txt",
        file_disk_path: "docs/left.txt",
        file_size: 12,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "abc123",
        file_git_hash: sharedHash,
      },
    ]);
    await repo.insertFiles("job-9", [
      {
        file_type: "t",
        file_name: "docs/right.txt",
        file_disk_path: "docs/right.txt",
        file_size: 16,
        file_update_date: "2024-01-02T00:00:00Z",
        file_last_commit: "def456",
        file_git_hash: sharedHash,
      },
    ]);

    const files = await repo.getFilesByHash(sharedHash);

    expect(files).toEqual([
      {
        jobId: "job-8",
        fileName: "docs/left.txt",
        fileDiskPath: "docs/left.txt",
        fileHash: sharedHash,
      },
      {
        jobId: "job-9",
        fileName: "docs/right.txt",
        fileDiskPath: "docs/right.txt",
        fileHash: sharedHash,
      },
    ]);
  });

  describe("short hash support", () => {
    it("should find a job by short id prefix", async () => {
      await repo.createJob(
        "0123456789abcdef0123456789abcdef01234567",
        "owner/repo",
        "0123456789abcdef0123456789abcdef01234567"
      );
      const job = await repo.getJob("0123456");
      expect(job).toBeDefined();
      expect(job!.id).toBe("0123456789abcdef0123456789abcdef01234567");
    });

    it("should throw AmbiguousHashError when short id matches multiple jobs", async () => {
      await repo.createJob(
        "aa11111111111111111111111111111111111111",
        "owner/repo",
        "aa11111111111111111111111111111111111111"
      );
      await repo.createJob(
        "aa22222222222222222222222222222222222222",
        "owner/repo",
        "aa22222222222222222222222222222222222222"
      );
      await expect(repo.getJob("aa")).rejects.toThrow(AmbiguousHashError);
    });

    it("should return undefined when short id matches no jobs", async () => {
      const job = await repo.getJob("ff");
      expect(job).toBeUndefined();
    });

    it("should find a job by short commit prefix", async () => {
      await repo.createJob(
        "job-short-commit",
        "owner/repo",
        "abcdef1234567890abcdef1234567890abcdef12"
      );
      const job = await repo.getJobByCommit("abcdef12");
      expect(job).toBeDefined();
      expect(job!.commit).toBe(
        "abcdef1234567890abcdef1234567890abcdef12"
      );
    });

    it("should throw AmbiguousHashError when short commit matches multiple distinct commits", async () => {
      await repo.createJob(
        "job-ambig-1",
        "owner/repo",
        "bb11111111111111111111111111111111111111"
      );
      await repo.createJob(
        "job-ambig-2",
        "owner/repo",
        "bb22222222222222222222222222222222222222"
      );
      await expect(repo.getJobByCommit("bb")).rejects.toThrow(
        AmbiguousHashError
      );
    });

    it("should find a file by short hash prefix within a job", async () => {
      await repo.createJob("job-short-file", "owner/repo", "main");
      await repo.insertFiles("job-short-file", [
        {
          file_type: "t",
          file_name: "readme.txt",
          file_disk_path: "readme.txt",
          file_size: 10,
          file_update_date: "2024-01-01T00:00:00Z",
          file_last_commit: "abc",
          file_git_hash:
            "cc11111111111111111111111111111111111111",
        },
      ]);
      const file = await repo.getFileByHash("job-short-file", "cc1111");
      expect(file).toBeDefined();
      expect(file!.fileHash).toBe(
        "cc11111111111111111111111111111111111111"
      );
    });

    it("should throw AmbiguousHashError when short file hash matches multiple distinct hashes in a job", async () => {
      await repo.createJob("job-ambig-file", "owner/repo", "main");
      await repo.insertFiles("job-ambig-file", [
        {
          file_type: "t",
          file_name: "a.txt",
          file_disk_path: "a.txt",
          file_size: 10,
          file_update_date: "2024-01-01T00:00:00Z",
          file_last_commit: "abc",
          file_git_hash:
            "dd11111111111111111111111111111111111111",
        },
        {
          file_type: "t",
          file_name: "b.txt",
          file_disk_path: "b.txt",
          file_size: 10,
          file_update_date: "2024-01-01T00:00:00Z",
          file_last_commit: "abc",
          file_git_hash:
            "dd22222222222222222222222222222222222222",
        },
      ]);
      await expect(
        repo.getFileByHash("job-ambig-file", "dd")
      ).rejects.toThrow(AmbiguousHashError);
    });

    it("should find files by short hash prefix across jobs", async () => {
      const fullHash = "ee11111111111111111111111111111111111111";
      await repo.createJob("job-cross-1", "owner/repo", "main1");
      await repo.createJob("job-cross-2", "owner/repo", "main2");
      await repo.insertFiles("job-cross-1", [
        {
          file_type: "t",
          file_name: "a.txt",
          file_disk_path: "a.txt",
          file_size: 10,
          file_update_date: "2024-01-01T00:00:00Z",
          file_last_commit: "abc",
          file_git_hash: fullHash,
        },
      ]);
      await repo.insertFiles("job-cross-2", [
        {
          file_type: "t",
          file_name: "a.txt",
          file_disk_path: "a.txt",
          file_size: 10,
          file_update_date: "2024-01-01T00:00:00Z",
          file_last_commit: "abc",
          file_git_hash: fullHash,
        },
      ]);
      const files = await repo.getFilesByHash("ee1111");
      expect(files).toHaveLength(2);
      expect(files[0].fileHash).toBe(fullHash);
      expect(files[1].fileHash).toBe(fullHash);
    });

    it("should throw AmbiguousHashError when short hash matches multiple distinct file hashes across jobs", async () => {
      await repo.createJob("job-cross-ambig-1", "owner/repo", "main1");
      await repo.createJob("job-cross-ambig-2", "owner/repo", "main2");
      await repo.insertFiles("job-cross-ambig-1", [
        {
          file_type: "t",
          file_name: "a.txt",
          file_disk_path: "a.txt",
          file_size: 10,
          file_update_date: "2024-01-01T00:00:00Z",
          file_last_commit: "abc",
          file_git_hash:
            "ff11111111111111111111111111111111111111",
        },
      ]);
      await repo.insertFiles("job-cross-ambig-2", [
        {
          file_type: "t",
          file_name: "b.txt",
          file_disk_path: "b.txt",
          file_size: 10,
          file_update_date: "2024-01-01T00:00:00Z",
          file_last_commit: "def",
          file_git_hash:
            "ff22222222222222222222222222222222222222",
        },
      ]);
      await expect(repo.getFilesByHash("ff")).rejects.toThrow(
        AmbiguousHashError
      );
    });
  });
});
