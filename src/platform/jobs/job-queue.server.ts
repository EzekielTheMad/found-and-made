import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { z } from "zod";

const jobRowSchema = z.object({
  artifactRefs: z.array(z.string()),
  attempts: z.number().int().nonnegative(),
  availableAt: z.string(),
  createdAt: z.string(),
  errorCode: z.string().nullable(),
  id: z.string(),
  idempotencyKey: z.string(),
  leaseExpiresAt: z.string().nullable(),
  leaseOwner: z.string().nullable(),
  maxAttempts: z.number().int().positive(),
  payload: z.string(),
  progress: z.number().int().min(0).max(100),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  type: z.string(),
  updatedAt: z.string(),
  version: z.number().int().positive(),
});

export type JobRecord = z.infer<typeof jobRowSchema>;

export interface EnqueueJobInput {
  idempotencyKey: string;
  maxAttempts?: number;
  payload: unknown;
  type: string;
  version: number;
}

export class JobQueue {
  public constructor(private readonly sqlite: Database.Database) {}

  public enqueue(input: EnqueueJobInput): JobRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO jobs (
          id, type, version, payload, status, attempts, max_attempts, artifact_refs,
          available_at, lease_owner, lease_expires_at, progress, error_code,
          idempotency_key, created_at, updated_at
        ) VALUES (
          @id, @type, @version, @payload, 'queued', 0, @maxAttempts, '[]',
          @availableAt, NULL, NULL, 0, NULL, @idempotencyKey, @createdAt, @updatedAt
        ) ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run({
        availableAt: now,
        createdAt: now,
        id,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: input.maxAttempts ?? 3,
        payload: JSON.stringify(input.payload),
        type: input.type,
        updatedAt: now,
        version: input.version,
      });

    const row = this.sqlite
      .prepare(`${SELECT_JOB} WHERE idempotency_key = ?`)
      .get(input.idempotencyKey);
    return parseJobRow(row);
  }

  public claim(leaseOwner: string, leaseDurationMs: number): JobRecord | null {
    const transaction = this.sqlite.transaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();
      const candidate = this.sqlite
        .prepare(
          `${SELECT_JOB}
           WHERE available_at <= @now
             AND (
               status = 'queued'
               OR (status = 'running' AND lease_expires_at <= @now)
             )
           ORDER BY available_at ASC, created_at ASC
           LIMIT 1`,
        )
        .get({ now: nowIso });

      if (!candidate) return null;
      const job = parseJobRow(candidate);
      const leaseExpiresAt = new Date(
        now.getTime() + leaseDurationMs,
      ).toISOString();
      const result = this.sqlite
        .prepare(
          `UPDATE jobs
           SET status = 'running',
               attempts = attempts + 1,
               error_code = NULL,
               lease_owner = @leaseOwner,
               lease_expires_at = @leaseExpiresAt,
               updated_at = @now
           WHERE id = @id
             AND (
               status = 'queued'
               OR (status = 'running' AND lease_expires_at <= @now)
             )`,
        )
        .run({
          id: job.id,
          leaseExpiresAt,
          leaseOwner,
          now: nowIso,
        });

      if (result.changes !== 1) return null;
      return this.get(job.id);
    });

    return transaction.immediate();
  }

  public complete(id: string, leaseOwner: string): void {
    const now = new Date().toISOString();
    const result = this.sqlite
      .prepare(
        `UPDATE jobs
         SET status = 'succeeded', progress = 100, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = @now
         WHERE id = @id AND status = 'running' AND lease_owner = @leaseOwner`,
      )
      .run({ id, leaseOwner, now });

    if (result.changes !== 1) {
      throw new Error("Job completion rejected because its lease is not owned");
    }
  }

  public renewLease(
    id: string,
    leaseOwner: string,
    leaseDurationMs: number,
  ): void {
    const now = new Date();
    const result = this.sqlite
      .prepare(
        `UPDATE jobs
         SET lease_expires_at = @leaseExpiresAt, updated_at = @now
         WHERE id = @id AND status = 'running' AND lease_owner = @leaseOwner`,
      )
      .run({
        id,
        leaseExpiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
        leaseOwner,
        now: now.toISOString(),
      });
    if (result.changes !== 1)
      throw new Error(
        "Job lease renewal rejected because its lease is not owned",
      );
  }

  public setProgress(
    id: string,
    leaseOwner: string,
    progress: number,
    artifactRefs?: readonly string[],
  ): void {
    if (!Number.isInteger(progress) || progress < 0 || progress > 100)
      throw new Error("Job progress must be an integer from 0 through 100");
    const result = this.sqlite
      .prepare(
        `UPDATE jobs
         SET progress = MAX(progress, @progress),
             artifact_refs = COALESCE(@artifactRefs, artifact_refs),
             updated_at = @now
         WHERE id = @id AND status = 'running' AND lease_owner = @leaseOwner`,
      )
      .run({
        artifactRefs: artifactRefs ? JSON.stringify(artifactRefs) : null,
        id,
        leaseOwner,
        now: new Date().toISOString(),
        progress,
      });
    if (result.changes !== 1)
      throw new Error("Job progress rejected because its lease is not owned");
  }

  public fail(id: string, leaseOwner: string, errorCode: string): void {
    const job = this.get(id);
    if (!job) throw new Error("Cannot fail an unknown job");

    const terminal = job.attempts >= job.maxAttempts;
    const availableAt = new Date(
      Date.now() + Math.min(30_000, 500 * 2 ** job.attempts),
    ).toISOString();
    const now = new Date().toISOString();
    const result = this.sqlite
      .prepare(
        `UPDATE jobs
         SET status = @status, available_at = @availableAt,
             lease_owner = NULL, lease_expires_at = NULL,
             error_code = @errorCode, updated_at = @now
         WHERE id = @id AND status = 'running' AND lease_owner = @leaseOwner`,
      )
      .run({
        availableAt,
        errorCode,
        id,
        leaseOwner,
        now,
        status: terminal ? "failed" : "queued",
      });

    if (result.changes !== 1) {
      throw new Error("Job failure rejected because its lease is not owned");
    }
  }

  public get(id: string): JobRecord | null {
    const row = this.sqlite.prepare(`${SELECT_JOB} WHERE id = ?`).get(id);
    return row ? parseJobRow(row) : null;
  }

  public retry(id: string): JobRecord {
    const now = new Date().toISOString();
    const result = this.sqlite
      .prepare(
        `UPDATE jobs
         SET status = 'queued', attempts = 0, available_at = @now,
             lease_owner = NULL, lease_expires_at = NULL, error_code = NULL,
             updated_at = @now
         WHERE id = @id AND status = 'failed'`,
      )
      .run({ id, now });
    if (result.changes !== 1)
      throw new Error("Only terminal failed jobs can be retried");
    const job = this.get(id);
    if (!job) throw new Error("Retried job was not found");
    return job;
  }
}

const SELECT_JOB = `SELECT
  id,
  artifact_refs AS artifactRefs,
  type,
  version,
  payload,
  status,
  attempts,
  max_attempts AS maxAttempts,
  available_at AS availableAt,
  lease_owner AS leaseOwner,
  lease_expires_at AS leaseExpiresAt,
  progress,
  error_code AS errorCode,
  idempotency_key AS idempotencyKey,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM jobs`;

function parseJobRow(row: unknown): JobRecord {
  const record = row as { artifactRefs?: unknown };
  return jobRowSchema.parse({
    ...record,
    artifactRefs:
      typeof record.artifactRefs === "string"
        ? (JSON.parse(record.artifactRefs) as unknown)
        : record.artifactRefs,
  });
}
