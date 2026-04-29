import type { ChildProcess } from "child_process";

export interface AgentTaskCapturedLogs {
  output: string;
  stdout: string;
  stderr: string;
  opencodeSessionId?: string;
  opencodeSessionExport?: unknown;
}

export class AgentTaskCanceledError extends Error {
  constructor(
    message = "Task canceled by request.",
    public readonly logs?: AgentTaskCapturedLogs
  ) {
    super(message);
    this.name = "AgentTaskCanceledError";
  }
}

export function isAgentTaskCanceledError(
  error: unknown
): error is AgentTaskCanceledError {
  return error instanceof AgentTaskCanceledError;
}

export function signalChildProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals
): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (!isNoSuchProcessError(error)) {
        try {
          process.kill(child.pid, signal);
          return;
        } catch (fallbackError) {
          if (!isNoSuchProcessError(fallbackError)) {
            throw fallbackError;
          }
          return;
        }
      }
      return;
    }
  }

  if (!child.killed) {
    child.kill(signal);
  }
}

function isNoSuchProcessError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ESRCH"
  );
}
