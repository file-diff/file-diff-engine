import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { getCodexUsageStatsText } from "../services/codexUsageStats";
import type { ErrorResponse } from "../types";
import { createLogger } from "../utils/logger";
import { requireViewerBearerToken } from "./jobs/shared";

const CODEX_USAGE_STATS_RATE_LIMIT_MAX = 30;
const CODEX_USAGE_STATS_RATE_LIMIT_WINDOW_MS = 60_000;

const logger = createLogger("codex-usage-stats-routes");

export function registerCodexUsageStatsRoutes(app: FastifyInstance): void {
  app.get(
    "/api/codex/stats",
    {
      preHandler: [
        requireViewerBearerToken,
        app.rateLimit({
          max: CODEX_USAGE_STATS_RATE_LIMIT_MAX,
          timeWindow: CODEX_USAGE_STATS_RATE_LIMIT_WINDOW_MS,
        }),
      ],
    },
    async (_request, reply) => {
      logger.info("Received codex usage stats request");

      try {
        const statsText = await getCodexUsageStatsText();
        reply.header("Content-Type", "text/plain; charset=utf-8");
        return reply.code(200).send(statsText);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unable to get Codex usage statistics.";
        const response: ErrorResponse = { error: message };
        return reply.code(500).send(response);
      }
    }
  );
}
