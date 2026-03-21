import { describe, expect, it } from "vitest";
import type { FileRecord, JobFilesResponse } from "../types";
import {
  serializeFiles,
  deserializeFiles,
  serializeJobFilesResponse,
  deserializeJobFilesResponse,
} from "../utils/binarySerializer";

describe("serializeFiles / deserializeFiles", () => {
  const sampleFiles: FileRecord[] = [
    {
      file_type: "t",
      file_name: "README.md",
      file_size: 1024,
      file_update_date: "2024-06-15T10:30:00Z",
      file_last_commit: "abcdef1234567890abcdef1234567890abcdef12",
      file_git_hash: "1234567890abcdef1234567890abcdef12345678",
    },
    {
      file_type: "d",
      file_name: "src",
      file_size: 0,
      file_update_date: "2024-06-14T08:00:00Z",
      file_last_commit: "fedcba0987654321fedcba0987654321fedcba09",
      file_git_hash: "",
    },
    {
      file_type: "b",
      file_name: "logo.png",
      file_size: 54321,
      file_update_date: "2024-01-01T00:00:00Z",
      file_last_commit: "0000000000000000000000000000000000000000",
      file_git_hash: "ffffffffffffffffffffffffffffffffffffffff",
    },
  ];

  it("round-trips a list of file records", () => {
    const buf = serializeFiles(sampleFiles);
    const result = deserializeFiles(buf);

    expect(result).toHaveLength(3);

    // File 1
    expect(result[0].fileType).toBe("t");
    expect(result[0].fileName).toBe("README.md");
    expect(result[0].fileSize).toBe(1024);
    expect(result[0].commitHex).toBe("abcdef12");
    expect(result[0].hashHex).toBe("12345678");
    // timestamp should be the unix seconds of the original date
    expect(result[0].updateTimestamp).toBe(
      Math.floor(new Date("2024-06-15T10:30:00Z").getTime() / 1000)
    );

    // File 2 – directory
    expect(result[1].fileType).toBe("d");
    expect(result[1].fileName).toBe("src");
    expect(result[1].fileSize).toBe(0);
    expect(result[1].commitHex).toBe("fedcba09");
    expect(result[1].hashHex).toBe("00000000"); // empty string → zeroed

    // File 3 – binary
    expect(result[2].fileType).toBe("b");
    expect(result[2].fileName).toBe("logo.png");
    expect(result[2].fileSize).toBe(54321);
    expect(result[2].commitHex).toBe("00000000");
    expect(result[2].hashHex).toBe("ffffffff");
  });

  it("handles an empty file list", () => {
    const buf = serializeFiles([]);
    expect(buf.length).toBe(0);
    expect(deserializeFiles(buf)).toEqual([]);
  });

  it("handles files with unicode names", () => {
    const files: FileRecord[] = [
      {
        file_type: "t",
        file_name: "文件/名称.txt",
        file_size: 42,
        file_update_date: "2024-03-20T12:00:00Z",
        file_last_commit: "aabbccdd",
        file_git_hash: "11223344",
      },
    ];

    const buf = serializeFiles(files);
    const result = deserializeFiles(buf);

    expect(result).toHaveLength(1);
    expect(result[0].fileName).toBe("文件/名称.txt");
    expect(result[0].fileSize).toBe(42);
  });

  it("handles short hex values by zero-padding", () => {
    const files: FileRecord[] = [
      {
        file_type: "t",
        file_name: "a.txt",
        file_size: 1,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "ab",
        file_git_hash: "cd",
      },
    ];

    const buf = serializeFiles(files);
    const result = deserializeFiles(buf);

    // "ab" → first 8 chars padded → "ab000000"
    expect(result[0].commitHex).toBe("ab000000");
    expect(result[0].hashHex).toBe("cd000000");
  });

  it("handles 0x-prefixed hex values", () => {
    const files: FileRecord[] = [
      {
        file_type: "x",
        file_name: "run.sh",
        file_size: 256,
        file_update_date: "2024-01-01T00:00:00Z",
        file_last_commit: "0xdeadbeef",
        file_git_hash: "0xcafebabe",
      },
    ];

    const buf = serializeFiles(files);
    const result = deserializeFiles(buf);

    expect(result[0].commitHex).toBe("deadbeef");
    expect(result[0].hashHex).toBe("cafebabe");
  });
});

describe("serializeJobFilesResponse / deserializeJobFilesResponse", () => {
  const sampleResponse: JobFilesResponse = {
    jobId: "job-abc-123",
    commit: "0123456789abcdef0123456789abcdef01234567",
    commitShort: "0123456",
    status: "completed",
    progress: 100,
    files: [
      {
        t: "t",
        path: "README.md",
        s: 1024,
        update: "2024-06-15T10:30:00Z",
        commit: "abcdef12",
        hash: "12345678",
      },
      {
        t: "d",
        path: "src",
        s: 0,
        update: "2024-06-14T08:00:00Z",
        commit: "fedcba09",
        hash: "00000000",
      },
    ],
  };

  it("round-trips a complete JobFilesResponse", () => {
    const buf = serializeJobFilesResponse(sampleResponse);
    const result = deserializeJobFilesResponse(buf);

    expect(result.jobId).toBe(sampleResponse.jobId);
    expect(result.commit).toBe(sampleResponse.commit);
    expect(result.commitShort).toBe(sampleResponse.commitShort);
    expect(result.status).toBe(sampleResponse.status);
    expect(result.progress).toBe(sampleResponse.progress);
    expect(result.files).toHaveLength(2);

    // File 1
    expect(result.files[0].t).toBe("t");
    expect(result.files[0].path).toBe("README.md");
    expect(result.files[0].s).toBe(1024);
    expect(result.files[0].commit).toBe("abcdef12");
    expect(result.files[0].hash).toBe("12345678");

    // File 2
    expect(result.files[1].t).toBe("d");
    expect(result.files[1].path).toBe("src");
    expect(result.files[1].s).toBe(0);
    expect(result.files[1].commit).toBe("fedcba09");
    expect(result.files[1].hash).toBe("00000000");
  });

  it("preserves each job status value", () => {
    for (const status of ["waiting", "active", "completed", "failed"] as const) {
      const response: JobFilesResponse = {
        ...sampleResponse,
        status,
        files: [],
      };
      const buf = serializeJobFilesResponse(response);
      const result = deserializeJobFilesResponse(buf);
      expect(result.status).toBe(status);
    }
  });

  it("handles fractional progress", () => {
    const response: JobFilesResponse = {
      ...sampleResponse,
      progress: 42.5,
      files: [],
    };
    const buf = serializeJobFilesResponse(response);
    const result = deserializeJobFilesResponse(buf);
    expect(result.progress).toBeCloseTo(42.5, 1);
  });

  it("handles zero progress and empty files", () => {
    const response: JobFilesResponse = {
      ...sampleResponse,
      progress: 0,
      files: [],
    };
    const buf = serializeJobFilesResponse(response);
    const result = deserializeJobFilesResponse(buf);
    expect(result.progress).toBe(0);
    expect(result.files).toEqual([]);
  });

  it("reconstructs update dates as ISO strings", () => {
    const buf = serializeJobFilesResponse(sampleResponse);
    const result = deserializeJobFilesResponse(buf);

    // The deserialized update date should correspond to the same unix second
    const originalTs = Math.floor(
      new Date("2024-06-15T10:30:00Z").getTime() / 1000
    );
    const resultTs = Math.floor(
      new Date(result.files[0].update).getTime() / 1000
    );
    expect(resultTs).toBe(originalTs);
  });
});
