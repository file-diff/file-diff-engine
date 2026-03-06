import { Queue } from "bullmq";

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);

export const QUEUE_NAME = "repo-processing";

export function createQueue(): Queue {
  return new Queue(QUEUE_NAME, {
    connection: {
      host: REDIS_HOST,
      port: REDIS_PORT,
      maxRetriesPerRequest: null,
    },
  });
}
