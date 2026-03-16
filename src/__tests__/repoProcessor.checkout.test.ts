import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

import { processRepository } from "../services/repoProcessor";

describe("repoProcessor checkout isolation", () => {
  afterEach(() => {
    execFileMock.mockReset();
  });

  it("fetches missing commits in the per-job clone instead of the shared cache", async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-checkout-test-"));
    const repoUrl = "https://github.com/file-diff/sample-data.git";
    const commit = "456f07a4cca5e77bc9c1ee9a6903349deb6060a3";
    const workDir = path.join(testDir, "work");
    const cloneDir = path.join(workDir, "tree");
    const cacheDir = path.join(
      testDir,
      "repo-cache",
      createHash("sha256").update(repoUrl).digest("hex")
    );
    const gitCalls: Array<{ cwd: string; args: string[] }> = [];
    let fetchedInClone = false;

    execFileMock.mockImplementation((file, args, options, callback) => {
      const [command, firstArg, secondArg, thirdArg, fourthArg] = args;
      const cwd = options.cwd;
      gitCalls.push({ cwd, args: [...args] });

      if (command === "clone") {
        const targetDir = args[args.length - 1];
        fs.mkdirSync(path.join(targetDir, ".git"), { recursive: true });
        callback(null, "", "");
        return {} as ReturnType<typeof execFileMock>;
      }

      if (command === "fetch") {
        if (cwd === cloneDir) {
          fetchedInClone = true;
        }
        callback(null, "", "");
        return {} as ReturnType<typeof execFileMock>;
      }

      if (
        command === "-c" &&
        secondArg === "checkout" &&
        thirdArg === "--detach" &&
        fourthArg === commit &&
        !fetchedInClone
      ) {
        callback(
          Object.assign(new Error("missing commit"), {
            stderr: "fatal: reference is not a tree",
          }),
          "",
          "fatal: reference is not a tree"
        );
        return {} as ReturnType<typeof execFileMock>;
      }

      callback(null, "", "");
      return {} as ReturnType<typeof execFileMock>;
    });

    try {
      await expect(processRepository(repoUrl, commit, workDir)).resolves.toEqual([]);

      expect(gitCalls).toEqual([
        {
          cwd: path.dirname(cacheDir),
          args: ["clone", "--no-checkout", repoUrl, cacheDir],
        },
        {
          cwd: cloneDir,
          args: ["-c", "advice.detachedHead=false", "checkout", "--detach", commit],
        },
        {
          cwd: cloneDir,
          args: ["fetch", "--depth=1", "origin", commit],
        },
        {
          cwd: cloneDir,
          args: ["-c", "advice.detachedHead=false", "checkout", "--detach", commit],
        },
      ]);
      expect(gitCalls.some((call) => call.cwd === cacheDir && call.args[0] === "fetch")).toBe(
        false
      );
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("initializes the shared cache only once when two jobs start together", async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-cache-lock-test-"));
    const repoUrl = "https://github.com/file-diff/sample-data.git";
    const baseCommit = "27ba26cb68a9cdb5a30e587eb73a56b6c42b5acf";
    const headCommit = "456f07a4cca5e77bc9c1ee9a6903349deb6060a3";
    const firstWorkDir = path.join(testDir, "first");
    const secondWorkDir = path.join(testDir, "second");
    const cacheDir = path.join(
      testDir,
      "repo-cache",
      createHash("sha256").update(repoUrl).digest("hex")
    );
    let cloneCalls = 0;

    execFileMock.mockImplementation((file, args, options, callback) => {
      const [command] = args;

      if (command === "clone") {
        cloneCalls += 1;
        const targetDir = args[args.length - 1];
        setTimeout(() => {
          fs.mkdirSync(path.join(targetDir, ".git"), { recursive: true });
          callback(null, "", "");
        }, 50);
        return {} as ReturnType<typeof execFileMock>;
      }

      callback(null, "", "");
      return {} as ReturnType<typeof execFileMock>;
    });

    try {
      await expect(
        Promise.all([
          processRepository(repoUrl, baseCommit, firstWorkDir),
          processRepository(repoUrl, headCommit, secondWorkDir),
        ])
      ).resolves.toEqual([[], []]);

      expect(cloneCalls).toBe(1);
      expect(fs.existsSync(path.join(cacheDir, ".git"))).toBe(true);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});
