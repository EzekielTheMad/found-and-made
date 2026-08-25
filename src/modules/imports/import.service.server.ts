import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { AuthorizationPolicy } from "../identity/authorization.policy";
import {
  AuthorizationError,
  systemPrincipal,
  type Principal,
} from "../identity/identity.types";
import type { RecipeAccessService } from "../recipes/recipe-access.service.server";
import type { RecipeAggregate } from "../recipes/recipe.types";
import type { MediaService } from "../media/media.service.server";
import type { DiscoveryService } from "../discovery/discovery.service.server";
import type { ImportUploadStore } from "../../platform/files/import-upload.server";
import type { JobQueue, JobRecord } from "../../platform/jobs/job-queue.server";
import type {
  JobHandler,
  JobHandlerContext,
} from "../../platform/jobs/job-worker.server";
import { ImportAcquisitionService } from "./import-acquisition.server";
import { ImportExtractionService } from "./import-extraction.server";
import { ImportRepository } from "./import.repository.server";
import { ImportStructureService } from "./import-structure.server";
import {
  mapImportIngredients,
  normalizeManualImport,
  normalizeStructuredImport,
} from "./import-transform";
import {
  IMPORT_STAGES,
  STANDARD_IMPORT_TAGS,
  ImportNotReadyError,
  ImportReviewRequiredError,
  type AcquiredImport,
  type ConfirmImportReviewInput,
  type DuplicateImport,
  type ExtractedImport,
  type ImportModelProvider,
  type ImportMediaTextExtractor,
  type ImportReviewPackage,
  type ImportSession,
  type ImportSource,
  type ImportStage,
  type MappedImport,
  type NormalizedImport,
  type PublicContentAcquirer,
  type StructuredImport,
} from "./import.types";

export const IMPORT_JOB_TYPE = "imports.process";
export const IMPORT_JOB_VERSION = 2;

export interface ImportServiceOptions {
  discoveryService?: DiscoveryService;
  jobQueue: JobQueue;
  importUploads?: ImportUploadStore;
  mediaService?: MediaService;
  mediaTextExtractor?: ImportMediaTextExtractor;
  modelProvider?: ImportModelProvider;
  publicContentAcquirer?: PublicContentAcquirer;
  recipeAccess: RecipeAccessService;
  sqlite: Database.Database;
}

export interface StartImportOptions {
  idempotencyKey: string;
  maxAttempts?: number;
}

const progressByStage: Record<ImportStage, number> = {
  acquire: 10,
  duplicate: 90,
  extract: 25,
  map: 75,
  normalize: 60,
  review: 95,
  structure: 45,
};

export class ImportService {
  public readonly jobHandler: JobHandler;

  private readonly acquisition: ImportAcquisitionService;
  private readonly discoveryService?: DiscoveryService;
  private readonly jobQueue: JobQueue;
  private readonly importUploads?: ImportUploadStore;
  private readonly extraction: ImportExtractionService;
  private readonly mediaService?: MediaService;
  private readonly policy = new AuthorizationPolicy();
  private readonly publicContentAcquirer?: PublicContentAcquirer;
  private readonly recipeAccess: RecipeAccessService;
  private readonly repository: ImportRepository;
  private readonly sqlite: Database.Database;
  private readonly structure: ImportStructureService;

  public constructor(options: ImportServiceOptions) {
    this.acquisition = new ImportAcquisitionService(
      options.publicContentAcquirer,
    );
    this.discoveryService = options.discoveryService;
    this.extraction = new ImportExtractionService(
      options.importUploads,
      options.mediaTextExtractor,
    );
    this.jobQueue = options.jobQueue;
    this.importUploads = options.importUploads;
    this.mediaService = options.mediaService;
    this.publicContentAcquirer = options.publicContentAcquirer;
    this.recipeAccess = options.recipeAccess;
    this.repository = new ImportRepository(options.sqlite);
    this.sqlite = options.sqlite;
    this.structure = new ImportStructureService(options.modelProvider);
    this.jobHandler = this.process.bind(this);
  }

  public start(
    principal: Principal,
    source: ImportSource,
    options: StartImportOptions,
  ): ImportSession {
    this.policy.require(principal, "recipe:create");
    if (principal.kind !== "user")
      throw new Error("Imports must be started by an authenticated user");
    if (!options.idempotencyKey.trim())
      throw new Error("Import idempotency key is required");
    assertSerializable(source);

    const requestKey = `${principal.userId}:${options.idempotencyKey.trim()}`;
    let session = this.repository.createSession({
      id: randomUUID(),
      requestKey,
      requestedBy: principal.userId,
      source,
    });
    const job = this.jobQueue.enqueue({
      idempotencyKey: `import:${session.id}`,
      maxAttempts: options.maxAttempts ?? 3,
      payload: { sessionId: session.id },
      type: IMPORT_JOB_TYPE,
      version: IMPORT_JOB_VERSION,
    });
    session = this.repository.attachJob(session.id, job.id);
    return session;
  }

  public startBatch(
    principal: Principal,
    sources: ImportSource[],
    options: StartImportOptions,
  ): ImportSession[] {
    this.policy.require(principal, "recipe:create");
    if (sources.length < 1 || sources.length > 500) {
      throw new Error("Import batches must contain between 1 and 500 recipes");
    }
    return this.sqlite
      .transaction(() =>
        sources.map((source, index) =>
          this.start(principal, source, {
            ...options,
            idempotencyKey: `${options.idempotencyKey}:${index + 1}`,
          }),
        ),
      )
      .immediate();
  }

  public enqueuePendingFinalization(): number {
    const sessions = this.repository
      .list()
      .filter((session) => session.status === "review");
    for (const session of sessions) {
      const job = this.jobQueue.enqueue({
        idempotencyKey: `import:auto-finalize:v2:${session.id}`,
        payload: { sessionId: session.id },
        type: IMPORT_JOB_TYPE,
        version: IMPORT_JOB_VERSION,
      });
      this.repository.attachJob(session.id, job.id, { replace: true });
    }
    return sessions.length;
  }

  public get(principal: Principal, sessionId: string): ImportSession {
    this.policy.require(principal, "recipe:review");
    return this.authorizeSession(principal, sessionId);
  }

  public list(principal: Principal): ImportSession[] {
    this.policy.require(principal, "recipe:review");
    if (principal.kind !== "user")
      throw new Error("Import history requires an authenticated user");
    return this.repository.list(
      principal.role === "owner" ? undefined : principal.userId,
    );
  }

  public review(principal: Principal, sessionId: string): ImportReviewPackage {
    this.policy.require(principal, "recipe:review");
    this.authorizeSession(principal, sessionId);
    const checkpoint = this.repository.checkpoint<ImportReviewPackage>(
      sessionId,
      "review",
    );
    if (!checkpoint)
      throw new ImportReviewRequiredError("Import has not reached review");
    return checkpoint.artifact;
  }

  public confirmReview(
    principal: Principal,
    sessionId: string,
    input: ConfirmImportReviewInput,
  ): RecipeAggregate {
    this.policy.require(principal, "recipe:review");
    if (principal.kind !== "user")
      throw new Error("Import review requires an authenticated user");
    const session = this.authorizeSession(principal, sessionId);
    if (session.resultingRecipeId)
      return this.recipeAccess.get(principal, session.resultingRecipeId);
    const review = this.review(principal, sessionId);
    const confirmed = new Set(input.confirmedBrandIngredientIds);
    const missing = review.brandConfirmations.filter(
      (item) => !confirmed.has(item.ingredientId),
    );
    if (missing.length > 0) {
      throw new ImportNotReadyError(
        `Brand-sensitive ingredients require confirmation: ${missing
          .map((item) => item.ingredientId)
          .join(", ")}`,
      );
    }

    const canonicalUrl = review.draft.source.canonicalUrl;
    const draft = structuredClone(input.draft);
    draft.source = {
      ...draft.source,
      ...(canonicalUrl ? { canonicalUrl, originalUrl: canonicalUrl } : {}),
      originalWording: review.sourceWording,
    };
    const recipeId = this.repository.completeReview(
      sessionId,
      principal.userId,
      { ...input, draft },
      () =>
        this.recipeAccess.create(principal, draft, {
          allowDuplicate: input.allowDuplicate ?? false,
        }),
    );
    return this.recipeAccess.get(principal, recipeId);
  }

  public retry(principal: Principal, sessionId: string): ImportSession {
    this.policy.require(principal, "recipe:review");
    const session = this.authorizeSession(principal, sessionId);
    if (!session.jobId) throw new Error("Import has no durable job");
    this.jobQueue.retry(session.jobId);
    return this.repository.markQueuedForRetry(sessionId);
  }

  public retryFailedBatch(principal: Principal, batchKey: string): number {
    this.policy.require(principal, "recipe:review");
    if (principal.kind !== "user")
      throw new Error("Import retry requires an authenticated user");
    const normalized = batchKey.trim();
    if (!normalized) throw new Error("Import batch key is required");
    const prefix = `${principal.userId}:${normalized}:`;
    const failed = this.list(principal).filter(
      (session) =>
        session.status === "failed" && session.requestKey.startsWith(prefix),
    );
    this.sqlite
      .transaction(() => {
        for (const session of failed) this.retry(principal, session.id);
      })
      .immediate();
    return failed.length;
  }

  public checkpoints(principal: Principal, sessionId: string) {
    this.policy.require(principal, "recipe:review");
    this.authorizeSession(principal, sessionId);
    return this.repository.checkpoints(sessionId);
  }

  public async process(
    job: JobRecord,
    context: JobHandlerContext,
  ): Promise<void> {
    if (
      job.type !== IMPORT_JOB_TYPE ||
      !([1, IMPORT_JOB_VERSION] as const).includes(job.version as 1 | 2)
    )
      throw new Error("Unsupported import job contract");
    const sessionId = parseSessionId(job.payload);
    const session = this.repository.require(sessionId);
    if (
      session.status === "completed" ||
      session.status === "cancelled" ||
      session.status === "skipped"
    )
      return;

    try {
      const acquired = await this.stage<AcquiredImport>(
        sessionId,
        "acquire",
        context,
        () => this.acquisition.acquire(session.source),
      );
      const extracted = await this.stage<ExtractedImport>(
        sessionId,
        "extract",
        context,
        () => this.extraction.extract(acquired),
      );
      const structured = await this.stage<StructuredImport>(
        sessionId,
        "structure",
        context,
        async () => {
          const candidate = await this.structure.structure(extracted);
          const warnings = [...extracted.warnings];
          if (
            candidate.ingredients.length === 0 ||
            candidate.steps.length === 0
          ) {
            warnings.push({
              code: "low_confidence",
              message:
                "The source did not provide a complete ingredient and step structure. Human completion is required.",
              severity: "warning",
            });
          }
          return { acquired: extracted, candidate, warnings };
        },
      );
      const normalized = await this.stage<NormalizedImport>(
        sessionId,
        "normalize",
        context,
        () =>
          session.source.kind === "manual"
            ? normalizeManualImport(structured, session.source.draft)
            : normalizeStructuredImport(structured),
      );
      const mapped = await this.stage<MappedImport>(
        sessionId,
        "map",
        context,
        () => mapImportIngredients(normalized),
      );
      const duplicate = await this.stage<DuplicateImport>(
        sessionId,
        "duplicate",
        context,
        () => ({
          ...mapped,
          duplicateCandidates:
            mapped.draft.ingredients.length > 0 && mapped.draft.steps.length > 0
              ? this.recipeAccess.duplicates(systemPrincipal, mapped.draft)
              : [],
        }),
      );
      if (duplicate.duplicateCandidates.length > 0) {
        this.repository.markSkippedDuplicate(sessionId);
        context.progress(100, [
          `import:${sessionId}:skipped-duplicate:${duplicate.duplicateCandidates[0]?.id ?? "existing"}`,
        ]);
        return;
      }
      const prepared = await this.stage<ImportReviewPackage>(
        sessionId,
        "review",
        context,
        () => ({
          ...duplicate,
          ...(session.source.kind === "migration_json"
            ? {
                heroImage: session.source.heroImage,
                migrationFormat: session.source.format,
              }
            : {}),
          ...(acquired.heroImageUrl
            ? { heroImageUrl: acquired.heroImageUrl }
            : {}),
          mandatory: false,
          privacy: "private",
          publishRequested: false,
          sourceWording: extracted.originalWording,
        }),
      );
      await this.finalize(sessionId, prepared, context);
    } catch (error) {
      if (job.attempts >= job.maxAttempts)
        this.repository.markFailed(sessionId);
      else this.repository.markQueuedForRetry(sessionId);
      throw error;
    }
  }

  private async finalize(
    sessionId: string,
    prepared: ImportReviewPackage,
    context: JobHandlerContext,
  ): Promise<void> {
    const draft = importDraft(prepared);
    const requestedBy = this.repository.require(sessionId).requestedBy;
    const recipeId = this.repository.ensureResultingRecipe(sessionId, () =>
      this.recipeAccess.create(systemPrincipal, draft, {
        allowDuplicate: true,
        ...(requestedBy ? { createdByUserId: requestedBy } : {}),
      }),
    );
    context.progress(98, [`import:${sessionId}:recipe:${recipeId}`]);

    if (prepared.standardizedTags.length > 0 && this.discoveryService) {
      const requested = new Set(prepared.standardizedTags);
      this.discoveryService.ensureAndAssignFacetTerms(
        systemPrincipal,
        recipeId,
        {
          group: { name: "Recipe type", slug: "recipe-type" },
          terms: STANDARD_IMPORT_TAGS.flatMap((name, position) =>
            requested.has(name)
              ? [
                  {
                    name,
                    position,
                    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
                  },
                ]
              : [],
          ),
        },
      );
    }

    const heroImage = prepared.heroImage;
    if (heroImage) {
      if (!this.mediaService || !this.importUploads) {
        throw new Error("Migration image services are not configured");
      }
      if (!this.mediaService.hero(recipeId)) {
        await this.mediaService.upload(systemPrincipal, {
          altText: draft.title.slice(0, 300),
          bytes: await this.importUploads.read(heroImage.storageRef),
          caption: `Imported from ${prepared.migrationFormat ?? "migration"}`,
          recipeId,
          role: "hero",
        });
      }
      await this.importUploads.remove(heroImage.storageRef);
    } else if (
      prepared.heroImageUrl &&
      this.mediaService &&
      this.publicContentAcquirer?.acquireImage &&
      !this.mediaService.hero(recipeId)
    ) {
      const acquiredImage = await this.publicContentAcquirer.acquireImage(
        prepared.heroImageUrl,
      );
      if (!("status" in acquiredImage)) {
        await this.mediaService.upload(systemPrincipal, {
          altText: draft.title.slice(0, 300),
          bytes: acquiredImage.bytes,
          caption: `Imported from ${new URL(prepared.heroImageUrl).hostname}`,
          recipeId,
          role: "hero",
        });
      }
    }
    this.repository.markCompleted(sessionId);
    context.progress(100, [`import:${sessionId}:completed:${recipeId}`]);
  }

  private async stage<T>(
    sessionId: string,
    stage: ImportStage,
    context: JobHandlerContext,
    execute: () => Promise<T> | T,
  ): Promise<T> {
    let checkpoint = this.repository.checkpoint<T>(sessionId, stage);
    if (!checkpoint) {
      checkpoint = this.repository.saveCheckpoint(
        sessionId,
        stage,
        await execute(),
      );
    }
    const progress = progressByStage[stage];
    this.repository.markStage(sessionId, stage, progress);
    context.progress(progress, [
      `import:${sessionId}:${stage}:${checkpoint.artifactHash}`,
    ]);
    return checkpoint.artifact;
  }

  private authorizeSession(
    principal: Principal,
    sessionId: string,
  ): ImportSession {
    if (principal.kind !== "user") throw new AuthorizationError();
    const session = this.repository.require(sessionId);
    if (
      principal.role !== "owner" &&
      session.requestedBy !== principal.userId
    ) {
      throw new AuthorizationError();
    }
    return session;
  }
}

function parseSessionId(payload: string): string {
  const value = JSON.parse(payload) as { sessionId?: unknown };
  if (typeof value.sessionId !== "string" || !value.sessionId)
    throw new Error("Import job payload requires sessionId");
  return value.sessionId;
}

function assertSerializable(source: ImportSource): void {
  const serialized = JSON.stringify(source);
  if (serialized === undefined)
    throw new Error("Import source must be JSON serializable");
  JSON.parse(serialized);
}

function importDraft(prepared: ImportReviewPackage) {
  const canonicalUrl = prepared.draft.source.canonicalUrl;
  const draft = structuredClone(prepared.draft);
  draft.source = {
    ...draft.source,
    ...(canonicalUrl ? { canonicalUrl, originalUrl: canonicalUrl } : {}),
    originalWording: prepared.sourceWording,
  };
  return draft;
}

export { IMPORT_STAGES };
