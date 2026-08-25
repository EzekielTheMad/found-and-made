import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import type Database from "better-sqlite3";

import { AuthorizationError, type Principal } from "../identity/identity.types";
import type { MediaService } from "../media/media.service.server";
import type { MediaAsset, MediaVariant } from "../media/media.types";
import { projectRecipe } from "../recipes/recipe.projections";
import type { UnitPreference } from "../recipes/recipe.scaling";
import type { RecipeAccessService } from "../recipes/recipe-access.service.server";
import {
  EXPORT_FORMAT_VERSION,
  LIBRARY_EXPORT_SCHEMA,
  LIBRARY_STATE_SCHEMA,
  RECIPE_EXPORT_SCHEMA,
  type ExportFileDescriptor,
  type ExportMediaReference,
  type LibraryExportManifestV1,
  type LibraryExportResult,
  type LibraryStateV1,
  type LibraryExportVerification,
  type RecipeExportV1,
  type RecipeJsonExportResult,
} from "./export.types";

const ARTIFACT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIBRARY_ARTIFACT = /^library-([0-9a-f-]{36})$/i;
const VARIANTS: readonly MediaVariant[] = ["original", "social", "web"];
const LIBRARY_STATE_TABLES = [
  ["recipeRevisions", "recipe_revisions", ["snapshot"]],
  ["recipePublications", "recipe_publications", []],
  ["categoryGroups", "facet_groups", []],
  ["categories", "facet_terms", []],
  ["categoryAliases", "facet_term_aliases", []],
  ["recipeCategories", "recipe_terms", []],
  ["labels", "labels", []],
  ["recipeLabels", "recipe_labels", []],
  ["collections", "collections", []],
  ["collectionPublications", "collection_publications", []],
  ["collectionRecipes", "collection_recipes", []],
  ["savedViews", "saved_views", ["criteria"]],
  ["defaultViews", "user_default_views", []],
  ["homeSections", "home_sections", ["config"]],
  ["personalRecipeStates", "personal_recipe_states", []],
  ["personalAdjustments", "personal_adjustments", []],
  ["cookingHistory", "cooking_history", []],
  ["cookingSessions", "cooking_sessions", ["checked_ingredient_ids", "timers"]],
  ["printProfiles", "print_profiles", ["config"]],
  ["printCollections", "print_collections", ["outline"]],
  ["mcpRecipeApprovals", "mcp_recipe_approvals", []],
] as const;

interface ExportServiceOptions {
  readonly createId?: () => string;
  readonly now?: () => Date;
}

interface RecipeExportOptions {
  readonly now?: Date;
  readonly targetYield?: number;
  readonly unitPreference?: UnitPreference;
}

interface LibraryExportOptions {
  readonly now?: Date;
  readonly unitPreference?: UnitPreference;
}

export class ExportService {
  private readonly createId: () => string;
  private readonly exportsRoot: string;
  private readonly now: () => Date;

  constructor(
    private readonly recipeAccess: RecipeAccessService,
    private readonly media: MediaService,
    private readonly sqlite: Database.Database,
    exportsRoot: string,
    options: ExportServiceOptions = {},
  ) {
    this.exportsRoot = validateExportsRoot(exportsRoot);
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  exportRecipeJson(
    principal: Principal,
    recipeId: string,
    options: RecipeExportOptions = {},
  ): RecipeJsonExportResult {
    const dto = this.recipeDto(
      principal,
      recipeId,
      options.targetYield,
      options.unitPreference ?? "as-written",
      options.now ?? this.now(),
    );
    const bytes = Buffer.from(stableJson(dto));
    const artifactName = `recipe-${this.opaqueId()}.json`;
    return {
      artifactName,
      dto,
      sha256: checksum(bytes),
      size: bytes.byteLength,
    };
  }

  async exportLibrary(
    principal: Principal,
    options: LibraryExportOptions = {},
  ): Promise<LibraryExportResult> {
    requireOwner(principal);
    await mkdir(this.exportsRoot, { recursive: true, mode: 0o700 });
    const artifactName = `library-${this.opaqueId()}`;
    const finalPath = join(this.exportsRoot, artifactName);
    const stagingName = `.staging-${this.opaqueId()}`;
    const stagingPath = join(this.exportsRoot, stagingName);
    const exportedAt = (options.now ?? this.now()).toISOString();
    const unitPreference = options.unitPreference ?? "as-written";
    const files: ExportFileDescriptor[] = [];
    const recipes: LibraryExportManifestV1["recipes"][number][] = [];

    await mkdir(join(stagingPath, "recipes"), { recursive: true, mode: 0o700 });
    await mkdir(join(stagingPath, "media"), { recursive: true, mode: 0o700 });
    try {
      const summaries = [...this.recipeAccess.list(principal, true)].sort(
        (left, right) => left.id.localeCompare(right.id),
      );
      for (const summary of summaries) {
        const assets = [...this.media.list(principal, summary.id)].sort(
          compareMedia,
        );
        const mediaReferences = await this.copyMedia(
          stagingPath,
          summary.id,
          assets,
          files,
        );
        const dto = this.recipeDto(
          principal,
          summary.id,
          undefined,
          unitPreference,
          new Date(exportedAt),
          mediaReferences,
          true,
        );
        const recipePath = `recipes/r-${opaqueToken(summary.id)}.json`;
        const bytes = Buffer.from(stableJson(dto));
        await writeRelative(stagingPath, recipePath, bytes);
        files.push(descriptor("recipe", recipePath, summary.id, bytes));
        recipes.push({
          mediaIds: assets.map((asset) => asset.id).sort(),
          path: recipePath,
          recipeId: summary.id,
        });
      }

      const libraryState = this.libraryState(exportedAt);
      const libraryStatePath = "library-state.json";
      const libraryStateBytes = Buffer.from(stableJson(libraryState));
      await writeRelative(stagingPath, libraryStatePath, libraryStateBytes);
      files.push(
        descriptor("library", libraryStatePath, undefined, libraryStateBytes),
      );

      files.sort((left, right) => left.path.localeCompare(right.path));
      recipes.sort((left, right) =>
        left.recipeId.localeCompare(right.recipeId),
      );
      const manifest: LibraryExportManifestV1 = {
        exportedAt,
        files,
        libraryState: {
          path: libraryStatePath,
          recordCount:
            libraryState.contributors.length +
            Object.values(libraryState.records).reduce(
              (total, records) => total + records.length,
              0,
            ),
        },
        recipeCount: recipes.length,
        recipes,
        schema: LIBRARY_EXPORT_SCHEMA,
        version: EXPORT_FORMAT_VERSION,
      };
      const manifestBytes = Buffer.from(stableJson(manifest));
      await writeRelative(stagingPath, "manifest.json", manifestBytes);
      await rename(stagingPath, finalPath);
      return {
        artifactName,
        fileCount: files.length + 1,
        manifest: {
          path: "manifest.json",
          sha256: checksum(manifestBytes),
          size: manifestBytes.byteLength,
        },
      };
    } catch (error) {
      await rm(stagingPath, { force: true, recursive: true });
      throw error;
    }
  }

  async verifyLibraryExport(
    principal: Principal,
    artifactName: string,
    expectedManifestSha256?: string,
  ): Promise<LibraryExportVerification> {
    requireOwner(principal);
    if (!LIBRARY_ARTIFACT.test(artifactName)) {
      throw new Error("Library export artifact name is invalid");
    }
    const artifactPath = safeChild(this.exportsRoot, artifactName);
    const errors: string[] = [];
    let manifest: LibraryExportManifestV1;
    try {
      const manifestPath = join(artifactPath, "manifest.json");
      const manifestInfo = await lstat(manifestPath);
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
        throw new Error("Manifest is invalid");
      }
      const manifestBytes = await readFile(manifestPath);
      if (
        expectedManifestSha256 &&
        checksum(manifestBytes) !== expectedManifestSha256
      )
        errors.push("Manifest checksum mismatch");
      manifest = parseManifest(manifestBytes.toString("utf8"));
    } catch {
      return {
        errors: ["Manifest could not be read"],
        filesVerified: 0,
        valid: false,
      };
    }

    const expected = new Set(manifest.files.map((file) => file.path));
    if (expected.size !== manifest.files.length)
      errors.push("Manifest contains duplicate paths");
    let filesVerified = 0;
    for (const file of manifest.files) {
      if (!isSafeRelativePath(file.path)) {
        errors.push(`Unsafe manifest path: ${file.path}`);
        continue;
      }
      try {
        const path = safeChild(artifactPath, file.path);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) {
          errors.push(`Unsupported file: ${file.path}`);
          continue;
        }
        const bytes = await readFile(path);
        if (bytes.byteLength !== file.size)
          errors.push(`Size mismatch: ${file.path}`);
        if (checksum(bytes) !== file.sha256)
          errors.push(`Checksum mismatch: ${file.path}`);
        if (bytes.byteLength === file.size && checksum(bytes) === file.sha256)
          filesVerified += 1;
      } catch {
        errors.push(`Missing file: ${file.path}`);
      }
    }

    const actual = (await listFiles(artifactPath))
      .filter((path) => path !== "manifest.json")
      .sort();
    for (const path of actual)
      if (!expected.has(path)) errors.push(`Unlisted file: ${path}`);
    for (const path of expected)
      if (!actual.includes(path)) errors.push(`Manifest file absent: ${path}`);
    return { errors, filesVerified, valid: errors.length === 0 };
  }

  private recipeDto(
    principal: Principal,
    recipeId: string,
    targetYield: number | undefined,
    unitPreference: UnitPreference,
    now: Date,
    suppliedMedia?: readonly ExportMediaReference[],
    includeDeleted = false,
  ): RecipeExportV1 {
    const recipe = this.recipeAccess.get(principal, recipeId, includeDeleted);
    const projection = projectRecipe(
      recipe,
      targetYield ?? recipe.baseYield,
      unitPreference,
    );
    const media =
      suppliedMedia ??
      this.media
        .list(principal, recipeId)
        .map((asset) => mediaReference(asset, []));
    return {
      exportedAt: now.toISOString(),
      media,
      projection,
      recipe,
      schema: RECIPE_EXPORT_SCHEMA,
      targetYield: projection.targetYield,
      unitPreference,
      version: EXPORT_FORMAT_VERSION,
    };
  }

  private libraryState(exportedAt: string): LibraryStateV1 {
    const contributors = this.sqlite
      .prepare(
        `SELECT u.id, u.name, a.role
         FROM app_users a
         INNER JOIN user u ON u.id = a.user_id
         ORDER BY u.id`,
      )
      .all() as LibraryStateV1["contributors"];
    const records = Object.fromEntries(
      LIBRARY_STATE_TABLES.map(([key, table, jsonColumns]) => [
        key,
        safeRows(this.sqlite, table, jsonColumns),
      ]),
    );
    const publicMode = this.sqlite
      .prepare("SELECT value FROM system_settings WHERE key = 'public_mode'")
      .get() as { value: string } | undefined;
    return {
      contributors,
      exportedAt,
      records,
      schema: LIBRARY_STATE_SCHEMA,
      settings: { publicMode: publicMode?.value === "enabled" },
      version: EXPORT_FORMAT_VERSION,
    };
  }

  private async copyMedia(
    stagingPath: string,
    recipeId: string,
    assets: readonly MediaAsset[],
    files: ExportFileDescriptor[],
  ): Promise<ExportMediaReference[]> {
    const references: ExportMediaReference[] = [];
    for (const asset of assets) {
      const variants: ExportMediaReference["variants"][number][] = [];
      for (const variant of VARIANTS) {
        const source = this.media.file(asset.id, variant);
        if (source.recipeId !== recipeId)
          throw new Error("Media attachment changed during export");
        const bytes = await readFile(source.path);
        if (variant === "original" && checksum(bytes) !== asset.checksum)
          throw new Error(`Original media checksum mismatch for ${asset.id}`);
        const extension = variant === "original" ? "jpg" : "webp";
        const mediaPath = `media/m-${opaqueToken(`${asset.id}:${variant}`)}.${extension}`;
        await writeRelative(stagingPath, mediaPath, bytes);
        files.push(descriptor("media", mediaPath, recipeId, bytes));
        variants.push({
          contentType: source.contentType,
          path: mediaPath,
          variant,
        });
      }
      variants.sort((left, right) => left.variant.localeCompare(right.variant));
      references.push(mediaReference(asset, variants));
    }
    return references;
  }

  private opaqueId(): string {
    const id = this.createId();
    if (!ARTIFACT_ID.test(id))
      throw new Error("Export ID generator returned an invalid opaque ID");
    return id.toLowerCase();
  }
}

function mediaReference(
  asset: MediaAsset,
  variants: ExportMediaReference["variants"],
): ExportMediaReference {
  const { checksum: originalChecksum, ...metadata } = asset;
  return { ...metadata, originalChecksum, variants };
}

function descriptor(
  kind: ExportFileDescriptor["kind"],
  path: string,
  recipeId: string | undefined,
  bytes: Uint8Array,
): ExportFileDescriptor {
  return {
    kind,
    path,
    ...(recipeId ? { recipeId } : {}),
    sha256: checksum(bytes),
    size: bytes.byteLength,
  };
}

function safeRows(
  sqlite: Database.Database,
  table: string,
  jsonColumns: readonly string[],
): Record<string, unknown>[] {
  if (!/^[a-z_]+$/.test(table)) throw new Error("Unsafe export table name");
  const rows = sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<
    string,
    unknown
  >[];
  return rows
    .map((row) => {
      const result = { ...row };
      for (const column of jsonColumns) {
        if (typeof result[column] === "string") {
          result[column] = JSON.parse(result[column]);
        }
      }
      return result;
    })
    .sort((left, right) =>
      JSON.stringify(sortJson(left)).localeCompare(
        JSON.stringify(sortJson(right)),
      ),
    );
}

function compareMedia(left: MediaAsset, right: MediaAsset): number {
  return left.position - right.position || left.id.localeCompare(right.id);
}

function requireOwner(
  principal: Principal,
): asserts principal is Extract<Principal, { kind: "user" }> {
  if (principal.kind !== "user" || principal.role !== "owner")
    throw new AuthorizationError(
      "Complete library exports require the Owner role",
    );
}

function validateExportsRoot(input: string): string {
  const root = resolve(input);
  if (
    !isAbsolute(root) ||
    root === parse(root).root ||
    basename(root).toLowerCase() !== "exports"
  )
    throw new Error("Export root must be a dedicated exports directory");
  return root;
}

function opaqueToken(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  return value;
}

async function writeRelative(
  root: string,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const target = safeChild(root, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
}

function safeChild(root: string, child: string): string {
  const target = resolve(root, child);
  const prefix = `${resolve(root)}${sep}`;
  if (!target.startsWith(prefix))
    throw new Error("Export path escapes the artifact root");
  return target;
}

function isSafeRelativePath(path: string): boolean {
  return (
    Boolean(path) &&
    !isAbsolute(path) &&
    !path.split(/[\\/]/).includes("..") &&
    !path.includes("\\")
  );
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile())
      files.push(relative(root, path).split(sep).join("/"));
    else throw new Error("Export contains an unsupported filesystem entry");
  }
  return files;
}

function parseManifest(text: string): LibraryExportManifestV1 {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("Manifest is invalid");
  const files = value.files;
  const libraryState = value.libraryState;
  const recipes = value.recipes;
  if (
    value.schema !== LIBRARY_EXPORT_SCHEMA ||
    value.version !== EXPORT_FORMAT_VERSION ||
    !Array.isArray(files) ||
    !Array.isArray(recipes) ||
    !isRecord(libraryState) ||
    typeof libraryState.path !== "string" ||
    typeof libraryState.recordCount !== "number" ||
    !Number.isSafeInteger(libraryState.recordCount) ||
    libraryState.recordCount < 0
  )
    throw new Error("Manifest schema or version is unsupported");
  for (const file of files) {
    if (
      !isRecord(file) ||
      typeof file.path !== "string" ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    )
      throw new Error("Manifest file descriptor is invalid");
  }
  return value as unknown as LibraryExportManifestV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
