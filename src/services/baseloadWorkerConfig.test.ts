import { describe, expect, it, vi } from "vitest";
import {
  BASELOAD_WORKERS_CONFIG_REDIS_KEY,
  BASELOAD_WORKERS_CONFIG_VERSION,
  DEFAULT_BASELOAD_WORKERS_CONFIG,
  loadBaseloadWorkersConfig,
  parseBaseloadWorkersConfig,
  saveBaseloadWorkersConfig,
  type BaseloadWorkersConfigStore,
} from "./baseloadWorkerConfig";

function createStore(initialValue?: string | null): BaseloadWorkersConfigStore {
  let value = initialValue ?? null;

  return {
    get: vi.fn().mockImplementation(async () => value),
    set: vi.fn().mockImplementation(async (_key: string, nextValue: string) => {
      value = nextValue;
    }),
  };
}

describe("baseload worker config", () => {
  it("loads a valid versioned config from Redis", async () => {
    const config = {
      version: BASELOAD_WORKERS_CONFIG_VERSION,
      workers: {
        repo: { concurrency: 2 },
        opencode: { concurrency: 3 },
        codex: { concurrency: 4 },
        claude: { concurrency: 5 },
      },
    };
    const store = createStore(JSON.stringify(config));

    const result = await loadBaseloadWorkersConfig(store);

    expect(result).toEqual({ config, source: "redis" });
    expect(store.set).not.toHaveBeenCalled();
  });

  it("saves the default config when Redis has no value", async () => {
    const store = createStore();

    const result = await loadBaseloadWorkersConfig(store);

    expect(result).toEqual({
      config: DEFAULT_BASELOAD_WORKERS_CONFIG,
      source: "default",
    });
    expect(store.set).toHaveBeenCalledWith(
      BASELOAD_WORKERS_CONFIG_REDIS_KEY,
      JSON.stringify(DEFAULT_BASELOAD_WORKERS_CONFIG)
    );
  });

  it("replaces malformed Redis values with the default config", async () => {
    const store = createStore("{broken-json");

    const result = await loadBaseloadWorkersConfig(store);

    expect(result.source).toBe("default");
    expect(result.config).toEqual(DEFAULT_BASELOAD_WORKERS_CONFIG);
    expect(store.set).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported config versions", () => {
    const parsed = parseBaseloadWorkersConfig(
      JSON.stringify({
        version: BASELOAD_WORKERS_CONFIG_VERSION + 1,
        workers: DEFAULT_BASELOAD_WORKERS_CONFIG.workers,
      })
    );

    expect(parsed).toBeNull();
  });

  it("rejects invalid worker concurrency values", () => {
    const parsed = parseBaseloadWorkersConfig(
      JSON.stringify({
        version: BASELOAD_WORKERS_CONFIG_VERSION,
        workers: {
          repo: { concurrency: 0 },
          opencode: { concurrency: 3 },
          codex: { concurrency: 4 },
          claude: { concurrency: 5 },
        },
      })
    );

    expect(parsed).toBeNull();
  });

  it("serializes the version entry when saving config", async () => {
    const store = createStore();

    await saveBaseloadWorkersConfig(store);

    const [, rawValue] = (store.set as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(rawValue)).toMatchObject({
      version: BASELOAD_WORKERS_CONFIG_VERSION,
    });
  });
});
