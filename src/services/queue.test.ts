import { describe, expect, it } from "vitest";
import {
  AGENT_TASK_SERIAL_QUEUE_NAMES,
  getQueueJobNameForTaskRunner,
  getQueueNameForJobName,
  MAX_CONCURRENCY_PER_TASK_KIND,
  QUEUE_NAMES,
} from "./queue";

describe("queue routing", () => {
  it("routes each job kind to its own queue", () => {
    expect(getQueueNameForJobName("process-repo")).toBe(QUEUE_NAMES.repo);
    expect(getQueueNameForJobName("create-opencode-task")).toBe(QUEUE_NAMES.opencode);
    expect(getQueueNameForJobName("create-codex-task")).toBe(QUEUE_NAMES.codex);
    expect(getQueueNameForJobName("create-claude-task")).toBe(QUEUE_NAMES.claude);
  });

  it("uses BullMQ-safe queue names", () => {
    const queueNames = [
      ...Object.values(QUEUE_NAMES),
      ...Object.values(AGENT_TASK_SERIAL_QUEUE_NAMES),
    ];
    expect(queueNames.every((name) => !name.includes(":"))).toBe(true);
  });

  it("defines serial queue names for agent task runners", () => {
    expect(AGENT_TASK_SERIAL_QUEUE_NAMES.opencode).toBe("repo-processing-opencode-serial");
    expect(AGENT_TASK_SERIAL_QUEUE_NAMES.codex).toBe("repo-processing-codex-serial");
    expect(AGENT_TASK_SERIAL_QUEUE_NAMES.claude).toBe("repo-processing-claude-serial");
  });

  it("uses five workers per job kind", () => {
    expect(MAX_CONCURRENCY_PER_TASK_KIND).toBe(5);
  });

  it("maps task runners to their BullMQ job names", () => {
    expect(getQueueJobNameForTaskRunner("opencode")).toBe("create-opencode-task");
    expect(getQueueJobNameForTaskRunner("codex")).toBe("create-codex-task");
    expect(getQueueJobNameForTaskRunner("claude")).toBe("create-claude-task");
    expect(getQueueJobNameForTaskRunner(undefined)).toBe("create-codex-task");
  });
});
