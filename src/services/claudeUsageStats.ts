import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const CLAUDE_USAGE_STATS_TIMEOUT_MS = 30_000;
const CLAUDE_USAGE_STATS_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export async function getClaudeUsageStatsText(): Promise<string> {
  const { stdout } = await execFileAsync("npx", ["ccusage"], {
    timeout: CLAUDE_USAGE_STATS_TIMEOUT_MS,
    maxBuffer: CLAUDE_USAGE_STATS_MAX_BUFFER_BYTES,
  });

  return stdout;
}
