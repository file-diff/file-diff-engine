import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

describe("getDatabase", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.DATABASE_URL;
    delete process.env.DB_IDLE_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.doUnmock("pg");
    process.env = { ...originalEnv };
  });

  it("disables idle timeout by default for direct database connections", async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] });
    const poolConstructorMock = vi.fn().mockImplementation(function MockPool() {
      return {
        query: queryMock,
      };
    });

    vi.doMock("pg", () => ({
      Pool: poolConstructorMock,
    }));

    const { getDatabase } = await import("../db/database");

    await getDatabase();

    expect(poolConstructorMock).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 5432,
      database: "file_diff_engine",
      user: "postgres",
      password: "postgres",
      idleTimeoutMillis: 0,
    });
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS jobs")
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("ADD COLUMN IF NOT EXISTS file_disk_path")
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("CREATE INDEX IF NOT EXISTS idx_files_job_id_hash")
    );
  });

  it("allows overriding the pool idle timeout when using DATABASE_URL", async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] });
    const poolConstructorMock = vi.fn().mockImplementation(function MockPool() {
      return {
        query: queryMock,
      };
    });

    process.env.DATABASE_URL = "postgres://example:secret@localhost:5432/file_diff_engine";
    process.env.DB_IDLE_TIMEOUT_MS = "15000";

    vi.doMock("pg", () => ({
      Pool: poolConstructorMock,
    }));

    const { getDatabase } = await import("../db/database");

    await getDatabase();

    expect(poolConstructorMock).toHaveBeenCalledWith({
      connectionString:
        "postgres://example:secret@localhost:5432/file_diff_engine",
      idleTimeoutMillis: 15000,
    });
  });
});
