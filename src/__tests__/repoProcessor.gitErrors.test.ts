import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("repoProcessor git error handling", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("child_process");
  });

  it("should surface git clone failures with command context", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-git-error-"));

    try {
      vi.doMock("child_process", () => ({
        execFile: vi.fn((...args: unknown[]) => {
          const callback = args[args.length - 1] as (
            error: Error & { stderr?: string; stdout?: string }
          ) => void;
          const error = Object.assign(new Error("spawn git ENOENT"), {
            stderr: "fatal: repository not found",
            stdout: "",
          });
          callback(error);
        }),
      }));

      const { processRepository } = await import("../services/repoProcessor");

      let thrown: unknown;
      try {
        await processRepository("file-diff/does-not-exist", "main", workDir);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("Git command failed: git init");
      expect((thrown as Error).message).toContain(
        "stderr: fatal: repository not found"
      );
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
