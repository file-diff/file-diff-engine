import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { describe, expect, it } from "vitest";
import {
  formatRevertToCommitCliOutput,
  revertToCommit,
} from "../github/operations/revertToCommit";

function createRemoteRepository(rootDir: string): {
  sourceDir: string;
  remoteDir: string;
  firstCommit: string;
  secondCommit: string;
} {
  const sourceDir = path.join(rootDir, "source");
  const remoteDir = path.join(rootDir, "origin.git");

  fs.mkdirSync(sourceDir, { recursive: true });
  execSync("git init --initial-branch=main", { cwd: sourceDir });
  execSync('git config user.email "test@test.com"', { cwd: sourceDir });
  execSync('git config user.name "Test User"', { cwd: sourceDir });

  fs.writeFileSync(path.join(sourceDir, "hello.txt"), "first version\n");
  fs.writeFileSync(path.join(sourceDir, "keep.txt"), "keep\n");
  execSync("git add -A", { cwd: sourceDir });
  execSync('git commit -m "first commit"', { cwd: sourceDir });
  const firstCommit = execSync("git rev-parse HEAD", {
    cwd: sourceDir,
    encoding: "utf8",
  }).trim();

  fs.writeFileSync(path.join(sourceDir, "hello.txt"), "second version\n");
  fs.rmSync(path.join(sourceDir, "keep.txt"));
  fs.writeFileSync(path.join(sourceDir, "new.txt"), "new file\n");
  execSync("git add -A", { cwd: sourceDir });
  execSync('git commit -m "second commit"', { cwd: sourceDir });
  const secondCommit = execSync("git rev-parse HEAD", {
    cwd: sourceDir,
    encoding: "utf8",
  }).trim();

  execSync(`git clone --bare -- ${sourceDir} ${remoteDir}`);

  return { sourceDir, remoteDir, firstCommit, secondCommit };
}

describe("revertToCommit", () => {
  it("creates a new branch whose tree matches the requested commit and removes the workspace", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-revert-test-"));
    const workDir = path.join(rootDir, "workspace");

    try {
      const { remoteDir, firstCommit } = createRemoteRepository(rootDir);

      const result = await revertToCommit({
        repo: `file://${remoteDir}`,
        commit: firstCommit,
        branch: "main",
        workDir,
      });

      expect(result.branch).toBe("main");
      expect(result.commit).toBe(firstCommit);
      expect(result.revertBranch).toMatch(/^revert-to-[a-f0-9]{7}-\d+$/);
      expect(result.pullRequest).toBeNull();
      expect(fs.existsSync(workDir)).toBe(false);
      expect(result.log.map((entry) => entry.message)).toEqual([
        `Cloned branch 'main' from 'file://${remoteDir}' into the temporary workspace.`,
        `Fetched commit '${firstCommit}' from 'origin'.`,
        `Resolved requested commit to '${firstCommit}'.`,
        "Configured git author for the generated restore commit.",
        `Created branch '${result.revertBranch}' from 'main'.`,
        `Reset branch contents to match commit '${firstCommit}'.`,
        `Created restore commit 'Restore repository to commit ${firstCommit.slice(0, 7)}'.`,
        `Resolved generated restore commit to '${result.revertCommit}'.`,
        `Pushed branch '${result.revertBranch}' to 'origin'.`,
      ]);

      const inspectDir = path.join(rootDir, "inspect");
      execSync(`git clone --branch ${result.revertBranch} -- ${remoteDir} ${inspectDir}`);

      const restoredTree = execSync("git rev-parse HEAD^{tree}", {
        cwd: inspectDir,
        encoding: "utf8",
      }).trim();
      const sourceTree = execSync(`git rev-parse ${firstCommit}^{tree}`, {
        cwd: inspectDir,
        encoding: "utf8",
      }).trim();

      expect(restoredTree).toBe(sourceTree);
      expect(fs.readFileSync(path.join(inspectDir, "hello.txt"), "utf8")).toBe(
        "first version\n"
      );
      expect(fs.existsSync(path.join(inspectDir, "keep.txt"))).toBe(true);
      expect(fs.existsSync(path.join(inspectDir, "new.txt"))).toBe(false);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("formats a readable CLI summary including the operation log", () => {
    const output = formatRevertToCommitCliOutput({
      repo: "facebook/react",
      branch: "main",
      commit: "0123456789abcdef0123456789abcdef01234567",
      commitShort: "0123456",
      revertBranch: "revert-to-0123456-1",
      revertCommit: "fedcba9876543210fedcba9876543210fedcba98",
      revertCommitShort: "fedcba9",
      pullRequest: {
        number: 42,
        title: "Restore main to 0123456",
        url: "https://github.com/facebook/react/pull/42",
      },
      log: [
        { message: "Cloned branch 'main' from 'https://github.com/facebook/react.git'." },
        { message: "Pushed branch 'revert-to-0123456-1' to 'origin'." },
      ],
    });

    expect(output).toContain("Revert completed successfully.");
    expect(output).toContain("Repository: facebook/react");
    expect(output).toContain("Pull request: #42 https://github.com/facebook/react/pull/42");
    expect(output).toContain("Operation log:");
    expect(output).toContain("1. Cloned branch 'main' from 'https://github.com/facebook/react.git'.");
    expect(output).toContain("2. Pushed branch 'revert-to-0123456-1' to 'origin'.");
  });
});
