import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
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
      expect((thrown as Error).message).toContain(
        "Git command failed: git clone --no-checkout"
      );
      expect((thrown as Error).message).toContain(
        "stderr: fatal: repository not found"
      );
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("should retry git fetch when the cache repository is locked by another task", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-git-lock-"));
    const repoUrl = `file://${path.join(workDir, "mock-origin.git")}`;
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const cacheKey = createHash("sha256").update(repoUrl).digest("hex");
    const cacheDir = path.join(path.dirname(path.resolve(workDir)), "repo-cache", cacheKey);
    let fetchAttempts = 0;

    fs.mkdirSync(path.join(cacheDir, ".git"), { recursive: true });

    try {
      vi.doMock("child_process", () => ({
        execFile: vi.fn((...args: unknown[]) => {
          const gitArgs = args[1] as string[];
          const callback = args[args.length - 1] as (
            error: (Error & { stderr?: string; stdout?: string }) | null,
            stdout?: string,
            stderr?: string
          ) => void;

          if (gitArgs[0] === "fetch") {
            fetchAttempts += 1;
            if (fetchAttempts < 3) {
              const error = Object.assign(new Error("git fetch lock collision"), {
                stderr: `fatal: Unable to create '${path.join(
                  cacheDir,
                  ".git",
                  "shallow.lock"
                )}': File exists.\nAnother git process seems to be running in this repository`,
                stdout: "",
              });
              callback(error);
              return;
            }
          }

          callback(null, "", "");
        }),
      }));

      const { processRepository } = await import("../services/repoProcessor");

      await expect(processRepository(repoUrl, commit, workDir)).resolves.toEqual([]);
      expect(fetchAttempts).toBe(3);
    } finally {
      fs.rmSync(path.dirname(cacheDir), { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("should configure git to use PUBLIC_GITHUB_TOKEN for GitHub HTTPS requests", async () => {
    const originalToken = process.env.PUBLIC_GITHUB_TOKEN;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-github-token-"));
    const execFile = vi.fn((...args: unknown[]) => {
      const callback = args[args.length - 1] as (
        error: (Error & { stderr?: string; stdout?: string }) | null,
        stdout?: string,
        stderr?: string
      ) => void;

      callback(
        Object.assign(new Error("spawn git ENOENT"), {
          stderr: "fatal: repository not found",
          stdout: "",
        })
      );
    });

    try {
      process.env.PUBLIC_GITHUB_TOKEN = " test-token ";

      vi.doMock("child_process", () => ({
        execFile,
      }));

      const { processRepository } = await import("../services/repoProcessor");

      await expect(
        processRepository("file-diff/file-diff-engine", "main", workDir)
      ).rejects.toThrow("fatal: repository not found");

      expect(execFile).toHaveBeenCalledTimes(1);
      const options = execFile.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
      expect(options.env).toMatchObject({
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(
          "x-access-token:test-token",
          "utf8"
        ).toString("base64")}`,
      });
    } finally {
      if (originalToken === undefined) {
        delete process.env.PUBLIC_GITHUB_TOKEN;
      } else {
        process.env.PUBLIC_GITHUB_TOKEN = originalToken;
      }
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
