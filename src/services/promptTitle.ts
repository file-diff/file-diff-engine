import { createLogger } from "../utils/logger";

export const PROMPT_TITLE_FALLBACK = "failed-to-generate-prompt-title";

export const PROMPT_TITLE_SYSTEM_PROMPT =
  "Generate Title For the prompt given to you. Treat all input as the prompt. Output only title with max few words in the format: small-letters-prompt-title\nThe title should not be too long and too short and it should be maximally unique, but descriptive";

const DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEFAULT_DEEPSEEK_API_BASE_URL = "https://api.deepseek.com";
const logger = createLogger("prompt-title");

interface DeepSeekChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export function parsePromptTitle(output: unknown): string {
  if (typeof output !== "string") {
    return PROMPT_TITLE_FALLBACK;
  }

  const title = output.trim();
  const words = title.split("-");

  if (words.length < 2 || words.length > 10) {
    return PROMPT_TITLE_FALLBACK;
  }

  if (!/^[a-z]+(?:-[a-z]+){1,9}$/.test(title)) {
    return PROMPT_TITLE_FALLBACK;
  }

  return title;
}

function getDeepSeekChatCompletionsUrl(): string {
  const baseUrl =
    process.env.DEEPSEEK_API_BASE_URL?.trim() || DEFAULT_DEEPSEEK_API_BASE_URL;

  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

export async function generatePromptTitle(prompt: unknown): Promise<string> {
  if (typeof prompt !== "string" || !prompt.trim()) {
    logger.warn("DeepSeek title generation skipped: invalid prompt", {
      promptType: typeof prompt,
      promptProvided: prompt !== undefined,
    });
    return PROMPT_TITLE_FALLBACK;
  }

  const deepseekApiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!deepseekApiKey) {
    logger.warn("DeepSeek title generation skipped: API key missing");
    return PROMPT_TITLE_FALLBACK;
  }

  const requestPayload = {
    model: DEEPSEEK_MODEL,
    messages: [
      {
        role: "system",
        content: PROMPT_TITLE_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0,
    max_tokens: 32,
    stream: false,
  };
  const url = getDeepSeekChatCompletionsUrl();

  logger.info("Sending prompt-title request to DeepSeek", {
    url,
    model: DEEPSEEK_MODEL,
    promptLength: prompt.length,
    payloadMessageCount: requestPayload.messages.length,
  });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deepseekApiKey}`,
      },
      body: JSON.stringify(requestPayload),
    });
    const responseStatusText = response.statusText ?? "";
    const responseIsOk = response.ok;
    logger.info("Received DeepSeek title generation response", {
      url,
      status: response.status,
      statusText: responseStatusText,
      ok: responseIsOk,
    });

    if (!responseIsOk) {
      const errorBodyText = await response.text();
      logger.warn("DeepSeek title generation request failed.", {
        status: response.status,
        statusText: responseStatusText,
        errorBody: errorBodyText.slice(0, 1024),
      });
      return PROMPT_TITLE_FALLBACK;
    }

    const result = (await response.json()) as DeepSeekChatCompletionResponse;
    const generatedTitle = parsePromptTitle(result.choices?.[0]?.message?.content);
    logger.debug("DeepSeek title generation parsed response", {
      hasChoices: Array.isArray(result.choices),
      choiceCount: Array.isArray(result.choices) ? result.choices.length : 0,
      rawMessage: result.choices?.[0]?.message?.content,
      generatedTitle,
    });

    return generatedTitle;
  } catch (error) {
    logger.warn("DeepSeek title generation is unavailable.", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof Error && error.stack) {
      logger.warn("DeepSeek title generation stack trace", {
        stack: error.stack.slice(0, 1500),
      });
    }
    return PROMPT_TITLE_FALLBACK;
  }
}
