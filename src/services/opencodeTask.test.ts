import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOpencodeRunArgs,
  buildTaskBranchName,
  findNewOpencodeSessionId,
  incrementBranchName,
  parseOpencodeSessionIds,
  prepareContinuedAgentTaskBranch,
  resolveOpencodePrompt,
  runAgentBootstrapIfAvailable,
} from "./opencodeTask";

const tempDirs: string[] = [];

describe("opencode task helpers", () => {
  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parses session ids from opencode session list output", () => {
    expect(
      parseOpencodeSessionIds(`Session ID                      Title                                   Updated
───────────────────────────────────────────────────────────────────────────────
ses_226f167d4ffeE5CmXZjCl54HYL  Creating documentation                  1:45 PM
ses_227113e87ffe85L4H52wmCHwGg  New session - 2026-04-29T11:10:19.000Z  1:10 PM`)
    ).toEqual([
      "ses_226f167d4ffeE5CmXZjCl54HYL",
      "ses_227113e87ffe85L4H52wmCHwGg",
    ]);
  });

  it("detects the newly created session id", () => {
    expect(
      findNewOpencodeSessionId(
        ["ses_existing"],
        ["ses_new", "ses_existing"]
      )
    ).toBe("ses_new");
  });

  it("returns the first newly detected session id when several are present", () => {
    expect(
      findNewOpencodeSessionId(
        ["ses_existing"],
        ["ses_new_1", "ses_new_2", "ses_existing"]
      )
    ).toBe("ses_new_1");
  });

  it("returns null when no new session id is detected", () => {
    expect(
      findNewOpencodeSessionId(
        ["ses_existing"],
        ["ses_existing"]
      )
    ).toBeNull();
  });

  it("adds a -1 suffix when a branch has no trailing number", () => {
    expect(incrementBranchName("branch")).toBe("branch-1");
  });

  it("increments an existing numeric suffix", () => {
    expect(incrementBranchName("branch-1")).toBe("branch-2");
  });

  it("preserves suffix width when incrementing", () => {
    expect(incrementBranchName("branch-03")).toBe("branch-04");
  });

  it("uses the fd-agent prefix for generated task branch names", () => {
    expect(buildTaskBranchName("12345678-90ab-cdef-1234-567890abcdef")).toMatch(
      /^fd-agent\/\d{8}-\d{6}-12345678$/
    );
  });

  it("uses a custom system prompt verbatim when provided", () => {
    expect(
      resolveOpencodePrompt(
        {
          problemStatement: "Fix the bug",
          systemPrompt: "Only run the exact custom workflow.",
        },
        "fd-agent/test",
        42
      )
    ).toBe("Only run the exact custom workflow.");
  });

  it("falls back to the generated opencode prompt without a custom system prompt", () => {
    expect(
      resolveOpencodePrompt(
        {
          problemStatement: "Fix the bug",
          taskMode: "task",
        },
        "fd-agent/test",
        42
      )
    ).toContain("User instructions starts here:\nFix the bug");
  });

  it("builds opencode run args that resume a previous session", () => {
    expect(buildOpencodeRunArgs("deepseek/deepseek-v4-flash", " ses_123 ")).toEqual([
      "run",
      "--model",
      "deepseek/deepseek-v4-flash",
      "--dangerously-skip-permissions",
      "--session",
      "ses_123",
      "--command",
      "command",
    ]);
  });

  it("prepares a continued task by reusing the previous workspace and pulling updates", async () => {
    const originalPrivateGithubToken = process.env.PRIVATE_GITHUB_TOKEN;
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "continued-task-"));
    tempDirs.push(rootDir);
    process.env.PRIVATE_GITHUB_TOKEN = "test-token";

    try {
      const remoteDir = path.join(rootDir, "remote.git");
      const seedDir = path.join(rootDir, "seed");
      const previousWorkDir = path.join(rootDir, "previous-work");
      const previousRepoDir = path.join(previousWorkDir, "repo");
      const updaterDir = path.join(rootDir, "updater");

      execFileSync("git", ["init", "--bare", remoteDir]);
      execFileSync("git", ["clone", remoteDir, seedDir]);
      execFileSync("git", ["config", "user.name", "Test"], { cwd: seedDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: seedDir });
      fs.writeFileSync(path.join(seedDir, "file.txt"), "initial\n", "utf8");
      execFileSync("git", ["add", "file.txt"], { cwd: seedDir });
      execFileSync("git", ["commit", "-m", "Initial"], { cwd: seedDir });
      execFileSync("git", ["branch", "-M", "main"], { cwd: seedDir });
      execFileSync("git", ["push", "-u", "origin", "main"], { cwd: seedDir });

      execFileSync("git", ["clone", "--branch", "main", remoteDir, previousRepoDir]);
      execFileSync("git", ["checkout", "-b", "fd-agent/previous"], {
        cwd: previousRepoDir,
      });
      execFileSync("git", ["push", "-u", "origin", "fd-agent/previous"], {
        cwd: previousRepoDir,
      });

      execFileSync("git", ["clone", "--branch", "fd-agent/previous", remoteDir, updaterDir]);
      execFileSync("git", ["checkout", "fd-agent/previous"], { cwd: updaterDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: updaterDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: updaterDir,
      });
      fs.writeFileSync(path.join(updaterDir, "file.txt"), "updated\n", "utf8");
      execFileSync("git", ["commit", "-am", "Update remote"], { cwd: updaterDir });
      execFileSync("git", ["push"], { cwd: updaterDir });

      await expect(
        prepareContinuedAgentTaskBranch(
          {
            jobId: "current-job",
            repo: "file-diff/file-diff-engine",
            baseRef: "main",
            problemStatement: "Continue",
            model: "deepseek-v4-flash",
            taskRunner: "opencode",
            workDir: previousWorkDir,
          },
          {
            jobId: "previous-job",
            taskRunner: "opencode",
            branch: "fd-agent/previous",
            pullRequestNumber: 10,
            pullRequestUrl: "https://github.com/file-diff/file-diff-engine/pull/10",
          }
        )
      ).resolves.toMatchObject({
        branch: "fd-agent/previous",
        pullRequest: {
          number: 10,
        },
      });

      expect(fs.readFileSync(path.join(previousRepoDir, "file.txt"), "utf8")).toBe(
        "updated\n"
      );
    } finally {
      process.env.PRIVATE_GITHUB_TOKEN = originalPrivateGithubToken;
    }
  });

  it("skips the agent bootstrap when the script is unavailable", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bootstrap-"));
    tempDirs.push(rootDir);

    await expect(runAgentBootstrapIfAvailable(rootDir)).resolves.toBeUndefined();
  });

  it("runs the agent bootstrap script with bash from the repository root", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bootstrap-"));
    tempDirs.push(rootDir);
    const bootstrapDir = path.join(rootDir, ".fd-agent");
    fs.mkdirSync(bootstrapDir, { recursive: true });
    fs.writeFileSync(
      path.join(bootstrapDir, "agent-bootstrap.sh"),
      [
        "printf '%s' \"$PWD\" > bootstrap-pwd.txt",
        "printf '%s' \"$BOOTSTRAP_MARKER\" > bootstrap-env.txt",
      ].join("\n"),
      "utf8"
    );

    await runAgentBootstrapIfAvailable(rootDir, {
      ...process.env,
      BOOTSTRAP_MARKER: "ran-through-bash",
    });

    expect(fs.readFileSync(path.join(rootDir, "bootstrap-pwd.txt"), "utf8")).toBe(
      rootDir
    );
    expect(fs.readFileSync(path.join(rootDir, "bootstrap-env.txt"), "utf8")).toBe(
      "ran-through-bash"
    );
  });

  it("surfaces bootstrap script failures before starting an agent", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bootstrap-"));
    tempDirs.push(rootDir);
    const bootstrapDir = path.join(rootDir, ".fd-agent");
    fs.mkdirSync(bootstrapDir, { recursive: true });
    fs.writeFileSync(
      path.join(bootstrapDir, "agent-bootstrap.sh"),
      "echo 'setup failed' >&2\nexit 7\n",
      "utf8"
    );

    await expect(runAgentBootstrapIfAvailable(rootDir)).rejects.toThrow(
      "Agent bootstrap script failed: setup failed"
    );
  });
});
