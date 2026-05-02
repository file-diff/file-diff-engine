import type { FastifyInstance } from "fastify";
import { getClaudeUsageStatsText } from "../services/claudeUsageStats";
import type { ErrorResponse } from "../types";
import { createLogger } from "../utils/logger";
import { requireViewerBearerToken } from "./jobs/shared";

const CLAUDE_USAGE_STATS_RATE_LIMIT_MAX = 30;
const CLAUDE_USAGE_STATS_RATE_LIMIT_WINDOW_MS = 60_000;

const logger = createLogger("claude-usage-stats-routes");

export function registerClaudeUsageStatsRoutes(app: FastifyInstance): void {
  app.get(
    "/api/claude/stats",
    {
      preHandler: [
        requireViewerBearerToken,
        app.rateLimit({
          max: CLAUDE_USAGE_STATS_RATE_LIMIT_MAX,
          timeWindow: CLAUDE_USAGE_STATS_RATE_LIMIT_WINDOW_MS,
        }),
      ],
    },
    async (_request, reply) => {
      logger.info("Received claude usage stats request");

      try {
        const statsText = await getClaudeUsageStatsText();
        reply.header("Content-Type", "text/plain; charset=utf-8");
        return reply.code(200).send(statsText);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unable to get Claude usage statistics.";
        const response: ErrorResponse = { error: message };
        return reply.code(500).send(response);
      }
    }
  );
}
