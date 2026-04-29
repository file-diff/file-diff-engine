import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROMPT_TITLE_FALLBACK } from "../services/promptTitle";
import { registerPromptRoutes } from "./promptRoutes";

describe("registerPromptRoutes", () => {
  const originalViewerBearerToken = process.env.VIEWER_BEARER_TOKEN;
  const originalDeepSeekApiKey = process.env.DEEPSEEK_API_KEY;

  beforeEach(() => {
    process.env.VIEWER_BEARER_TOKEN = "viewer-token";
    process.env.DEEPSEEK_API_KEY = "deepseek-token";
  });

  afterEach(() => {
    process.env.VIEWER_BEARER_TOKEN = originalViewerBearerToken;
    process.env.DEEPSEEK_API_KEY = originalDeepSeekApiKey;
    vi.unstubAllGlobals();
  });

  it("returns a shortened prompt title", async () => {
    const app = Fastify();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          choices: [{ message: { content: "shorten-prompt-title" } }],
          usage: {
            prompt_tokens: 74,
            completion_tokens: 235,
          },
        }),
      })
    );

    try {
      registerPromptRoutes(app);

      const response = await app.inject({
        method: "POST",
        url: "/api/shorten-prompt",
        headers: {
          authorization: "Bearer viewer-token",
        },
        payload: {
          prompt: "Create an endpoint that shortens a long prompt into a concise title",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          title: "shorten-prompt-title",
          inputTokens: 74,
          outputTokens: 235,
        })
      );
      expect(response.json().durationMs).toEqual(expect.any(Number));
    } finally {
      await app.close();
    }
  });

  it("always succeeds with the fallback title when generation fails", async () => {
    const app = Fastify();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    try {
      registerPromptRoutes(app);

      const response = await app.inject({
        method: "POST",
        url: "/api/shorten-prompt",
        headers: {
          authorization: "Bearer viewer-token",
        },
        payload: {
          prompt: "Create an endpoint that shortens a long prompt into a concise title",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          title: PROMPT_TITLE_FALLBACK,
          inputTokens: 0,
          outputTokens: 0,
        })
      );
      expect(response.json().durationMs).toEqual(expect.any(Number));
    } finally {
      await app.close();
    }
  });
});
