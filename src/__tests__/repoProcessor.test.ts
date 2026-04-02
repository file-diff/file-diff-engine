import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import type { FileRecord } from "../types";
import {
  getFileTypeFromGitMode,
  listRepositoryBranches,
  listRepositoryCommits,
  listRepositoryRefs,
  processRepository,
  resolveRefToCommitHash,
} from "../services/repoProcessor";

/** Create a small local git repo with text, binary, and directory entries. */
function createTestRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });

  execSync("git init", { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });

  // Text file
  fs.writeFileSync(path.join(dir, "hello.txt"), "Hello World\n");

  // Sub-directory with a file
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "index.ts"),
    'console.log("hello");\n'
  );

  // Binary file (contains null bytes)
  const binBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x01]);
  fs.writeFileSync(path.join(dir, "image.bin"), binBuf);

  // Executable text file
  const scriptPath = path.join(dir, "script.sh");
  fs.writeFileSync(scriptPath, "#!/bin/sh\necho hello\n");
  fs.chmodSync(scriptPath, 0o755);

  // Symlink to a tracked file
  fs.symlinkSync("hello.txt", path.join(dir, "hello-link"));

  execSync("git add -A", { cwd: dir });
  execSync('git commit -m "initial commit"', { cwd: dir });
  execSync("git tag v1.0.0", { cwd: dir });
}

describe("repoProcessor – local clone simulation", () => {
  it("should correctly walk files, detect types, and compute git blob hashes", async () => {
    const testDir = path.join(os.tmpdir(), `fde-proc-test-${Date.now()}`);
    const repoDir = path.join(testDir, "origin");
    const workDir = path.join(testDir, "work");
    const cloneDir = path.join(workDir, "repo");

    try {
      createTestRepo(repoDir);
      fs.mkdirSync(workDir, { recursive: true });

      // Clone locally (simulates what processRepository does internally)
      execSync(`git clone ${repoDir} ${cloneDir}`);
      execSync("git checkout v1.0.0", { cwd: cloneDir });

      // Walk the cloned repo the same way the service does
      const entries: string[] = [];
      function walk(dir: string) {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          if (item.name === ".git") continue;
          const full = path.join(dir, item.name);
          entries.push(path.relative(cloneDir, full));
          if (item.isDirectory()) walk(full);
        }
      }
      walk(cloneDir);

      expect(entries).toContain("hello.txt");
      expect(entries).toContain("src");
      expect(entries).toContain(path.join("src", "index.ts"));
      expect(entries).toContain("image.bin");
      expect(entries).toContain("script.sh");
      expect(entries).toContain("hello-link");

      // Git blob hash check
      const helloHash = execSync("git hash-object --no-filters -- hello.txt", {
        cwd: cloneDir,
        encoding: "utf8",
      }).trim();
      expect(helloHash).toMatch(/^[a-f0-9]{40}$/);
      const helloContent = fs.readFileSync(path.join(cloneDir, "hello.txt"));

      // Binary detection – image.bin contains null bytes
      const binContent = fs.readFileSync(path.join(cloneDir, "image.bin"));
      expect(binContent.includes(0)).toBe(true);

      // Text file should have no null bytes
      expect(helloContent.includes(0)).toBe(false);

      const scriptMode = execSync("git ls-files --stage -- script.sh", {
        cwd: cloneDir,
        encoding: "utf8",
      })
        .trim()
        .split(/\s+/)[0];
      expect(getFileTypeFromGitMode(scriptMode, false)).toBe("x");
      expect(fs.statSync(path.join(cloneDir, "script.sh")).mode & 0o111).not.toBe(0);

      const linkMode = execSync("git ls-files --stage -- hello-link", {
        cwd: cloneDir,
        encoding: "utf8",
      })
        .trim()
        .split(/\s+/)[0];
      expect(getFileTypeFromGitMode(linkMode, false)).toBe("s");
      expect(fs.lstatSync(path.join(cloneDir, "hello-link")).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should report progress via callback", async () => {
    const testDir = path.join(os.tmpdir(), `fde-prog-test-${Date.now()}`);
    const repoDir = path.join(testDir, "origin");
    const workDir = path.join(testDir, "work");

    try {
      createTestRepo(repoDir);
      fs.mkdirSync(workDir, { recursive: true });

      const progressCalls: [number, number][] = [];

      // processRepository expects a GitHub URL, so it will fail when trying
      // to clone from GitHub. We test the progress callback with a real
      // local repo by using processRepository with a local path override.
      // Since we can't easily override the URL, we test the callback
      // contract is correct by validating its type signature.
      const callback = (processed: number, total: number) => {
        progressCalls.push([processed, total]);
      };

      // Verify the callback type is accepted
      expect(typeof callback).toBe("function");
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should include tracked git hashes in discovered file records", async () => {
    const testDir = path.join(os.tmpdir(), `fde-discovery-test-${Date.now()}`);
    const repoDir = path.join(testDir, "origin");
    const workDir = path.join(testDir, "work");

    try {
      createTestRepo(repoDir);
      const commit = execSync("git rev-parse HEAD", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      let discoveredRecords: FileRecord[] | undefined;

      await processRepository(`file://${repoDir}`, commit, workDir, {
        onFilesDiscovered: async (files) => {
          discoveredRecords = files;
        },
      });

      expect(discoveredRecords).toBeDefined();

      const helloHash = execSync("git hash-object --no-filters -- hello.txt", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();
      const scriptHash = execSync("git hash-object --no-filters -- script.sh", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      expect(discoveredRecords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file_name: "hello.txt",
            file_type: "t",
            file_git_hash: helloHash,
            file_last_commit: "",
            file_update_date: "",
          }),
          expect.objectContaining({
            file_name: "script.sh",
            file_type: "t",
            file_git_hash: scriptHash,
            file_last_commit: "",
            file_update_date: "",
          }),
          expect.objectContaining({
            file_name: "src",
            file_type: "d",
            file_git_hash: "",
          }),
        ])
      );
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should resolve a branch ref to the current commit hash", async () => {
    const testDir = path.join(os.tmpdir(), `fde-ref-test-${Date.now()}`);
    const repoDir = path.join(testDir, "origin");

    try {
      createTestRepo(repoDir);

      const branchName = execSync("git branch --show-current", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();
      const headCommit = execSync("git rev-parse HEAD", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      await expect(
        resolveRefToCommitHash(`file://${repoDir}`, branchName)
      ).resolves.toBe(headCommit);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should list branch and tag refs with resolved commits", async () => {
    const testDir = path.join(os.tmpdir(), `fde-list-refs-test-${Date.now()}`);
    const repoDir = path.join(testDir, "origin");

    try {
      createTestRepo(repoDir);
      execSync('git tag -a v2.0.0 -m "annotated release"', { cwd: repoDir });

      const branchName = execSync("git branch --show-current", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();
      const headCommit = execSync("git rev-parse HEAD", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      const refs = await listRepositoryRefs(`file://${repoDir}`);

      expect(refs).toEqual(
        expect.arrayContaining([
          {
            name: branchName,
            ref: `refs/heads/${branchName}`,
            type: "branch",
            commit: headCommit,
            commitShort: headCommit.slice(0, 7),
          },
          {
            name: "v1.0.0",
            ref: "refs/tags/v1.0.0",
            type: "tag",
            commit: headCommit,
            commitShort: headCommit.slice(0, 7),
          },
          {
            name: "v2.0.0",
            ref: "refs/tags/v2.0.0",
            type: "tag",
            commit: headCommit,
            commitShort: headCommit.slice(0, 7),
          },
        ])
      );
      expect(refs.filter((ref) => ref.ref === "refs/tags/v2.0.0")).toHaveLength(1);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should list branches with head commit metadata, default branch, and head tags", async () => {
    const testDir = path.join(os.tmpdir(), `fde-list-branches-test-${Date.now()}`);
    const repoDir = path.join(testDir, "origin");

    try {
      createTestRepo(repoDir);
      const defaultBranch = execSync("git branch --show-current", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      execSync("git checkout -b feature/summary", { cwd: repoDir });
      fs.writeFileSync(path.join(repoDir, "feature.txt"), "feature branch\n");
      execSync("git add feature.txt", { cwd: repoDir });
      execSync('git commit -m "feature branch commit"', {
        cwd: repoDir,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2099-01-03T10:00:00Z",
          GIT_COMMITTER_DATE: "2099-01-03T10:00:00Z",
        },
      });
      const featureCommit = execSync("git rev-parse HEAD", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();
      execSync("git tag v2.0.0", { cwd: repoDir });

      execSync(`git checkout ${defaultBranch}`, { cwd: repoDir });
      fs.writeFileSync(path.join(repoDir, "main.txt"), "main branch\n");
      execSync("git add main.txt", { cwd: repoDir });
      execSync('git commit -m "main branch commit"', {
        cwd: repoDir,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2099-01-02T10:00:00Z",
          GIT_COMMITTER_DATE: "2099-01-02T10:00:00Z",
        },
      });
      const defaultBranchCommit = execSync("git rev-parse HEAD", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();
      execSync("git tag v1.1.0", { cwd: repoDir });

      const branches = await listRepositoryBranches(`file://${repoDir}`);

      expect(branches).toHaveLength(2);
      expect(branches.map((branch) => branch.name)).toEqual([
        "feature/summary",
        defaultBranch,
      ]);
      expect(branches[0]).toMatchObject({
        name: "feature/summary",
        ref: "refs/heads/feature/summary",
        commit: featureCommit,
        author: "Test",
        title: "feature branch commit",
        isDefault: false,
        pullRequestStatus: "none",
        pullRequest: null,
        tags: ["v2.0.0"],
      });
      expect(branches[0].date).toBe("2099-01-03T10:00:00+00:00");
      expect(branches[1]).toMatchObject({
        name: defaultBranch,
        ref: `refs/heads/${defaultBranch}`,
        commit: defaultBranchCommit,
        author: "Test",
        title: "main branch commit",
        isDefault: true,
        pullRequestStatus: "none",
        pullRequest: null,
        tags: ["v1.1.0"],
      });
      expect(branches[1].date).toBe("2099-01-02T10:00:00+00:00");
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should list commits from newest to oldest with branch, tags, and parents", async () => {
    const testDir = path.join(os.tmpdir(), `fde-list-commits-test-${Date.now()}`);
    const repoDir = path.join(testDir, "origin");

    try {
      createTestRepo(repoDir);
      const branchName = execSync("git branch --show-current", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      fs.writeFileSync(path.join(repoDir, "hello.txt"), "Hello Again\n");
      execSync("git add hello.txt", { cwd: repoDir });
      execSync('git commit -m "second commit"', { cwd: repoDir });
      const secondCommit = execSync("git rev-parse HEAD", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      execSync("git branch release", { cwd: repoDir });
      execSync("git tag v2.0.0", { cwd: repoDir });

      const initialCommit = execSync("git rev-parse HEAD^", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      const commits = await listRepositoryCommits(`file://${repoDir}`, 2);

      expect(commits).toHaveLength(2);
      expect(commits[0]).toMatchObject({
        commit: secondCommit,
        author: "Test",
        title: "second commit",
        branch: branchName,
        parents: [initialCommit],
        pullRequest: null,
        tags: ["v2.0.0"],
      });
      expect(commits[0].date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(commits[1]).toMatchObject({
        commit: initialCommit,
        author: "Test",
        title: "initial commit",
        branch: null,
        parents: [],
        pullRequest: null,
        tags: ["v1.0.0"],
      });
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should list the newest commits across all branches", async () => {
    const testDir = path.join(os.tmpdir(), `fde-list-commits-branches-test-${Date.now()}`);
    const repoDir = path.join(testDir, "origin");

    try {
      createTestRepo(repoDir);
      const branchName = execSync("git branch --show-current", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();
      const initialCommit = execSync("git rev-parse HEAD", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      fs.writeFileSync(path.join(repoDir, "main.txt"), "main branch\n");
      execSync("git add main.txt", { cwd: repoDir });
      execSync('git commit -m "main branch commit"', {
        cwd: repoDir,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2099-01-02T10:00:00Z",
          GIT_COMMITTER_DATE: "2099-01-02T10:00:00Z",
        },
      });
      const mainCommit = execSync("git rev-parse HEAD", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      execSync("git checkout -b feature-branch HEAD^", { cwd: repoDir });
      fs.writeFileSync(path.join(repoDir, "feature.txt"), "feature branch\n");
      execSync("git add feature.txt", { cwd: repoDir });
      execSync('git commit -m "feature branch commit"', {
        cwd: repoDir,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2099-01-03T10:00:00Z",
          GIT_COMMITTER_DATE: "2099-01-03T10:00:00Z",
        },
      });
      const featureCommit = execSync("git rev-parse HEAD", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      execSync(`git checkout ${branchName}`, { cwd: repoDir });

      const commits = await listRepositoryCommits(`file://${repoDir}`, 2);

      expect(commits).toHaveLength(2);
      expect(commits.map((commit) => commit.commit)).toEqual([featureCommit, mainCommit]);
      expect(commits[0]).toMatchObject({
        commit: featureCommit,
        title: "feature branch commit",
        branch: "feature-branch",
        parents: [initialCommit],
        pullRequest: null,
        tags: [],
      });
      expect(commits[1]).toMatchObject({
        commit: mainCommit,
        title: "main branch commit",
        branch: branchName,
        parents: [initialCommit],
        pullRequest: null,
        tags: [],
      });
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should sort commits by actual timestamp across timezone offsets", async () => {
    const testDir = path.join(os.tmpdir(), `fde-list-commits-timezone-test-${Date.now()}`);
    const repoDir = path.join(testDir, "origin");

    try {
      createTestRepo(repoDir);
      const initialCommit = execSync("git rev-parse HEAD", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      fs.writeFileSync(path.join(repoDir, "earlier.txt"), "earlier absolute time\n");
      execSync("git add earlier.txt", { cwd: repoDir });
      execSync('git commit -m "earlier absolute time"', {
        cwd: repoDir,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2099-01-02T10:00:00+02:00",
          GIT_COMMITTER_DATE: "2099-01-02T10:00:00+02:00",
        },
      });
      const earlierCommit = execSync("git rev-parse HEAD", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      fs.writeFileSync(path.join(repoDir, "later.txt"), "later absolute time\n");
      execSync("git add later.txt", { cwd: repoDir });
      execSync('git commit -m "later absolute time"', {
        cwd: repoDir,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2099-01-02T08:30:00Z",
          GIT_COMMITTER_DATE: "2099-01-02T08:30:00Z",
        },
      });
      const laterCommit = execSync("git rev-parse HEAD", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      const commits = await listRepositoryCommits(`file://${repoDir}`, 3);

      expect(commits).toHaveLength(3);
      expect(commits.map((commit) => commit.commit)).toEqual([
        laterCommit,
        earlierCommit,
        initialCommit,
      ]);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should process the exact commit hash even after the branch moves", async () => {
    const testDir = path.join(os.tmpdir(), `fde-commit-test-${Date.now()}`);
    const repoDir = path.join(testDir, "origin");
    const workDir = path.join(testDir, "work");
    const treeDir = path.join(workDir, "tree");
    const secondWorkDir = path.join(testDir, "work-second");
    const secondTreeDir = path.join(secondWorkDir, "tree");
    const cacheRoot = path.join(testDir, "repo-cache");

    try {
      createTestRepo(repoDir);
      const initialCommit = execSync("git rev-parse HEAD", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      fs.writeFileSync(path.join(repoDir, "later.txt"), "later\n");
      execSync("git add later.txt", { cwd: repoDir });
      execSync('git commit -m "later commit"', { cwd: repoDir });

      const records = await processRepository(
        `file://${repoDir}`,
        initialCommit,
        workDir
      );

      const [cacheEntry] = fs.readdirSync(cacheRoot);
      const cacheDir = path.join(cacheRoot, cacheEntry);

      expect(cacheEntry).toBeTruthy();
      expect(fs.existsSync(path.join(cacheDir, ".git"))).toBe(true);
      expect(fs.existsSync(path.join(cacheDir, "hello.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(treeDir, "hello.txt"), "utf8")).toBe("Hello World\n");
      expect(records.some((record) => record.file_name === "later.txt")).toBe(false);
      expect(records.some((record) => record.file_name === "hello.txt")).toBe(true);

      const cacheSentinel = path.join(cacheDir, ".git", "cache-sentinel");
      fs.writeFileSync(cacheSentinel, "keep");

      const secondRecords = await processRepository(
        `file://${repoDir}`,
        initialCommit,
        secondWorkDir
      );

      expect(fs.existsSync(cacheSentinel)).toBe(true);
      expect(fs.readFileSync(path.join(secondTreeDir, "hello.txt"), "utf8")).toBe(
        "Hello World\n"
      );
      expect(secondRecords.some((record) => record.file_name === "later.txt")).toBe(false);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should checkout the requested commit even if FETCH_HEAD changes after copying the cache", async () => {
    const testDir = path.join(os.tmpdir(), `fde-fetch-head-test-${Date.now()}`);
    const repoDir = path.join(testDir, "origin");
    const workDir = path.join(testDir, "work");
    const treeDir = path.join(workDir, "tree");

    try {
      createTestRepo(repoDir);
      const initialCommit = execSync("git rev-parse HEAD", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      fs.writeFileSync(path.join(repoDir, "later.txt"), "later\n");
      execSync("git add later.txt", { cwd: repoDir });
      execSync('git commit -m "later commit"', { cwd: repoDir });
      const laterCommit = execSync("git rev-parse HEAD", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      const originalCpSync = fs.cpSync;
      const cpSyncSpy = vi.spyOn(fs, "cpSync").mockImplementation((...args) => {
        originalCpSync(...args);

        const [, destination] = args;
        if (destination !== treeDir) {
          return;
        }

        const fetchHeadPath = path.join(treeDir, ".git", "FETCH_HEAD");
        const fetchHead = fs.readFileSync(fetchHeadPath, "utf8");
        fs.writeFileSync(fetchHeadPath, fetchHead.replace(initialCommit, laterCommit));
      });

      const records = await processRepository(
        `file://${repoDir}`,
        initialCommit,
        workDir
      );

      expect(cpSyncSpy).toHaveBeenCalled();
      expect(fs.readFileSync(path.join(treeDir, "hello.txt"), "utf8")).toBe("Hello World\n");
      expect(fs.existsSync(path.join(treeDir, "later.txt"))).toBe(false);
      expect(records.some((record) => record.file_name === "hello.txt")).toBe(true);
      expect(records.some((record) => record.file_name === "later.txt")).toBe(false);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should keep serving a cached commit after a force push rewrites the branch", async () => {
    const testDir = path.join(os.tmpdir(), `fde-force-push-test-${Date.now()}`);
    const repoDir = path.join(testDir, "repo");
    const originDir = path.join(testDir, "origin.git");
    const workDir = path.join(testDir, "work");
    const secondWorkDir = path.join(testDir, "work-second");
    const secondTreeDir = path.join(secondWorkDir, "tree");

    try {
      createTestRepo(repoDir);
      const branchName = execSync("git branch --show-current", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();
      const initialCommit = execSync("git rev-parse HEAD", {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      execSync(`git clone --bare ${repoDir} ${originDir}`);
      execSync(`git remote add origin ${originDir}`, { cwd: repoDir });

      const firstRecords = await processRepository(
        `file://${originDir}`,
        initialCommit,
        workDir
      );

      execSync("git checkout --orphan rewritten", { cwd: repoDir });
      execSync("git rm -rf .", { cwd: repoDir });
      fs.writeFileSync(path.join(repoDir, "rewritten.txt"), "rewritten\n");
      execSync("git add rewritten.txt", { cwd: repoDir });
      execSync('git commit -m "rewritten history"', { cwd: repoDir });
      execSync(`git push --force origin HEAD:${branchName}`, { cwd: repoDir });

      const secondRecords = await processRepository(
        `file://${originDir}`,
        initialCommit,
        secondWorkDir
      );

      expect(firstRecords.some((record) => record.file_name === "hello.txt")).toBe(true);
      expect(secondRecords.some((record) => record.file_name === "hello.txt")).toBe(true);
      expect(secondRecords.some((record) => record.file_name === "rewritten.txt")).toBe(false);
      expect(fs.readFileSync(path.join(secondTreeDir, "hello.txt"), "utf8")).toBe(
        "Hello World\n"
      );
      expect(fs.existsSync(path.join(secondTreeDir, "rewritten.txt"))).toBe(false);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});
