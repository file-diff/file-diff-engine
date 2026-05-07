import { Job, JobsOptions, Queue } from "bullmq";

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);

export const QUEUE_NAME = "repo-processing";
export const MAX_CONCURRENCY_PER_TASK_KIND = 5;

export type QueueJobName =
  | "process-repo"
  | "create-opencode-task"
  | "create-codex-task"
  | "create-claude-task";

export type QueueKind = "repo" | "opencode" | "codex" | "claude";

export const QUEUE_NAMES: Record<QueueKind, string> = {
  repo: QUEUE_NAME,
  opencode: `${QUEUE_NAME}-opencode`,
  codex: `${QUEUE_NAME}-codex`,
  claude: `${QUEUE_NAME}-claude`,
};

export interface ManagedQueue {
  add(name: QueueJobName, data: unknown, options?: JobsOptions): Promise<Job>;
  getJob(jobId: string, jobName?: QueueJobName): Promise<Job | undefined>;
  close(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): void;
  getQueueForJobName(jobName: QueueJobName): Queue;
  getQueues(): Queue[];
}

const QUEUE_KIND_BY_JOB_NAME: Record<QueueJobName, QueueKind> = {
  "process-repo": "repo",
  "create-opencode-task": "opencode",
  "create-codex-task": "codex",
  "create-claude-task": "claude",
};

const connection = {
  host: REDIS_HOST,
  port: REDIS_PORT,
  maxRetriesPerRequest: null,
};

function createBullQueue(name: string): Queue {
  return new Queue(name, {
    connection: {
      ...connection,
    },
  });
}

export function getQueueJobNameForTaskRunner(
  taskRunner: "opencode" | "codex" | "claude" | undefined
): QueueJobName {
  if (taskRunner === "opencode") {
    return "create-opencode-task";
  }

  if (taskRunner === "claude") {
    return "create-claude-task";
  }

  return "create-codex-task";
}

export function getQueueNameForJobName(jobName: QueueJobName): string {
  return QUEUE_NAMES[QUEUE_KIND_BY_JOB_NAME[jobName]];
}

class BullManagedQueue implements ManagedQueue {
  private readonly queuesByKind: Record<QueueKind, Queue>;

  constructor() {
    this.queuesByKind = {
      repo: createBullQueue(QUEUE_NAMES.repo),
      opencode: createBullQueue(QUEUE_NAMES.opencode),
      codex: createBullQueue(QUEUE_NAMES.codex),
      claude: createBullQueue(QUEUE_NAMES.claude),
    };
  }

  async add(
    name: QueueJobName,
    data: unknown,
    options?: JobsOptions
  ): Promise<Job> {
    return this.getQueueForJobName(name).add(name, data, options);
  }

  async getJob(
    jobId: string,
    jobName?: QueueJobName
  ): Promise<Job | undefined> {
    if (jobName) {
      return (await this.getQueueForJobName(jobName).getJob(jobId)) ?? undefined;
    }

    for (const queue of this.getQueues()) {
      const job = await queue.getJob(jobId);
      if (job) {
        return job;
      }
    }

    return undefined;
  }

  async close(): Promise<void> {
    await Promise.all(this.getQueues().map((queue) => queue.close()));
  }

  on(event: "error", listener: (error: Error) => void): void {
    for (const queue of this.getQueues()) {
      queue.on(event, listener);
    }
  }

  getQueueForJobName(jobName: QueueJobName): Queue {
    return this.queuesByKind[QUEUE_KIND_BY_JOB_NAME[jobName]];
  }

  getQueues(): Queue[] {
    return [
      this.queuesByKind.repo,
      this.queuesByKind.opencode,
      this.queuesByKind.codex,
      this.queuesByKind.claude,
    ];
  }
}

export function createQueue(): ManagedQueue {
  return new BullManagedQueue();
}
