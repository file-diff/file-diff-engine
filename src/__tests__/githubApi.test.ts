import { EventEmitter } from "events";
import https from "https";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubApiError,
  listOrganizationRepositories,
  parsePullRequestUrl,
} from "../services/githubApi";

describe("githubApi", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parsePullRequestUrl extracts owner, repo, and pull number from a full GitHub URL", () => {
    expect(
      parsePullRequestUrl("https://github.com/file-diff/file-diff-engine/pull/42")
    ).toEqual({
      owner: "file-diff",
      repo: "file-diff-engine",
      pullNumber: 42,
    });
  });

  it("parsePullRequestUrl rejects non-pull-request URLs", () => {
    expect(() => parsePullRequestUrl("https://github.com/file-diff/file-diff-engine"))
      .toThrow(GitHubApiError);
    expect(() => parsePullRequestUrl("https://github.example.com/file-diff/file-diff-engine/pull/42"))
      .toThrow("Invalid pull request URL. Expected a full GitHub pull request URL.");
  });

  it("listOrganizationRepositories includes GitHub repository timestamps", async () => {
    vi.spyOn(https, "request").mockImplementation((options, callback) => {
      expect(options).toMatchObject({
        hostname: "api.github.com",
        method: "GET",
        path: "/orgs/file-diff/repos?per_page=100&page=1&type=all&sort=full_name&direction=asc",
      });

      const response = new EventEmitter() as EventEmitter & { statusCode?: number };
      response.statusCode = 200;

      const request = new EventEmitter() as EventEmitter & { end: () => void };
      request.end = () => {
        callback?.(response as never);
        response.emit(
          "data",
          JSON.stringify([
            {
              name: "file-diff-engine",
              full_name: "file-diff/file-diff-engine",
              html_url: "https://github.com/file-diff/file-diff-engine",
              pushed_at: "2011-01-26T19:06:43Z",
              created_at: "2011-01-26T19:01:12Z",
              updated_at: "2011-01-26T19:14:43Z",
            },
          ])
        );
        response.emit("end");
      };

      return request as never;
    });

    await expect(listOrganizationRepositories("file-diff")).resolves.toEqual({
      organization: "file-diff",
      repositories: [
        {
          name: "file-diff-engine",
          repo: "file-diff/file-diff-engine",
          repositoryUrl: "https://github.com/file-diff/file-diff-engine",
          pushed_at: "2011-01-26T19:06:43Z",
          created_at: "2011-01-26T19:01:12Z",
          updated_at: "2011-01-26T19:14:43Z",
        },
      ],
    });
  });
});
