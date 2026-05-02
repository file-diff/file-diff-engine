import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerClaudeUsageStatsRoutes } from "./claudeUsageStatsRoutes";
import { getClaudeUsageStatsText } from "../services/claudeUsageStats";

vi.mock("../services/claudeUsageStats", () => ({
  getClaudeUsageStatsText: vi.fn(),
}));

describe("registerClaudeUsageStatsRoutes", () => {
  const originalViewerBearerToken = process.env.VIEWER_BEARER_TOKEN;

  beforeEach(() => {
    process.env.VIEWER_BEARER_TOKEN = "viewer-token";
    vi.mocked(getClaudeUsageStatsText).mockReset();
  });

  afterEach(() => {
    process.env.VIEWER_BEARER_TOKEN = originalViewerBearerToken;
    vi.restoreAllMocks();
  });

  it("returns the Claude usage statistics text", async () => {
    const app = Fastify();
    vi.mocked(getClaudeUsageStatsText).mockResolvedValue(
      "Claude usage\nInput: 11\nOutput: 22\n"
    );

    try {
      await app.register(rateLimit, { global: false });
      registerClaudeUsageStatsRoutes(app);

      const response = await app.inject({
        method: "GET",
        url: "/api/claude/stats",
        headers: {
          authorization: "Bearer viewer-token",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/plain");
      expect(response.body).toBe("Claude usage\nInput: 11\nOutput: 22\n");
    } finally {
      await app.close();
    }
  });

  it("rejects requests without a bearer token", async () => {
    const app = Fastify();

    try {
      await app.register(rateLimit, { global: false });
      registerClaudeUsageStatsRoutes(app);

      const response = await app.inject({
        method: "GET",
        url: "/api/claude/stats",
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "Bearer token is required." });
      expect(getClaudeUsageStatsText).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns a JSON error when the usage command fails", async () => {
    const app = Fastify();
    vi.mocked(getClaudeUsageStatsText).mockRejectedValue(
      new Error("ccusage failed")
    );

    try {
      await app.register(rateLimit, { global: false });
      registerClaudeUsageStatsRoutes(app);

      const response = await app.inject({
        method: "GET",
        url: "/api/claude/stats",
        headers: {
          authorization: "Bearer viewer-token",
        },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "ccusage failed" });
    } finally {
      await app.close();
    }
  });
});
