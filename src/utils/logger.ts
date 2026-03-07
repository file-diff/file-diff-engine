type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = (process.env.LOG_LEVEL ?? "debug").toLowerCase();
const activeLevel: LogLevel =
  configuredLevel in LEVELS
    ? (configuredLevel as LogLevel)
    : "debug";

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[activeLevel];
}

function formatMessage(scope: string, message: string): string {
  return `[${new Date().toISOString()}] [${scope}] ${message}`;
}

function log(
  level: LogLevel,
  scope: string,
  message: string,
  meta?: unknown
): void {
  if (!shouldLog(level)) return;
  const formatted = formatMessage(scope, message);
  if (meta === undefined) {
    console[level](formatted);
    return;
  }
  console[level](formatted, meta);
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, meta?: unknown) =>
      log("debug", scope, message, meta),
    info: (message: string, meta?: unknown) => log("info", scope, message, meta),
    warn: (message: string, meta?: unknown) => log("warn", scope, message, meta),
    error: (message: string, meta?: unknown) =>
      log("error", scope, message, meta),
  };
}
