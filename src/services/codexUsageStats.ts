import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const CODEX_USAGE_STATS_TIMEOUT_MS = 30_000;
const CODEX_USAGE_STATS_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export async function getCodexUsageStatsText(): Promise<string> {
  const { stdout } = await execFileAsync("npx", ["@ccusage/codex"], {
    timeout: CODEX_USAGE_STATS_TIMEOUT_MS,
    maxBuffer: CODEX_USAGE_STATS_MAX_BUFFER_BYTES,
  });

  return stdout;
}
