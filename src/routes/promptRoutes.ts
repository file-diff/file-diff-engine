import type { FastifyInstance } from "fastify";
import type { ShortenPromptRequest, ShortenPromptResponse } from "../types";
import { generatePromptTitle } from "../services/promptTitle";
import { requireViewerBearerToken } from "./jobs/shared";
import { createLogger } from "../utils/logger";

const logger = createLogger("prompt-routes");

export function registerPromptRoutes(app: FastifyInstance): void {
  app.post<{ Body: ShortenPromptRequest }>(
    "/api/shorten-prompt",
    { preHandler: requireViewerBearerToken },
    async (request) => {
      const prompt = request.body?.prompt;
      const safePromptPreview = typeof prompt === "string" ? prompt.slice(0, 80) : null;

      logger.info("Received shorten-prompt request", {
        endpoint: "/api/shorten-prompt",
        promptType: typeof prompt,
        promptLength: typeof prompt === "string" ? prompt.length : 0,
        promptPreview: safePromptPreview,
      });

      const promptTitleResult = await generatePromptTitle(prompt);
      const response: ShortenPromptResponse = promptTitleResult;

      logger.info("Completed shorten-prompt request", {
        endpoint: "/api/shorten-prompt",
        title: response.title,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        durationMs: response.durationMs,
      });

      return response;
    }
  );
}
