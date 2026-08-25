import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type Database from "better-sqlite3";

import { AuthorizationPolicy } from "../identity/authorization.policy";
import { AuthorizationError, type Principal } from "../identity/identity.types";
import type { RecipeAccessService } from "../recipes/recipe-access.service.server";
import {
  type CreatePrintCollectionInput,
  type CreatePrintJobInput,
  type CreatePrintProfileInput,
  type PrintArtifactMetadata,
  type PrintCollection,
  PrintIdempotencyConflictError,
  type PrintJob,
  type PrintJobRequest,
  type PrintJobStatus,
  type PrintLayout,
  type PrintNumberingMode,
  type PrintOutlineItem,
  type PrintPageSize,
  type PrintProfile,
  type PrintProfileConfig,
  type PrintRecipeSelection,
  type PrintRecipeSelectionInput,
  PrintVersionConflictError,
  type UpdatePrintCollectionInput,
  type UpdatePrintProfileInput,
} from "./printing.types";

export const PRINT_PAGE_DIMENSIONS_MM: Readonly<
  Record<PrintPageSize, { height: number; width: number }>
> = {
  a4: { height: 297, width: 210 },
  "half-letter": { height: 215.9, width: 139.7 },
  letter: { height: 279.4, width: 215.9 },
};

const layouts = new Set<PrintLayout>([
  "classic-single-column",
  "classic-two-column",
  "step-linked",
  "landscape-merge-grid",
  "compact-card",
]);
const numberingModes = new Set<PrintNumberingMode>(["modular", "fixed"]);

interface ProfileRow {
  config: string;
  createdAt: string;
  id: string;
  name: string;
  updatedAt: string;
  version: number;
}

interface CollectionRow {
  createdAt: string;
  description: string;
  globalLayout: PrintLayout;
  id: string;
  name: string;
  numberingMode: PrintNumberingMode;
  outline: string;
  profileId: string | null;
  updatedAt: string;
  version: number;
}

interface JobRow {
  artifactChecksum: string | null;
  artifactMimeType: string | null;
  artifactPageCount: number | null;
  artifactRelativePath: string | null;
  artifactSizeBytes: number | null;
  collectionId: string | null;
  createdAt: string;
  errorCode: string | null;
  id: string;
  profileId: string | null;
  request: string;
  requestHash: string;
  status: PrintJobStatus;
  updatedAt: string;
  version: number;
}

export class PrintingService {
  private readonly policy = new AuthorizationPolicy();
  private readonly printRoot: string;

  constructor(
    private readonly sqlite: Database.Database,
    private readonly recipeAccess: RecipeAccessService,
    printRoot: string,
  ) {
    const requestedRoot = resolve(printRoot);
    mkdirSync(requestedRoot, { recursive: true });
    this.printRoot = realpathSync(requestedRoot);
  }

  createProfile(
    principal: Principal,
    input: CreatePrintProfileInput,
    now = new Date(),
  ): PrintProfile {
    const userId = this.userId(principal);
    const profile: PrintProfile = {
      config: normalizeProfileConfig(input.config),
      createdAt: now.toISOString(),
      id: randomUUID(),
      name: requiredText(input.name, 120, "Profile name"),
      updatedAt: now.toISOString(),
      version: 1,
    };
    this.sqlite
      .prepare(
        `INSERT INTO print_profiles
         (id, user_id, name, config, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        profile.id,
        userId,
        profile.name,
        JSON.stringify(profile.config),
        profile.createdAt,
        profile.updatedAt,
      );
    return profile;
  }

  getProfile(principal: Principal, profileId: string): PrintProfile {
    return this.profileFor(this.userId(principal), profileId);
  }

  listProfiles(principal: Principal): PrintProfile[] {
    const userId = this.userId(principal);
    const rows = this.sqlite
      .prepare(
        `SELECT id, name, config, version,
          created_at AS createdAt, updated_at AS updatedAt
         FROM print_profiles WHERE user_id = ?
         ORDER BY name COLLATE NOCASE, id`,
      )
      .all(userId) as ProfileRow[];
    return rows.map(toProfile);
  }

  updateProfile(
    principal: Principal,
    profileId: string,
    input: UpdatePrintProfileInput,
    options: { expectedVersion: number; now?: Date },
  ): PrintProfile {
    const userId = this.userId(principal);
    const current = this.profileFor(userId, profileId);
    if (current.version !== options.expectedVersion) {
      throw new PrintVersionConflictError(
        options.expectedVersion,
        current.version,
      );
    }
    const result = this.sqlite
      .prepare(
        `UPDATE print_profiles SET name = ?, config = ?,
          version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND version = ?`,
      )
      .run(
        input.name === undefined
          ? current.name
          : requiredText(input.name, 120, "Profile name"),
        JSON.stringify(
          input.config === undefined
            ? current.config
            : normalizeProfileConfig(input.config),
        ),
        (options.now ?? new Date()).toISOString(),
        profileId,
        userId,
        options.expectedVersion,
      );
    if (result.changes !== 1) {
      throw new PrintVersionConflictError(
        options.expectedVersion,
        this.profileFor(userId, profileId).version,
      );
    }
    return this.profileFor(userId, profileId);
  }

  createCollection(
    principal: Principal,
    input: CreatePrintCollectionInput,
    now = new Date(),
  ): PrintCollection {
    const userId = this.userId(principal);
    const profileId = input.profileId
      ? this.profileFor(userId, input.profileId).id
      : undefined;
    const collection: PrintCollection = {
      createdAt: now.toISOString(),
      description: optionalText(input.description ?? "", 1_000, "Description"),
      globalLayout: validLayout(input.globalLayout),
      id: randomUUID(),
      name: requiredText(input.name, 120, "Collection name"),
      numberingMode: validNumberingMode(input.numberingMode ?? "modular"),
      outline: this.normalizeOutline(principal, input.outline ?? []),
      ...(profileId ? { profileId } : {}),
      updatedAt: now.toISOString(),
      version: 1,
    };
    this.sqlite
      .prepare(
        `INSERT INTO print_collections
         (id, user_id, profile_id, name, description, global_layout,
          numbering_mode, outline, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        collection.id,
        userId,
        collection.profileId ?? null,
        collection.name,
        collection.description,
        collection.globalLayout,
        collection.numberingMode,
        JSON.stringify(collection.outline),
        collection.createdAt,
        collection.updatedAt,
      );
    return collection;
  }

  getCollection(principal: Principal, collectionId: string): PrintCollection {
    const collection = this.collectionFor(this.userId(principal), collectionId);
    return {
      ...collection,
      outline: this.normalizeOutline(principal, collection.outline),
    };
  }

  listCollections(principal: Principal): PrintCollection[] {
    const userId = this.userId(principal);
    const rows = this.sqlite
      .prepare(
        `SELECT id, profile_id AS profileId, name, description,
          global_layout AS globalLayout, numbering_mode AS numberingMode,
          outline, version, created_at AS createdAt, updated_at AS updatedAt
         FROM print_collections WHERE user_id = ?
         ORDER BY name COLLATE NOCASE, id`,
      )
      .all(userId) as CollectionRow[];
    return rows.map((row) => {
      const collection = toCollection(row);
      return {
        ...collection,
        outline: this.normalizeOutline(principal, collection.outline),
      };
    });
  }

  duplicateCollection(
    principal: Principal,
    collectionId: string,
    input: { name?: string } = {},
    now = new Date(),
  ): PrintCollection {
    const source = this.getCollection(principal, collectionId);
    const name = requiredText(
      input.name ?? `${source.name} copy`,
      120,
      "Collection name",
    );
    const outline = source.outline.map((item) => ({
      ...item,
      id: randomUUID(),
      ...(item.type === "cover" ? { title: name } : {}),
    }));
    return this.createCollection(
      principal,
      {
        description: source.description,
        globalLayout: source.globalLayout,
        name,
        numberingMode: source.numberingMode,
        outline,
        ...(source.profileId ? { profileId: source.profileId } : {}),
      },
      now,
    );
  }

  deleteCollection(
    principal: Principal,
    collectionId: string,
    options: { expectedVersion: number },
  ): PrintCollection {
    const userId = this.userId(principal);
    const current = this.getCollection(principal, collectionId);
    if (current.version !== options.expectedVersion) {
      throw new PrintVersionConflictError(
        options.expectedVersion,
        current.version,
      );
    }
    const result = this.sqlite
      .prepare(
        `DELETE FROM print_collections
         WHERE id = ? AND user_id = ? AND version = ?`,
      )
      .run(collectionId, userId, options.expectedVersion);
    if (result.changes !== 1) {
      throw new PrintVersionConflictError(
        options.expectedVersion,
        this.collectionFor(userId, collectionId).version,
      );
    }
    return current;
  }

  updateCollection(
    principal: Principal,
    collectionId: string,
    input: UpdatePrintCollectionInput,
    options: { expectedVersion: number; now?: Date },
  ): PrintCollection {
    const userId = this.userId(principal);
    const current = this.getCollection(principal, collectionId);
    if (current.version !== options.expectedVersion) {
      throw new PrintVersionConflictError(
        options.expectedVersion,
        current.version,
      );
    }
    let profileId = current.profileId;
    if (input.profileId === null) profileId = undefined;
    if (input.profileId !== undefined && input.profileId !== null) {
      profileId = this.profileFor(userId, input.profileId).id;
    }
    const outline =
      input.outline === undefined
        ? current.outline
        : this.normalizeOutline(principal, input.outline);
    const result = this.sqlite
      .prepare(
        `UPDATE print_collections SET profile_id = ?, name = ?,
          description = ?, global_layout = ?, numbering_mode = ?, outline = ?,
          version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND version = ?`,
      )
      .run(
        profileId ?? null,
        input.name === undefined
          ? current.name
          : requiredText(input.name, 120, "Collection name"),
        input.description === undefined
          ? current.description
          : optionalText(input.description, 1_000, "Description"),
        input.globalLayout === undefined
          ? current.globalLayout
          : validLayout(input.globalLayout),
        input.numberingMode === undefined
          ? current.numberingMode
          : validNumberingMode(input.numberingMode),
        JSON.stringify(outline),
        (options.now ?? new Date()).toISOString(),
        collectionId,
        userId,
        options.expectedVersion,
      );
    if (result.changes !== 1) {
      throw new PrintVersionConflictError(
        options.expectedVersion,
        this.collectionFor(userId, collectionId).version,
      );
    }
    return this.getCollection(principal, collectionId);
  }

  reorderCollection(
    principal: Principal,
    collectionId: string,
    itemIds: readonly string[],
    options: { expectedVersion: number; now?: Date },
  ): PrintCollection {
    const current = this.getCollection(principal, collectionId);
    if (
      itemIds.length !== current.outline.length ||
      new Set(itemIds).size !== itemIds.length
    ) {
      throw new Error("Reorder must contain every outline item exactly once");
    }
    const items = new Map(current.outline.map((item) => [item.id, item]));
    const outline = itemIds.map((id) => {
      const item = items.get(id);
      if (!item) throw new Error("Reorder contains an unknown outline item");
      return item;
    });
    return this.updateCollection(principal, collectionId, { outline }, options);
  }

  createPrintJob(
    principal: Principal,
    input: CreatePrintJobInput,
    now = new Date(),
  ): PrintJob {
    const userId = this.userId(principal);
    const idempotencyKey = validIdempotencyKey(input.idempotencyKey);
    const collection = input.collectionId
      ? this.getCollection(principal, input.collectionId)
      : undefined;
    if (collection && input.selections !== undefined) {
      throw new Error(
        "A print job cannot mix a collection with direct selections",
      );
    }
    const profileId = input.profileId ?? collection?.profileId;
    if (!profileId) throw new Error("A print profile is required");
    const profile = this.profileFor(userId, profileId);
    const globalLayout = validLayout(
      input.globalLayout ??
        collection?.globalLayout ??
        profile.config.defaultLayout,
    );
    const numberingMode = validNumberingMode(
      input.numberingMode ?? collection?.numberingMode ?? "modular",
    );
    const selectionInputs = collection
      ? collection.outline
          .filter(
            (item): item is Extract<PrintOutlineItem, { type: "recipe" }> =>
              item.type === "recipe",
          )
          .map((item) => ({
            ...(item.layoutOverride
              ? { layoutOverride: item.layoutOverride }
              : {}),
            recipeId: item.recipeId,
            ...(item.targetServings
              ? { targetServings: item.targetServings }
              : {}),
          }))
      : [...(input.selections ?? [])];
    if (!collection && selectionInputs.length === 0) {
      throw new Error("A direct print job requires at least one recipe");
    }
    const selections = selectionInputs.map((selection) =>
      this.selection(principal, selection, globalLayout),
    );
    const request: PrintJobRequest = {
      ...(collection ? { collection } : {}),
      globalLayout,
      numberingMode,
      profile,
      selections,
    };
    const requestHash = hash(stableStringify(request));
    const previous = this.sqlite
      .prepare(
        `SELECT id, profile_id AS profileId, collection_id AS collectionId,
          status, request, request_hash AS requestHash, version,
          artifact_relative_path AS artifactRelativePath,
          artifact_checksum AS artifactChecksum,
          artifact_size_bytes AS artifactSizeBytes,
          artifact_mime_type AS artifactMimeType,
          artifact_page_count AS artifactPageCount, error_code AS errorCode,
          created_at AS createdAt, updated_at AS updatedAt
         FROM print_jobs WHERE user_id = ? AND idempotency_key = ?`,
      )
      .get(userId, idempotencyKey) as JobRow | undefined;
    if (previous) {
      if (previous.requestHash !== requestHash) {
        throw new PrintIdempotencyConflictError(idempotencyKey);
      }
      return toJob(previous);
    }
    const id = randomUUID();
    const timestamp = now.toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO print_jobs
         (id, user_id, profile_id, collection_id, idempotency_key,
          request, request_hash, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?)`,
      )
      .run(
        id,
        userId,
        profile.id,
        collection?.id ?? null,
        idempotencyKey,
        JSON.stringify(request),
        requestHash,
        timestamp,
        timestamp,
      );
    return this.jobFor(principal, id);
  }

  getPrintJob(principal: Principal, jobId: string): PrintJob {
    return toJob(this.jobRow(principal, jobId));
  }

  listPrintJobs(principal: Principal, limit = 50): PrintJob[] {
    const userId = this.userId(principal);
    const rows = this.sqlite
      .prepare(
        `${jobSelect()} WHERE user_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(userId, validLimit(limit)) as JobRow[];
    return rows.map(toJob);
  }

  markPrintJobRendering(
    principal: Principal,
    jobId: string,
    options: { expectedVersion: number; now?: Date },
  ): PrintJob {
    return this.transitionJob(
      principal,
      jobId,
      options.expectedVersion,
      ["queued"],
      "rendering",
      undefined,
      options.now ?? new Date(),
    );
  }

  completePrintJob(
    principal: Principal,
    jobId: string,
    input: {
      artifactRelativePath: string;
      expectedVersion: number;
      pageCount: number;
    },
    now = new Date(),
  ): PrintJob {
    const current = this.jobRow(principal, jobId);
    assertJobVersion(current, input.expectedVersion);
    if (current.status !== "rendering") {
      throw new Error("Only a rendering print job can be completed");
    }
    if (!Number.isInteger(input.pageCount) || input.pageCount < 1) {
      throw new Error("Artifact page count must be a positive whole number");
    }
    const relativePath = normalizedArtifactRelativePath(
      input.artifactRelativePath,
    );
    const absolutePath = this.resolveArtifactPath(relativePath);
    const realArtifactPath = realpathSync(absolutePath);
    const realRelation = relative(this.printRoot, realArtifactPath);
    if (
      realRelation === ".." ||
      realRelation.startsWith(`..${sep}`) ||
      isAbsolute(realRelation)
    ) {
      throw new Error("Print artifact path is outside the print data root");
    }
    const file = statSync(realArtifactPath);
    if (!file.isFile() || file.size < 1) {
      throw new Error("Print artifact must be a non-empty file");
    }
    const contents = readFileSync(realArtifactPath);
    if (contents.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new Error("Print artifact is not a PDF file");
    }
    const checksumSha256 = hash(contents);
    const result = this.sqlite
      .prepare(
        `UPDATE print_jobs SET status = 'completed',
          artifact_relative_path = ?, artifact_checksum = ?,
          artifact_size_bytes = ?, artifact_mime_type = 'application/pdf',
          artifact_page_count = ?, error_code = NULL,
          version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .run(
        relativePath,
        checksumSha256,
        file.size,
        input.pageCount,
        now.toISOString(),
        jobId,
        input.expectedVersion,
      );
    if (result.changes !== 1) {
      throw new PrintVersionConflictError(
        input.expectedVersion,
        this.jobRow(principal, jobId).version,
      );
    }
    return this.getPrintJob(principal, jobId);
  }

  failPrintJob(
    principal: Principal,
    jobId: string,
    input: { errorCode: string; expectedVersion: number },
    now = new Date(),
  ): PrintJob {
    return this.transitionJob(
      principal,
      jobId,
      input.expectedVersion,
      ["queued", "rendering"],
      "failed",
      requiredText(input.errorCode, 120, "Print error code"),
      now,
    );
  }

  suggestedArtifactRelativePath(jobId: string): string {
    return `jobs/${validIdentifier(jobId, "Print job identifier")}.pdf`;
  }

  resolveArtifactPath(relativePath: string): string {
    const normalized = normalizedArtifactRelativePath(relativePath);
    const candidate = resolve(this.printRoot, normalized);
    const relation = relative(this.printRoot, candidate);
    if (
      !relation ||
      relation === ".." ||
      relation.startsWith(`..${sep}`) ||
      isAbsolute(relation)
    ) {
      throw new Error("Print artifact path is outside the print data root");
    }
    return candidate;
  }

  private selection(
    principal: Principal,
    input: PrintRecipeSelectionInput,
    globalLayout: PrintLayout,
  ): PrintRecipeSelection {
    const recipe = this.recipeAccess.get(principal, input.recipeId);
    const targetServings = input.targetServings ?? recipe.baseYield;
    if (
      !Number.isFinite(targetServings) ||
      targetServings <= 0 ||
      targetServings > 10_000
    ) {
      throw new Error("Recipe serving target must be between 0 and 10000");
    }
    return {
      layout: input.layoutOverride
        ? validLayout(input.layoutOverride)
        : globalLayout,
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      targetServings,
    };
  }

  private normalizeOutline(
    principal: Principal,
    input: readonly PrintOutlineItem[],
  ): PrintOutlineItem[] {
    if (input.length > 500) throw new Error("Print outline is too large");
    const ids = new Set<string>();
    let covers = 0;
    return input.map((item) => {
      const id = validIdentifier(item.id, "Outline item identifier");
      if (ids.has(id))
        throw new Error("Outline item identifiers must be unique");
      ids.add(id);
      switch (item.type) {
        case "cover":
          covers += 1;
          if (covers > 1)
            throw new Error("A print collection can have only one cover");
          return {
            id,
            ...(item.subtitle
              ? { subtitle: optionalText(item.subtitle, 500, "Cover subtitle") }
              : {}),
            title: requiredText(item.title, 200, "Cover title"),
            type: "cover",
          };
        case "divider":
        case "section":
          return {
            id,
            ...(item.subtitle
              ? {
                  subtitle: optionalText(
                    item.subtitle,
                    500,
                    "Divider subtitle",
                  ),
                }
              : {}),
            title: requiredText(item.title, 200, "Section or divider title"),
            type: item.type,
          };
        case "notes":
          if (
            !Number.isInteger(item.lines) ||
            item.lines < 1 ||
            item.lines > 100
          ) {
            throw new Error("Notes pages require 1 through 100 lines");
          }
          return {
            ...(item.heading
              ? { heading: optionalText(item.heading, 200, "Notes heading") }
              : {}),
            id,
            lines: item.lines,
            type: "notes",
          };
        case "recipe": {
          const recipe = this.recipeAccess.get(principal, item.recipeId);
          if (
            item.targetServings !== undefined &&
            (!Number.isFinite(item.targetServings) ||
              item.targetServings <= 0 ||
              item.targetServings > 10_000)
          ) {
            throw new Error(
              "Recipe serving target must be between 0 and 10000",
            );
          }
          return {
            id,
            ...(item.layoutOverride
              ? { layoutOverride: validLayout(item.layoutOverride) }
              : {}),
            recipeId: recipe.id,
            ...(item.targetServings === undefined
              ? {}
              : { targetServings: item.targetServings }),
            type: "recipe",
          };
        }
      }
    });
  }

  private profileFor(userId: string, profileId: string): PrintProfile {
    const row = this.sqlite
      .prepare(
        `SELECT id, name, config, version,
          created_at AS createdAt, updated_at AS updatedAt
         FROM print_profiles WHERE id = ? AND user_id = ?`,
      )
      .get(profileId, userId) as ProfileRow | undefined;
    if (!row) throw new Error("Print profile not found");
    return toProfile(row);
  }

  private collectionFor(userId: string, collectionId: string): PrintCollection {
    const row = this.sqlite
      .prepare(
        `SELECT id, profile_id AS profileId, name, description,
          global_layout AS globalLayout, numbering_mode AS numberingMode,
          outline, version, created_at AS createdAt, updated_at AS updatedAt
         FROM print_collections WHERE id = ? AND user_id = ?`,
      )
      .get(collectionId, userId) as CollectionRow | undefined;
    if (!row) throw new Error("Print collection not found");
    return toCollection(row);
  }

  private jobFor(principal: Principal, jobId: string): PrintJob {
    return toJob(this.jobRow(principal, jobId));
  }

  private jobRow(principal: Principal, jobId: string): JobRow {
    const userId = this.jobUserId(principal);
    const row = userId
      ? (this.sqlite
          .prepare(`${jobSelect()} WHERE id = ? AND user_id = ?`)
          .get(jobId, userId) as JobRow | undefined)
      : (this.sqlite.prepare(`${jobSelect()} WHERE id = ?`).get(jobId) as
          JobRow | undefined);
    if (!row) throw new Error("Print job not found");
    return row;
  }

  private transitionJob(
    principal: Principal,
    jobId: string,
    expectedVersion: number,
    from: readonly PrintJobStatus[],
    to: PrintJobStatus,
    errorCode: string | undefined,
    now: Date,
  ): PrintJob {
    const current = this.jobRow(principal, jobId);
    assertJobVersion(current, expectedVersion);
    if (!from.includes(current.status)) {
      throw new Error(`Print job cannot move from ${current.status} to ${to}`);
    }
    const result = this.sqlite
      .prepare(
        `UPDATE print_jobs SET status = ?, error_code = ?,
          version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .run(to, errorCode ?? null, now.toISOString(), jobId, expectedVersion);
    if (result.changes !== 1) {
      throw new PrintVersionConflictError(
        expectedVersion,
        this.jobRow(principal, jobId).version,
      );
    }
    return this.getPrintJob(principal, jobId);
  }

  private userId(principal: Principal): string {
    this.policy.require(principal, "user-data:manage");
    if (principal.kind !== "user") {
      throw new AuthorizationError(
        "Private print data requires a user account",
      );
    }
    return principal.userId;
  }

  private jobUserId(principal: Principal): string | undefined {
    this.policy.require(principal, "user-data:manage");
    if (principal.kind === "system") return undefined;
    if (principal.kind !== "user") {
      throw new AuthorizationError(
        "Private print data requires a user account",
      );
    }
    return principal.userId;
  }
}

function normalizeProfileConfig(input: PrintProfileConfig): PrintProfileConfig {
  const pageSize = validPageSize(input.pageSize);
  const dimensions = PRINT_PAGE_DIMENSIONS_MM[pageSize];
  const margins = { ...input.marginsMm };
  for (const [name, value] of Object.entries(margins)) {
    if (!Number.isFinite(value) || value < 5 || value > 50) {
      throw new Error(`${name} margin must be between 5 and 50 mm`);
    }
  }
  if (
    margins.left + margins.right >= dimensions.width - 80 ||
    margins.top + margins.bottom >= dimensions.height - 100
  ) {
    throw new Error("Print margins leave too little usable page area");
  }
  const bodyFontSizePt = input.typography.bodyFontSizePt;
  const headingFontSizePt = input.typography.headingFontSizePt;
  if (
    !Number.isFinite(bodyFontSizePt) ||
    bodyFontSizePt < 6 ||
    bodyFontSizePt > 18
  ) {
    throw new Error("Body font size must be between 6 and 18 points");
  }
  if (
    !Number.isFinite(headingFontSizePt) ||
    headingFontSizePt < 10 ||
    headingFontSizePt > 40 ||
    headingFontSizePt < bodyFontSizePt
  ) {
    throw new Error("Heading font size must be between 10 and 40 points");
  }
  if (
    typeof input.duplex !== "boolean" ||
    typeof input.includeMetadata !== "boolean" ||
    typeof input.includePhotos !== "boolean"
  ) {
    throw new Error(
      "Duplex, photo, and metadata profile options must be boolean",
    );
  }
  return {
    colorMode:
      input.colorMode === "black-and-white" ? "black-and-white" : "color",
    defaultLayout: validLayout(input.defaultLayout),
    duplex: input.duplex,
    includeMetadata: input.includeMetadata,
    includePhotos: input.includePhotos,
    marginsMm: margins,
    pageSize,
    typography: {
      bodyFontSizePt,
      fontFamily: requiredText(input.typography.fontFamily, 100, "Font family"),
      headingFontSizePt,
    },
    visualStyle:
      input.visualStyle === "minimal" || input.visualStyle === "modern"
        ? input.visualStyle
        : "heirloom",
  };
}

function toProfile(row: ProfileRow): PrintProfile {
  return {
    config: normalizeProfileConfig(
      JSON.parse(row.config) as PrintProfileConfig,
    ),
    createdAt: row.createdAt,
    id: row.id,
    name: row.name,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

function toCollection(row: CollectionRow): PrintCollection {
  const outline = JSON.parse(row.outline) as PrintOutlineItem[];
  if (!Array.isArray(outline))
    throw new Error("Stored print outline is invalid");
  return {
    createdAt: row.createdAt,
    description: row.description,
    globalLayout: validLayout(row.globalLayout),
    id: row.id,
    name: row.name,
    numberingMode: validNumberingMode(row.numberingMode),
    outline,
    ...(row.profileId ? { profileId: row.profileId } : {}),
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

function toJob(row: JobRow): PrintJob {
  const artifact = artifactFrom(row);
  return {
    ...(artifact ? { artifact } : {}),
    ...(row.collectionId ? { collectionId: row.collectionId } : {}),
    createdAt: row.createdAt,
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    id: row.id,
    ...(row.profileId ? { profileId: row.profileId } : {}),
    request: JSON.parse(row.request) as PrintJobRequest,
    status: row.status,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

function artifactFrom(row: JobRow): PrintArtifactMetadata | undefined {
  if (
    !row.artifactChecksum ||
    !row.artifactMimeType ||
    !row.artifactPageCount ||
    !row.artifactRelativePath ||
    !row.artifactSizeBytes
  ) {
    return undefined;
  }
  if (row.artifactMimeType !== "application/pdf") {
    throw new Error("Stored print artifact MIME type is invalid");
  }
  return {
    checksumSha256: row.artifactChecksum,
    mimeType: "application/pdf",
    pageCount: row.artifactPageCount,
    relativePath: row.artifactRelativePath,
    sizeBytes: row.artifactSizeBytes,
  };
}

function jobSelect(): string {
  return `SELECT id, profile_id AS profileId, collection_id AS collectionId,
    status, request, request_hash AS requestHash, version,
    artifact_relative_path AS artifactRelativePath,
    artifact_checksum AS artifactChecksum,
    artifact_size_bytes AS artifactSizeBytes,
    artifact_mime_type AS artifactMimeType,
    artifact_page_count AS artifactPageCount, error_code AS errorCode,
    created_at AS createdAt, updated_at AS updatedAt FROM print_jobs`;
}

function assertJobVersion(row: JobRow, expectedVersion: number): void {
  if (row.version !== expectedVersion) {
    throw new PrintVersionConflictError(expectedVersion, row.version);
  }
}

function validLayout(value: PrintLayout): PrintLayout {
  if (!layouts.has(value)) throw new Error("Unknown print layout");
  return value;
}

function validNumberingMode(value: PrintNumberingMode): PrintNumberingMode {
  if (!numberingModes.has(value)) throw new Error("Unknown numbering mode");
  return value;
}

function validPageSize(value: PrintPageSize): PrintPageSize {
  if (!Object.hasOwn(PRINT_PAGE_DIMENSIONS_MM, value)) {
    throw new Error("Print page size must be Letter, A4, or Half-Letter");
  }
  return value;
}

function requiredText(value: string, maximum: number, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(
      `${label} is required and must be at most ${maximum} characters`,
    );
  }
  return normalized;
}

function optionalText(value: string, maximum: number, label: string): string {
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new Error(`${label} must be at most ${maximum} characters`);
  }
  return normalized;
}

function validIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function validIdempotencyKey(value: string): string {
  return validIdentifier(value, "Print idempotency key");
}

function validLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("List limit must be a whole number from 1 through 100");
  }
  return value;
}

function normalizedArtifactRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").trim();
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    !normalized.toLowerCase().endsWith(".pdf")
  ) {
    throw new Error("Print artifact must be a relative PDF path");
  }
  return normalized;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
