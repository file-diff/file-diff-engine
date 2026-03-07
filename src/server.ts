import { createApp } from "./app";
import { createWorker } from "./workers/repoWorker";
import { createLogger } from "./utils/logger";

const PORT = parseInt(process.env.PORT || "12986", 10);
const logger = createLogger("server");

async function main() {
  const { app, queue, db } = await createApp();
  const worker = await createWorker();

  app.listen(PORT, () => {
    logger.info(`File-diff-engine API listening on port ${PORT}`);
    logger.info("Worker connected to Redis, processing queue…");
  });

  async function shutdown() {
    logger.info("Shutting down…");
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
