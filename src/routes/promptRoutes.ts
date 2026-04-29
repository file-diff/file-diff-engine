import type { FastifyInstance } from "fastify";
import type { ShortenPromptRequest, ShortenPromptResponse } from "../types";
import { generatePromptTitle } from "../services/promptTitle";
import { requireViewerBearerToken } from "./jobs/shared";

export function registerPromptRoutes(app: FastifyInstance): void {
  app.post<{ Body: ShortenPromptRequest }>(
    "/api/shorten-prompt",
    { preHandler: requireViewerBearerToken },
    async (request) => {
      const response: ShortenPromptResponse = {
        title: await generatePromptTitle(request.body?.prompt),
      };

      return response;
    }
  );
}
