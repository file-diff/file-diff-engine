import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import https from "https";
import { getGitHubRateLimit } from "../services/githubApi";

function mockRateLimitRequest() {
  let capturedOptions: Record<string, unknown> | undefined;

  const requestSpy = vi
    .spyOn(https, "request")
    .mockImplementation((options: Record<string, unknown>, callback: (response: EventEmitter) => void) => {
      capturedOptions = options;

      const response = new EventEmitter();
      Object.assign(response, {
        statusCode: 200,
        headers: {},
      });

      const request = new EventEmitter();
      Object.assign(request, {
        write: vi.fn(),
        end: vi.fn(() => {
          callback(response);
          response.emit(
            "data",
            JSON.stringify({
              rate: {
                limit: 5000,
                remaining: 4999,
                reset: 1_712_345_679,
                used: 1,
                resource: "core",
              },
            })
          );
          response.emit("end");
        }),
      });

      return request as unknown as ReturnType<typeof https.request>;
    });

  return {
    requestSpy,
    getCapturedOptions: () => capturedOptions,
  };
}

describe("getGitHubRateLimit", () => {
  const originalPrivateGitHubToken = process.env.PRIVATE_GITHUB_TOKEN;
  const originalPublicGitHubToken = process.env.PUBLIC_GITHUB_TOKEN;

  afterEach(() => {
    vi.restoreAllMocks();

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

  it("uses PRIVATE_GITHUB_TOKEN for the rate limit request when available", async () => {
    process.env.PRIVATE_GITHUB_TOKEN = " private-token ";
    process.env.PUBLIC_GITHUB_TOKEN = " public-token ";
    const { getCapturedOptions } = mockRateLimitRequest();

    await expect(getGitHubRateLimit()).resolves.toMatchObject({
      limit: 5000,
      remaining: 4999,
      reset: 1_712_345_679,
      used: 1,
      resource: "core",
    });

    expect(getCapturedOptions()).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer private-token",
      }),
    });
  });

  it("does not fall back to PUBLIC_GITHUB_TOKEN for the rate limit request", async () => {
    delete process.env.PRIVATE_GITHUB_TOKEN;
    process.env.PUBLIC_GITHUB_TOKEN = " public-token ";
    const { getCapturedOptions } = mockRateLimitRequest();

    await expect(getGitHubRateLimit()).resolves.toMatchObject({
      limit: 5000,
      remaining: 4999,
      reset: 1_712_345_679,
      used: 1,
      resource: "core",
    });

    expect(getCapturedOptions()).toMatchObject({
      headers: expect.not.objectContaining({
        Authorization: expect.any(String),
      }),
    });
  });
});
