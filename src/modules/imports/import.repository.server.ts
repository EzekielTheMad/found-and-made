import { createHash, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
  IMPORT_STAGES,
  type ConfirmImportReviewInput,
  type ImportCheckpoint,
  type ImportSession,
  type ImportSource,
  type ImportStage,
  type ImportStatus,
} from "./import.types";

interface ImportSessionRow {
  createdAt: string;
  currentStage: string | null;
  id: string;
  jobId: string | null;
  progress: number;
  requestKey: string;
  requestedBy: string | null;
  resultingRecipeId: string | null;
  source: string;
  sourceKind: string;
  status: string;
  updatedAt: string;
}

interface ImportCheckpointRow {
  artifact: string;
  artifactHash: string;
  completedAt: string;
  id: string;
  sessionId: string;
  stage: string;
}

export class ImportRepository {
  public constructor(private readonly sqlite: Database.Database) {}

  public createSession(input: {
    id: string;
    requestKey: string;
    requestedBy: string;
    source: ImportSource;
  }): ImportSession {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO import_sessions (
           id, request_key, requested_by, source_kind, source, status,
           current_stage, progress, job_id, resulting_recipe_id,
           created_at, updated_at
         ) VALUES (
           @id, @requestKey, @requestedBy, @sourceKind, @source, 'queued',
           NULL, 0, NULL, NULL, @now, @now
         ) ON CONFLICT(request_key) DO NOTHING`,
      )
      .run({
        id: input.id,
        now,
        requestKey: input.requestKey,
        requestedBy: input.requestedBy,
        source: serialize(input.source),
        sourceKind: input.source.kind,
      });
    const session = this.findByRequestKey(input.requestKey);
    if (!session) throw new Error("Import session was not persisted");
    return session;
  }

  public attachJob(
    sessionId: string,
    jobId: string,
    options: { replace?: boolean } = {},
  ): ImportSession {
    this.sqlite
      .prepare(
        `UPDATE import_sessions
         SET job_id = CASE WHEN @replace = 1 THEN @jobId
                           ELSE COALESCE(job_id, @jobId) END,
             updated_at = @now
         WHERE id = @sessionId`,
      )
      .run({
        jobId,
        now: new Date().toISOString(),
        replace: options.replace ? 1 : 0,
        sessionId,
      });
    return this.require(sessionId);
  }

  public find(id: string): ImportSession | null {
    const row = this.sqlite
      .prepare(`${SELECT_SESSION} WHERE id = ?`)
      .get(id) as ImportSessionRow | undefined;
    return row ? parseSession(row) : null;
  }

  public findByRequestKey(requestKey: string): ImportSession | null {
    const row = this.sqlite
      .prepare(`${SELECT_SESSION} WHERE request_key = ?`)
      .get(requestKey) as ImportSessionRow | undefined;
    return row ? parseSession(row) : null;
  }

  public list(requestedBy?: string): ImportSession[] {
    const rows = requestedBy
      ? (this.sqlite
          .prepare(
            `${SELECT_SESSION} WHERE requested_by = ? ORDER BY updated_at DESC`,
          )
          .all(requestedBy) as ImportSessionRow[])
      : (this.sqlite
          .prepare(`${SELECT_SESSION} ORDER BY updated_at DESC`)
          .all() as ImportSessionRow[]);
    return rows.map(parseSession);
  }

  public require(id: string): ImportSession {
    const session = this.find(id);
    if (!session) throw new Error(`Import session ${id} was not found`);
    return session;
  }

  public checkpoint<T>(
    sessionId: string,
    stage: ImportStage,
  ): ImportCheckpoint<T> | null {
    const row = this.sqlite
      .prepare(
        `${SELECT_CHECKPOINT} WHERE session_id = ? AND stage = ? LIMIT 1`,
      )
      .get(sessionId, stage) as ImportCheckpointRow | undefined;
    return row ? parseCheckpoint<T>(row) : null;
  }

  public checkpoints(sessionId: string): ImportCheckpoint[] {
    const rows = this.sqlite
      .prepare(
        `${SELECT_CHECKPOINT} WHERE session_id = ? ORDER BY completed_at, stage`,
      )
      .all(sessionId) as ImportCheckpointRow[];
    return rows.map((row) => parseCheckpoint(row));
  }

  public saveCheckpoint<T>(
    sessionId: string,
    stage: ImportStage,
    artifact: T,
  ): ImportCheckpoint<T> {
    const serialized = serialize(artifact);
    const artifactHash = createHash("sha256").update(serialized).digest("hex");
    const completedAt = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO import_checkpoints (
           id, session_id, stage, artifact, artifact_hash, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, stage) DO NOTHING`,
      )
      .run(
        randomUUID(),
        sessionId,
        stage,
        serialized,
        artifactHash,
        completedAt,
      );
    const checkpoint = this.checkpoint<T>(sessionId, stage);
    if (!checkpoint) throw new Error("Import checkpoint was not persisted");
    return checkpoint;
  }

  public markStage(
    sessionId: string,
    stage: ImportStage,
    progress: number,
  ): ImportSession {
    const status: ImportStatus = stage === "review" ? "review" : "processing";
    this.sqlite
      .prepare(
        `UPDATE import_sessions
         SET current_stage = @stage, progress = MAX(progress, @progress),
             status = @status, updated_at = @now
         WHERE id = @sessionId AND status NOT IN ('completed', 'cancelled', 'skipped')`,
      )
      .run({
        now: new Date().toISOString(),
        progress,
        sessionId,
        stage,
        status,
      });
    return this.require(sessionId);
  }

  public markFailed(sessionId: string): void {
    this.sqlite
      .prepare(
        `UPDATE import_sessions
         SET status = 'failed', updated_at = @now
         WHERE id = @sessionId AND status NOT IN ('completed','cancelled')`,
      )
      .run({ now: new Date().toISOString(), sessionId });
  }

  public markSkippedDuplicate(sessionId: string): ImportSession {
    const result = this.sqlite
      .prepare(
        `UPDATE import_sessions
         SET status = 'skipped', current_stage = 'duplicate', progress = 100,
             updated_at = @now
         WHERE id = @sessionId AND resulting_recipe_id IS NULL
           AND status NOT IN ('completed','cancelled','skipped')`,
      )
      .run({ now: new Date().toISOString(), sessionId });
    if (result.changes !== 1)
      throw new Error("Duplicate import could not be skipped");
    return this.require(sessionId);
  }

  public markQueuedForRetry(sessionId: string): ImportSession {
    this.sqlite
      .prepare(
        `UPDATE import_sessions
         SET status = 'queued', updated_at = @now
         WHERE id = @sessionId AND status NOT IN ('completed','cancelled')`,
      )
      .run({ now: new Date().toISOString(), sessionId });
    return this.require(sessionId);
  }

  public completeReview(
    sessionId: string,
    reviewerId: string,
    review: ConfirmImportReviewInput,
    createRecipe: () => { id: string },
  ): string {
    return this.sqlite
      .transaction(() => {
        const session = this.require(sessionId);
        if (session.resultingRecipeId) return session.resultingRecipeId;
        if (session.status !== "review")
          throw new Error("Import is not awaiting review");

        const recipe = createRecipe();
        const reviewedAt = new Date().toISOString();
        this.sqlite
          .prepare(
            `INSERT INTO import_reviews (
             session_id, draft, confirmed_brand_ingredient_ids,
             reviewed_by, reviewed_at
           ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            sessionId,
            serialize(review.draft),
            serialize(review.confirmedBrandIngredientIds),
            reviewerId,
            reviewedAt,
          );
        this.sqlite
          .prepare(
            `UPDATE import_sessions
           SET status = 'completed', progress = 100, resulting_recipe_id = ?,
               updated_at = ?
           WHERE id = ?`,
          )
          .run(recipe.id, reviewedAt, sessionId);
        return recipe.id;
      })
      .immediate();
  }

  public ensureResultingRecipe(
    sessionId: string,
    createRecipe: () => { id: string },
  ): string {
    return this.sqlite
      .transaction(() => {
        const session = this.require(sessionId);
        if (session.resultingRecipeId) return session.resultingRecipeId;
        if (session.status !== "processing" && session.status !== "review") {
          throw new Error("Import is not ready to create a recipe");
        }
        const recipe = createRecipe();
        this.sqlite
          .prepare(
            `UPDATE import_sessions
             SET resulting_recipe_id = ?, status = 'processing',
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(recipe.id, new Date().toISOString(), sessionId);
        return recipe.id;
      })
      .immediate();
  }

  public markCompleted(sessionId: string): ImportSession {
    const result = this.sqlite
      .prepare(
        `UPDATE import_sessions
         SET status = 'completed', progress = 100, updated_at = @now
         WHERE id = @sessionId AND resulting_recipe_id IS NOT NULL`,
      )
      .run({ now: new Date().toISOString(), sessionId });
    if (result.changes !== 1)
      throw new Error("Import completion requires a resulting recipe");
    return this.require(sessionId);
  }
}

const SELECT_SESSION = `SELECT
  id,
  request_key AS requestKey,
  requested_by AS requestedBy,
  source_kind AS sourceKind,
  source,
  status,
  current_stage AS currentStage,
  progress,
  job_id AS jobId,
  resulting_recipe_id AS resultingRecipeId,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM import_sessions`;

const SELECT_CHECKPOINT = `SELECT
  id,
  session_id AS sessionId,
  stage,
  artifact,
  artifact_hash AS artifactHash,
  completed_at AS completedAt
FROM import_checkpoints`;

function parseSession(row: ImportSessionRow): ImportSession {
  if (!isImportStage(row.currentStage) && row.currentStage !== null)
    throw new Error(`Unknown import stage ${row.currentStage}`);
  if (!isImportStatus(row.status))
    throw new Error(`Unknown import status ${row.status}`);
  return {
    ...row,
    currentStage: row.currentStage,
    source: JSON.parse(row.source) as ImportSource,
    sourceKind: row.sourceKind as ImportSource["kind"],
    status: row.status,
  };
}

function parseCheckpoint<T>(row: ImportCheckpointRow): ImportCheckpoint<T> {
  if (!isImportStage(row.stage))
    throw new Error(`Unknown import stage ${row.stage}`);
  return {
    ...row,
    artifact: JSON.parse(row.artifact) as T,
    stage: row.stage,
  };
}

function isImportStage(value: string | null): value is ImportStage {
  return value !== null && (IMPORT_STAGES as readonly string[]).includes(value);
}

function isImportStatus(value: string): value is ImportStatus {
  return [
    "queued",
    "processing",
    "review",
    "completed",
    "failed",
    "cancelled",
    "skipped",
  ].includes(value);
}

function serialize(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new Error("Import data must be JSON serializable");
  return serialized;
}
