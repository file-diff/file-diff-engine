import { EventEmitter } from "events";
import https from "https";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTask,
  createPullRequest,
  GitHubApiError,
  listOrganizationRepositories,
  parsePullRequestUrl,
} from "../services/githubApi";

interface MockGitHubResponse {
  statusCode: number;
  body: unknown;
}

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
          pushedAt: "2011-01-26T19:06:43Z",
          createdAt: "2011-01-26T19:01:12Z",
          updatedAt: "2011-01-26T19:14:43Z",
        },
      ],
    });
  });

  it("listOrganizationRepositories returns user repositories when the organization endpoint is not found", async () => {
    mockGitHubRequests((path, respond) => {
      if (
        path ===
        "/orgs/file-diff/repos?per_page=100&page=1&type=all&sort=full_name&direction=asc"
      ) {
        respond({
          statusCode: 404,
          body: { message: "Not Found" },
        });
        return;
      }

      expect(path).toBe(
        "/users/file-diff/repos?per_page=100&page=1&type=all&sort=full_name&direction=asc"
      );
      respond({
        statusCode: 200,
        body: [
          {
            name: "file-diff-engine",
            full_name: "file-diff/file-diff-engine",
            html_url: "https://github.com/file-diff/file-diff-engine",
            pushed_at: "2011-01-26T19:06:43Z",
            created_at: "2011-01-26T19:01:12Z",
            updated_at: "2011-01-26T19:14:43Z",
          },
        ],
      });
    });

    await expect(listOrganizationRepositories("file-diff")).resolves.toEqual({
      organization: "file-diff",
      repositories: [
        {
          name: "file-diff-engine",
          repo: "file-diff/file-diff-engine",
          repositoryUrl: "https://github.com/file-diff/file-diff-engine",
          pushedAt: "2011-01-26T19:06:43Z",
          createdAt: "2011-01-26T19:01:12Z",
          updatedAt: "2011-01-26T19:14:43Z",
        },
      ],
    });
  });

  it("listOrganizationRepositories starts both owner lookups before paging the successful result", async () => {
    const requestedPaths: string[] = [];

    mockGitHubRequests((path, respond) => {
      requestedPaths.push(path);

      if (
        path ===
        "/orgs/file-diff/repos?per_page=100&page=1&type=all&sort=full_name&direction=asc"
      ) {
        queueMicrotask(() => {
          expect(requestedPaths).toContain(
            "/users/file-diff/repos?per_page=100&page=1&type=all&sort=full_name&direction=asc"
          );
          respond({
            statusCode: 200,
            body: Array.from({ length: 100 }, (_, index) => ({
              name: `repo-${index + 1}`,
              full_name: `file-diff/repo-${index + 1}`,
              html_url: `https://github.com/file-diff/repo-${index + 1}`,
            })),
          });
        });
        return;
      }

      if (
        path ===
        "/orgs/file-diff/repos?per_page=100&page=2&type=all&sort=full_name&direction=asc"
      ) {
        respond({
          statusCode: 200,
          body: [
            {
              name: "repo-101",
              full_name: "file-diff/repo-101",
              html_url: "https://github.com/file-diff/repo-101",
            },
          ],
        });
        return;
      }

      expect(path).toBe(
        "/users/file-diff/repos?per_page=100&page=1&type=all&sort=full_name&direction=asc"
      );
      respond({
        statusCode: 404,
        body: { message: "Not Found" },
      });
    });

    const response = await listOrganizationRepositories("file-diff");

    expect(response.organization).toBe("file-diff");
    expect(response.repositories).toHaveLength(101);
    expect(response.repositories[0]).toMatchObject({
      name: "repo-1",
      repo: "file-diff/repo-1",
    });
    expect(response.repositories[100]).toMatchObject({
      name: "repo-101",
      repo: "file-diff/repo-101",
    });
  });

  it("listOrganizationRepositories returns a not found error when both owner lookups fail", async () => {
    mockGitHubRequests((path, respond) => {
      expect(path).toMatch(
        /^\/(?:orgs|users)\/missing-owner\/repos\?per_page=100&page=1&type=all&sort=full_name&direction=asc$/
      );
      respond({
        statusCode: 404,
        body: { message: "Not Found" },
      });
    });

    await expect(listOrganizationRepositories("missing-owner")).rejects.toMatchObject({
      message: "GitHub organization or user 'missing-owner' was not found.",
      statusCode: 404,
    });
  });

  it("createPullRequest posts the expected payload", async () => {
    mockGitHubRequests((path, respond, options) => {
      expect(path).toBe("/repos/file-diff/file-diff-engine/pulls");
      expect(options).toMatchObject({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer portal-token",
          "Content-Type": "application/json; charset=utf-8",
        }),
      });
      expect(JSON.parse(options.body ?? "{}")).toEqual({
        title: "Restore main to 0123456",
        head: "revert-to-0123456-1",
        base: "main",
        body: "Body",
      });
      respond({
        statusCode: 201,
        body: {
          number: 42,
          title: "Restore main to 0123456",
          html_url: "https://github.com/file-diff/file-diff-engine/pull/42",
        },
      });
    });

    await expect(
      createPullRequest("file-diff/file-diff-engine", "revert-to-0123456-1", "main", {
        title: "Restore main to 0123456",
        body: "Body",
        token: "portal-token",
      })
    ).resolves.toEqual({
      number: 42,
      title: "Restore main to 0123456",
      url: "https://github.com/file-diff/file-diff-engine/pull/42",
    });
  });

  it("createTask logs GitHub 404 details before returning the sanitized not-found error", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    mockGitHubRequests((path, respond, options) => {
      expect(path).toBe("/repos/file-diff/file-diff-frontend/copilot/tasks");
      expect(options).toMatchObject({
        method: "POST",
      });
      respond({
        statusCode: 404,
        body: {
          message: "Not Found",
          documentation_url: "https://docs.github.com/rest",
        },
      });
    });

    await expect(
      createTask(
        "file-diff",
        "file-diff-frontend",
        {
          event_content: "Fix the repo lookup",
          create_pull_request: true,
        },
        "portal-token"
      )
    ).rejects.toMatchObject({
      message: "GitHub repository 'file-diff/file-diff-frontend' was not found.",
      statusCode: 404,
    });

    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("[github-api] GitHub API returned 404"),
      expect.objectContaining({
        method: "POST",
        path: "/repos/file-diff/file-diff-frontend/copilot/tasks",
        responseMessage: "Not Found",
        documentationUrl: "https://docs.github.com/rest",
      })
    );
  });
});

function mockGitHubRequests(
  handleRequest: (
    path: string,
    respond: (response: MockGitHubResponse) => void,
    options: { method?: string; headers?: unknown; body?: string }
  ) => void
): void {
  vi.spyOn(https, "request").mockImplementation((options, callback) => {
    const response = new EventEmitter() as EventEmitter & { statusCode?: number };
    let body = "";
    const request = new EventEmitter() as EventEmitter & {
      end: () => void;
      write: (chunk: string | Buffer) => void;
    };

    request.write = (chunk) => {
      body += chunk.toString();
    };

    request.end = () => {
      const path = typeof options === "string" ? options : options.path;
      if (typeof path !== "string") {
        throw new Error("Expected GitHub API request path.");
      }

      handleRequest(
        path,
        ({ statusCode, body: responseBody }) => {
          response.statusCode = statusCode;
          (response as EventEmitter & {
            statusCode?: number;
            headers?: Record<string, string>;
          }).headers = {
            "x-github-request-id": "request-id-123",
            "x-accepted-github-permissions": "contents=read",
            "x-oauth-scopes": "repo",
            "x-ratelimit-remaining": "4999",
          };
          callback?.(response as never);
          response.emit("data", JSON.stringify(responseBody));
          response.emit("end");
        },
        {
          method: typeof options === "string" ? undefined : options.method,
          headers: typeof options === "string" ? undefined : options.headers,
          body,
        }
      );
    };

    return request as never;
  });
}
