import { createApp } from "./app";
import { createWorker } from "./workers/repoWorker";

const PORT = parseInt(process.env.PORT || "12986", 10);

const { app, queue } = createApp();
const worker = createWorker();

app.listen(PORT, () => {
  console.log(`File-diff-engine API listening on port ${PORT}`);
  console.log(`Worker connected to Redis, processing queue…`);
});

async function shutdown() {
  console.log("Shutting down…");
  await worker.close();
  await queue.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
