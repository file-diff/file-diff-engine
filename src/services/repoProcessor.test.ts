import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { afterEach, describe, expect, it } from "vitest";
import {
  listRepositoryBranches,
  listRepositoryTags,
} from "./repoProcessor";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.toString().trim();
}

async function createCommit(repoDir: string, fileName: string, content: string): Promise<string> {
  fs.writeFileSync(path.join(repoDir, fileName), content);
  await runGit(repoDir, ["add", fileName]);
  await runGit(repoDir, ["commit", "-m", `Update ${fileName}`]);
  return runGit(repoDir, ["rev-parse", "HEAD"]);
}

async function createLocalRepository(): Promise<{ repoDir: string; rootDir: string }> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-repo-processor-"));
  const repoDir = path.join(rootDir, "repo");
  fs.mkdirSync(repoDir);

  await runGit(repoDir, ["init", "--initial-branch=main"]);
  await runGit(repoDir, ["config", "user.email", "test@example.com"]);
  await runGit(repoDir, ["config", "user.name", "Test User"]);

  return { repoDir, rootDir };
}

describe("repoProcessor discovery cache", () => {
  const originalTmpDir = process.env.TMP_DIR;
  const roots: string[] = [];

  afterEach(() => {
    process.env.TMP_DIR = originalTmpDir;
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("redownloads tags so moved tags return the current commit", async () => {
    const { repoDir, rootDir } = await createLocalRepository();
    roots.push(rootDir);
    process.env.TMP_DIR = path.join(rootDir, "tmp");

    const firstCommit = await createCommit(repoDir, "file.txt", "first\n");
    await runGit(repoDir, ["tag", "v1.0.0", firstCommit]);

    await expect(listRepositoryTags(repoDir, 10)).resolves.toEqual([
      {
        name: "v1.0.0",
        ref: "refs/tags/v1.0.0",
        commit: firstCommit,
        commitShort: firstCommit.slice(0, 7),
      },
    ]);

    const secondCommit = await createCommit(repoDir, "file.txt", "second\n");
    await runGit(repoDir, ["tag", "-f", "v1.0.0", secondCommit]);

    await expect(listRepositoryTags(repoDir, 10)).resolves.toEqual([
      {
        name: "v1.0.0",
        ref: "refs/tags/v1.0.0",
        commit: secondCommit,
        commitShort: secondCommit.slice(0, 7),
      },
    ]);
  });

  it("prunes cached remote branches before listing branches", async () => {
    const { repoDir, rootDir } = await createLocalRepository();
    roots.push(rootDir);
    process.env.TMP_DIR = path.join(rootDir, "tmp");

    const mainCommit = await createCommit(repoDir, "file.txt", "main\n");
    await runGit(repoDir, ["checkout", "-b", "feature"]);
    const featureCommit = await createCommit(repoDir, "feature.txt", "feature\n");
    await runGit(repoDir, ["checkout", "main"]);

    await expect(listRepositoryBranches(repoDir)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "main",
          commit: mainCommit,
          isDefault: true,
        }),
        expect.objectContaining({
          name: "feature",
          commit: featureCommit,
          isDefault: false,
        }),
      ])
    );

    await runGit(repoDir, ["branch", "-D", "feature"]);

    const branches = await listRepositoryBranches(repoDir);
    expect(branches.map((branch) => branch.name)).toEqual(["main"]);
  });
});
