import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCodexUsageStatsRoutes } from "./codexUsageStatsRoutes";
import { getCodexUsageStatsText } from "../services/codexUsageStats";

vi.mock("../services/codexUsageStats", () => ({
  getCodexUsageStatsText: vi.fn(),
}));

describe("registerCodexUsageStatsRoutes", () => {
  const originalViewerBearerToken = process.env.VIEWER_BEARER_TOKEN;

  beforeEach(() => {
    process.env.VIEWER_BEARER_TOKEN = "viewer-token";
    vi.mocked(getCodexUsageStatsText).mockReset();
  });

  afterEach(() => {
    process.env.VIEWER_BEARER_TOKEN = originalViewerBearerToken;
    vi.restoreAllMocks();
  });

  it("returns the Codex usage statistics text", async () => {
    const app = Fastify();
    vi.mocked(getCodexUsageStatsText).mockResolvedValue(
      "Codex usage\nInput: 10\nOutput: 20\n"
    );

    try {
      await app.register(rateLimit, { global: false });
      registerCodexUsageStatsRoutes(app);

      const response = await app.inject({
        method: "GET",
        url: "/api/codex/stats",
        headers: {
          authorization: "Bearer viewer-token",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/plain");
      expect(response.body).toBe("Codex usage\nInput: 10\nOutput: 20\n");
    } finally {
      await app.close();
    }
  });

  it("rejects requests without a bearer token", async () => {
    const app = Fastify();

    try {
      await app.register(rateLimit, { global: false });
      registerCodexUsageStatsRoutes(app);

      const response = await app.inject({
        method: "GET",
        url: "/api/codex/stats",
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "Bearer token is required." });
      expect(getCodexUsageStatsText).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns a JSON error when the usage command fails", async () => {
    const app = Fastify();
    vi.mocked(getCodexUsageStatsText).mockRejectedValue(
      new Error("ccusage failed")
    );

    try {
      await app.register(rateLimit, { global: false });
      registerCodexUsageStatsRoutes(app);

      const response = await app.inject({
        method: "GET",
        url: "/api/codex/stats",
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
