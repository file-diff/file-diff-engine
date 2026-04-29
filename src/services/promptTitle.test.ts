import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generatePromptTitle,
  parsePromptTitle,
  PROMPT_TITLE_FALLBACK,
  PROMPT_TITLE_SYSTEM_PROMPT,
} from "./promptTitle";

describe("prompt title generation", () => {
  const originalDeepSeekApiKey = process.env.DEEPSEEK_API_KEY;
  const originalDeepSeekApiBaseUrl = process.env.DEEPSEEK_API_BASE_URL;

  afterEach(() => {
    process.env.DEEPSEEK_API_KEY = originalDeepSeekApiKey;
    process.env.DEEPSEEK_API_BASE_URL = originalDeepSeekApiBaseUrl;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("accepts lowercase hyphenated titles with two to ten words", () => {
    expect(parsePromptTitle("fix-login-flow")).toBe("fix-login-flow");
    expect(parsePromptTitle("  summarize-billing-invoice-export  ")).toBe(
      "summarize-billing-invoice-export"
    );
  });

  it("rejects generated titles outside the required format", () => {
    expect(parsePromptTitle("single")).toBe(PROMPT_TITLE_FALLBACK);
    expect(parsePromptTitle("Fix Login Flow")).toBe(PROMPT_TITLE_FALLBACK);
    expect(parsePromptTitle("fix_login_flow")).toBe(PROMPT_TITLE_FALLBACK);
    expect(parsePromptTitle("fix-login-flow-123")).toBe(PROMPT_TITLE_FALLBACK);
    expect(parsePromptTitle("one-two-three-four-five-six-seven-eight-nine-ten-eleven")).toBe(
      PROMPT_TITLE_FALLBACK
    );
  });

  it("calls DeepSeek v4 flash and parses the model output", async () => {
    process.env.DEEPSEEK_API_KEY = "deepseek-token";
    process.env.DEEPSEEK_API_BASE_URL = "https://deepseek.test/v1/";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "implement-short-title" } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(generatePromptTitle("Build the prompt title endpoint")).resolves.toBe(
      "implement-short-title"
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://deepseek.test/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer deepseek-token",
        },
        body: expect.any(String),
      })
    );

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };

    expect(requestBody.model).toBe("deepseek-v4-flash");
    expect(requestBody.messages).toEqual([
      { role: "system", content: PROMPT_TITLE_SYSTEM_PROMPT },
      { role: "user", content: "Build the prompt title endpoint" },
    ]);
  });

  it("returns the fallback title when DeepSeek is unavailable", async () => {
    process.env.DEEPSEEK_API_KEY = "deepseek-token";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(generatePromptTitle("Build the prompt title endpoint")).resolves.toBe(
      PROMPT_TITLE_FALLBACK
    );
  });

  it("returns the fallback title when DeepSeek is not configured", async () => {
    process.env.DEEPSEEK_API_KEY = "";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(generatePromptTitle("Build the prompt title endpoint")).resolves.toBe(
      PROMPT_TITLE_FALLBACK
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
