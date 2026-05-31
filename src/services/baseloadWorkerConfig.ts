import Redis from "ioredis";
import { QUEUE_NAMES, type QueueKind } from "./queue";
import { createLogger } from "../utils/logger";

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);

export const BASELOAD_WORKERS_CONFIG_VERSION = 1;
export const BASELOAD_WORKERS_CONFIG_REDIS_KEY =
  "file-diff-engine:baseload-workers-config";
export const DEFAULT_BASELOAD_WORKER_CONCURRENCY = 5;

const logger = createLogger("baseload-worker-config");
const QUEUE_KINDS = Object.keys(QUEUE_NAMES) as QueueKind[];

export interface BaseloadWorkerQueueConfig {
  concurrency: number;
}

export interface BaseloadWorkersConfig {
  version: typeof BASELOAD_WORKERS_CONFIG_VERSION;
  workers: Record<QueueKind, BaseloadWorkerQueueConfig>;
}

export interface BaseloadWorkersConfigStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  quit?(): Promise<unknown>;
  disconnect?(): void;
}

export interface LoadBaseloadWorkersConfigResult {
  config: BaseloadWorkersConfig;
  source: "redis" | "default";
}

export const DEFAULT_BASELOAD_WORKERS_CONFIG: BaseloadWorkersConfig = {
  version: BASELOAD_WORKERS_CONFIG_VERSION,
  workers: {
    repo: { concurrency: DEFAULT_BASELOAD_WORKER_CONCURRENCY },
    opencode: { concurrency: DEFAULT_BASELOAD_WORKER_CONCURRENCY },
    codex: { concurrency: DEFAULT_BASELOAD_WORKER_CONCURRENCY },
    claude: { concurrency: DEFAULT_BASELOAD_WORKER_CONCURRENCY },
  },
};

export function cloneBaseloadWorkersConfig(
  config: BaseloadWorkersConfig
): BaseloadWorkersConfig {
  return {
    version: config.version,
    workers: {
      repo: { ...config.workers.repo },
      opencode: { ...config.workers.opencode },
      codex: { ...config.workers.codex },
      claude: { ...config.workers.claude },
    },
  };
}

export function parseBaseloadWorkersConfig(
  rawConfig: string | null
): BaseloadWorkersConfig | null {
  if (!rawConfig) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || parsed.version !== BASELOAD_WORKERS_CONFIG_VERSION) {
    return null;
  }

  if (!isRecord(parsed.workers)) {
    return null;
  }

  const workers = {} as Record<QueueKind, BaseloadWorkerQueueConfig>;
  for (const kind of QUEUE_KINDS) {
    const workerConfig = parsed.workers[kind];
    if (!isRecord(workerConfig)) {
      return null;
    }

    const concurrency = workerConfig.concurrency;
    if (
      typeof concurrency !== "number" ||
      !Number.isInteger(concurrency) ||
      concurrency < 1
    ) {
      return null;
    }

    workers[kind] = { concurrency };
  }

  return {
    version: BASELOAD_WORKERS_CONFIG_VERSION,
    workers,
  };
}

export async function saveBaseloadWorkersConfig(
  store: BaseloadWorkersConfigStore,
  config: BaseloadWorkersConfig = DEFAULT_BASELOAD_WORKERS_CONFIG
): Promise<void> {
  await store.set(
    BASELOAD_WORKERS_CONFIG_REDIS_KEY,
    JSON.stringify(cloneBaseloadWorkersConfig(config))
  );
}

export async function loadBaseloadWorkersConfig(
  store: BaseloadWorkersConfigStore
): Promise<LoadBaseloadWorkersConfigResult> {
  const storedConfig = parseBaseloadWorkersConfig(
    await store.get(BASELOAD_WORKERS_CONFIG_REDIS_KEY)
  );

  if (storedConfig) {
    return { config: storedConfig, source: "redis" };
  }

  const defaultConfig = cloneBaseloadWorkersConfig(
    DEFAULT_BASELOAD_WORKERS_CONFIG
  );
  await saveBaseloadWorkersConfig(store, defaultConfig);
  return { config: defaultConfig, source: "default" };
}

export async function loadBaseloadWorkersConfigFromRedis(): Promise<LoadBaseloadWorkersConfigResult> {
  const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });

  try {
    await redis.connect();
    return await loadBaseloadWorkersConfig(redis);
  } catch (error) {
    logger.warn(
      "Failed to load baseload workers config from Redis; using defaults.",
      {
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return {
      config: cloneBaseloadWorkersConfig(DEFAULT_BASELOAD_WORKERS_CONFIG),
      source: "default",
    };
  } finally {
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
