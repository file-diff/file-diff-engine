import { EventEmitter } from "events";
import https from "https";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getGitHubAuthenticatedAccount,
  getGitHubRateLimit,
  listTags,
} from "./githubApi";

interface MockGitHubResponse {
  statusCode: number;
  body: unknown;
  headers?: Record<string, string>;
}

function mockGitHubResponses(...responses: MockGitHubResponse[]) {
  const capturedRequests: Array<{
    path?: string;
    headers?: Record<string, string>;
  }> = [];

  vi.spyOn(https, "request").mockImplementation(
    ((
      options: { path?: string; headers?: Record<string, string> },
      callback: (response: EventEmitter) => void
    ) => {
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected GitHub request.");
      }

      capturedRequests.push({
        path: options.path,
        headers: options.headers,
      });

      const responseEmitter = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
      };
      responseEmitter.statusCode = response.statusCode;
      responseEmitter.headers = response.headers ?? {};

      const requestEmitter = new EventEmitter() as EventEmitter & {
        write: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
      };
      requestEmitter.write = vi.fn();
      requestEmitter.end = vi.fn(() => {
        callback(responseEmitter);
        responseEmitter.emit("data", Buffer.from(JSON.stringify(response.body)));
        responseEmitter.emit("end");
      });

      return requestEmitter;
    }) as typeof https.request
  );

  return { capturedRequests };
}

describe("githubApi", () => {
  const originalPrivateGitHubToken = process.env.PRIVATE_GITHUB_TOKEN;

  afterEach(() => {
    process.env.PRIVATE_GITHUB_TOKEN = originalPrivateGitHubToken;
    vi.restoreAllMocks();
  });

  it("returns the primary and per-resource GitHub rate limits", async () => {
    const { capturedRequests } = mockGitHubResponses({
      statusCode: 200,
      body: {
        rate: {
          limit: 5000,
          remaining: 4975,
          reset: 1712345679,
          used: 25,
        },
        resources: {
          core: {
            limit: 5000,
            remaining: 4975,
            reset: 1712345679,
            used: 25,
          },
          search: {
            limit: 30,
            remaining: 30,
            reset: 1712345679,
            used: 0,
          },
          invalid: {
            limit: "bad",
          },
        },
      },
    });

    await expect(getGitHubRateLimit("backend-token")).resolves.toEqual({
      limit: 5000,
      remaining: 4975,
      reset: 1712345679,
      used: 25,
      resource: "core",
      resources: {
        core: {
          limit: 5000,
          remaining: 4975,
          reset: 1712345679,
          used: 25,
          resource: "core",
        },
        search: {
          limit: 30,
          remaining: 30,
          reset: 1712345679,
          used: 0,
          resource: "search",
        },
      },
    });
    expect(capturedRequests[0]).toEqual(
      expect.objectContaining({
        path: "/rate_limit",
        headers: expect.objectContaining({
          Authorization: "Bearer backend-token",
        }),
      })
    );
  });

  it("does not fall back to PRIVATE_GITHUB_TOKEN when rate limit receives a null token", async () => {
    process.env.PRIVATE_GITHUB_TOKEN = "env-token";
    const { capturedRequests } = mockGitHubResponses({
      statusCode: 200,
      body: {
        rate: {
          limit: 60,
          remaining: 59,
          reset: 1712345679,
          used: 1,
        },
      },
    });

    await getGitHubRateLimit(null);

    expect(capturedRequests[0]?.headers).not.toHaveProperty("Authorization");
  });

  it("lists tags with the explicit backend GitHub token", async () => {
    process.env.PRIVATE_GITHUB_TOKEN = "different-env-token";
    const { capturedRequests } = mockGitHubResponses({
      statusCode: 200,
      body: [
        {
          name: "v1.2.3",
          commit: {
            sha: "0123456789abcdef0123456789abcdef01234567",
          },
        },
      ],
    });

    await expect(listTags("file-diff/file-diff-engine", 1, "backend-token")).resolves.toEqual([
      {
        name: "v1.2.3",
        ref: "refs/tags/v1.2.3",
        commit: "0123456789abcdef0123456789abcdef01234567",
        commitShort: "0123456",
      },
    ]);
    expect(capturedRequests[0]).toEqual(
      expect.objectContaining({
        path: "/repos/file-diff/file-diff-engine/tags?per_page=1&page=1",
        headers: expect.objectContaining({
          Authorization: "Bearer backend-token",
        }),
      })
    );
  });

  it("returns the authenticated GitHub account for the configured token", async () => {
    const { capturedRequests } = mockGitHubResponses({
      statusCode: 200,
      body: {
        login: "octocat",
        id: 1,
        type: "User",
      },
    });

    await expect(getGitHubAuthenticatedAccount("backend-token")).resolves.toEqual({
      login: "octocat",
      id: 1,
      type: "User",
    });
    expect(capturedRequests[0]).toEqual(
      expect.objectContaining({
        path: "/user",
        headers: expect.objectContaining({
          Authorization: "Bearer backend-token",
        }),
      })
    );
  });
});
