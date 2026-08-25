import type { JobQueue, JobRecord } from "./job-queue.server";

export interface JobHandlerContext {
  progress(value: number, artifactRefs?: readonly string[]): void;
  renewLease(): void;
}

export type JobHandler = (
  job: JobRecord,
  context: JobHandlerContext,
) => Promise<void>;

export class JobHandlerError extends Error {
  public constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "JobHandlerError";
  }
}

interface JobWorkerOptions {
  handlers: ReadonlyMap<string, JobHandler>;
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  queue: JobQueue;
  workerId?: string;
}

export class JobWorker {
  private active: Promise<void> | null = null;
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;

  private readonly handlers: ReadonlyMap<string, JobHandler>;
  private readonly leaseDurationMs: number;
  private readonly pollIntervalMs: number;
  private readonly queue: JobQueue;
  private readonly workerId: string;

  public constructor(options: JobWorkerOptions) {
    this.handlers = options.handlers;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.queue = options.queue;
    this.workerId = options.workerId ?? `worker-${process.pid}`;
  }

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.active;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.active = this.runOnce().finally(() => {
        this.active = null;
        this.schedule(this.pollIntervalMs);
      });
    }, delayMs);
    this.timer.unref();
  }

  private async runOnce(): Promise<void> {
    const job = this.queue.claim(this.workerId, this.leaseDurationMs);
    if (!job) return;

    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.queue.fail(job.id, this.workerId, "unsupported_job_type");
      return;
    }

    const renewEveryMs = Math.max(50, Math.floor(this.leaseDurationMs / 3));
    const heartbeat = setInterval(() => {
      try {
        this.queue.renewLease(job.id, this.workerId, this.leaseDurationMs);
      } catch {
        clearInterval(heartbeat);
      }
    }, renewEveryMs);
    heartbeat.unref();
    const context: JobHandlerContext = {
      progress: (value, artifactRefs) => {
        this.queue.setProgress(job.id, this.workerId, value, artifactRefs);
      },
      renewLease: () => {
        this.queue.renewLease(job.id, this.workerId, this.leaseDurationMs);
      },
    };

    try {
      await handler(job, context);
      this.queue.complete(job.id, this.workerId);
    } catch (error) {
      this.queue.fail(
        job.id,
        this.workerId,
        error instanceof JobHandlerError ? error.code : "handler_failed",
      );
    } finally {
      clearInterval(heartbeat);
    }
  }
}
