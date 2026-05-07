import { createApp } from "./app";
import { createWorker, recoverOrphanedWaitingJobs } from "./workers/repoWorker";
import { createLogger } from "./utils/logger";

const PORT = parseInt(process.env.PORT || "12986", 10);
const HOST = process.env.HOST || process.env.ADDR || "0.0.0.0";
const logger = createLogger("server");

async function main() {
  const { app, queue, db } = await createApp();
  const worker = await createWorker(db);

  queue.on("error", (error) => {
    logger.error("Queue connection error", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  try {
    const recovered = await recoverOrphanedWaitingJobs(db, queue);
    if (recovered > 0) {
      logger.warn(`Recovered ${recovered} orphaned waiting job(s) on startup.`);
    }
  } catch (error) {
    logger.error("Failed to recover orphaned waiting jobs on startup", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await app.listen({ port: PORT, host: HOST });
  logger.info(`File-diff-engine API listening on ${HOST}:${PORT}`);
  logger.info("Worker connected to Redis, processing queue…");

  async function shutdown() {
    logger.info("Shutting down…");
    await app.close();
    await worker.close();
    await queue.close();
    await db.end();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error: unknown) => {
  logger.error("Failed to start server", { error });
  process.exit(1);
});
