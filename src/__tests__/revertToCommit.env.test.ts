import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileMock, createPullRequestMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  createPullRequestMock: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("../services/githubApi", () => ({
  createPullRequest: createPullRequestMock,
}));

import { revertToCommit } from "../github/operations";

function mockGitCommands() {
  execFileMock.mockImplementation(
    (
      _file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      const command = args.join(" ");

      if (command === "rev-parse FETCH_HEAD") {
        callback(null, "0123456789abcdef0123456789abcdef01234567\n", "");
        return;
      }

      if (command === "rev-parse HEAD") {
        callback(null, "89abcdef0123456789abcdef0123456789abcdef\n", "");
        return;
      }

      callback(null, "", "");
    }
  );
}

describe("revertToCommit environment defaults", () => {
  const originalPrivateGitHubToken = process.env.PRIVATE_GITHUB_TOKEN;
  const originalPublicGitHubToken = process.env.PUBLIC_GITHUB_TOKEN;

  afterEach(() => {
    execFileMock.mockReset();
    createPullRequestMock.mockReset();

    if (originalPrivateGitHubToken === undefined) {
      delete process.env.PRIVATE_GITHUB_TOKEN;
    } else {
      process.env.PRIVATE_GITHUB_TOKEN = originalPrivateGitHubToken;
    }

    if (originalPublicGitHubToken === undefined) {
      delete process.env.PUBLIC_GITHUB_TOKEN;
    } else {
      process.env.PUBLIC_GITHUB_TOKEN = originalPublicGitHubToken;
    }
  });

  it("uses PRIVATE_GITHUB_TOKEN for pull request creation when no githubKey is provided", async () => {
    process.env.PRIVATE_GITHUB_TOKEN = " private-token ";
    delete process.env.PUBLIC_GITHUB_TOKEN;
    mockGitCommands();
    createPullRequestMock.mockResolvedValue({
      number: 123,
      title: "Restore main to 0123456",
      url: "https://github.com/owner/repo/pull/123",
    });

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fde-revert-env-test-"));

    try {
      const result = await revertToCommit({
        repo: "owner/repo",
        commit: "fedcba9876543210fedcba9876543210fedcba98",
        workDir,
      });

      expect(result.pullRequest).toEqual({
        number: 123,
        title: "Restore main to 0123456",
        url: "https://github.com/owner/repo/pull/123",
      });
      expect(createPullRequestMock).toHaveBeenCalledWith(
        "owner/repo",
        expect.stringMatching(/^revert-to-0123456-\d+$/),
        "main",
        expect.objectContaining({
          token: "private-token",
          title: "Restore main to 0123456",
        })
      );
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
