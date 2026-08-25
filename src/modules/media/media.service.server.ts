import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type Database from "better-sqlite3";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";

import { AuthorizationPolicy } from "../identity/authorization.policy";
import type { Principal } from "../identity/identity.types";
import type { RecipeService } from "../recipes/recipe.service.server";
import type { DataPaths } from "../../platform/files/data-paths.server";
import type {
  MediaAsset,
  MediaUpdate,
  MediaUpload,
  MediaVariant,
} from "./media.types";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_PIXELS = 50_000_000;
const allowedMimes = new Set(["image/jpeg", "image/png", "image/webp"]);

interface MediaRow extends Omit<MediaAsset, "componentId" | "stepId"> {
  componentId: string | null;
  originalPath: string;
  socialPath: string;
  stepId: string | null;
  webPath: string;
}

export class MediaService {
  private readonly policy = new AuthorizationPolicy();

  constructor(
    private readonly sqlite: Database.Database,
    private readonly paths: DataPaths,
    private readonly recipes: RecipeService,
  ) {}

  async upload(
    principal: Principal,
    input: MediaUpload,
    now = new Date(),
  ): Promise<MediaAsset> {
    this.policy.require(principal, "recipe:edit");
    validateUpload(input);
    const recipe = this.recipes.get(input.recipeId);
    validateAttachment(input, recipe);
    const bytes = Buffer.from(input.bytes);
    const detected = await fileTypeFromBuffer(bytes);
    if (!detected || !allowedMimes.has(detected.mime)) {
      throw new Error("Only JPEG, PNG, and WebP image uploads are allowed");
    }

    const source = sharp(bytes, {
      animated: false,
      failOn: "warning",
      limitInputPixels: MAX_INPUT_PIXELS,
    }).timeout({ seconds: 10 });
    const metadata = await source.metadata();
    if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) {
      throw new Error("Image must be a single decodable frame");
    }

    const original = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
      .autoOrient()
      .jpeg({ chromaSubsampling: "4:4:4", quality: 95 })
      .timeout({ seconds: 10 })
      .toBuffer();
    const sanitizedMetadata = await sharp(original).metadata();
    const web = await sharp(original)
      .resize({
        fit: "inside",
        height: 1600,
        width: 1600,
        withoutEnlargement: true,
      })
      .webp({ effort: 4, quality: 82 })
      .timeout({ seconds: 10 })
      .toBuffer();
    const focalX = input.focalX ?? 50;
    const focalY = input.focalY ?? 50;
    const social = await createSocialDerivative(
      original,
      sanitizedMetadata.width,
      sanitizedMetadata.height,
      focalX,
      focalY,
    );

    const id = randomUUID();
    const originalName = `${id}.jpg`;
    const webName = `${id}.webp`;
    const socialName = `${id}-social.webp`;
    const originalPath = join(this.paths.mediaOriginals, originalName);
    const webPath = join(this.paths.mediaWeb, webName);
    const socialPath = join(this.paths.mediaWeb, socialName);
    const existingHero =
      input.role === "hero"
        ? (this.sqlite
            .prepare(
              `SELECT ${columns()} FROM media_assets
               WHERE recipe_id = ? AND role = 'hero' LIMIT 1`,
            )
            .get(input.recipeId) as MediaRow | undefined)
        : undefined;
    const temporary = [
      [`${originalPath}.tmp`, originalPath, original] as const,
      [`${webPath}.tmp`, webPath, web] as const,
      [`${socialPath}.tmp`, socialPath, social] as const,
    ];

    try {
      for (const [temp, , content] of temporary) {
        await writeFile(temp, content, { flag: "wx", mode: 0o600 });
      }
      for (const [temp, target] of temporary) await rename(temp, target);
      const timestamp = now.toISOString();
      this.sqlite
        .transaction(() => {
          if (input.role === "hero") {
            this.sqlite
              .prepare(
                "DELETE FROM media_assets WHERE recipe_id = ? AND role = 'hero'",
              )
              .run(input.recipeId);
          }
          this.sqlite
            .prepare(
              `INSERT INTO media_assets
           (id, recipe_id, role, component_id, step_id, original_path, web_path,
            social_path, checksum, alt_text, caption, position, focal_x, focal_y,
            width, height, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              input.recipeId,
              input.role,
              input.componentId ?? null,
              input.stepId ?? null,
              originalName,
              webName,
              socialName,
              createHash("sha256").update(original).digest("hex"),
              input.altText.trim(),
              input.caption?.trim() ?? "",
              input.position ?? this.nextPosition(input.recipeId),
              focalX,
              focalY,
              sanitizedMetadata.width,
              sanitizedMetadata.height,
              timestamp,
              timestamp,
            );
        })
        .immediate();
    } catch (error) {
      await Promise.all(
        temporary.flatMap(([temp, target]) => [
          safeUnlink(temp),
          safeUnlink(target),
        ]),
      );
      throw error;
    }
    if (existingHero) {
      await Promise.allSettled([
        safeUnlink(join(this.paths.mediaOriginals, existingHero.originalPath)),
        safeUnlink(join(this.paths.mediaWeb, existingHero.webPath)),
        safeUnlink(join(this.paths.mediaWeb, existingHero.socialPath)),
      ]);
    }
    return this.get(principal, id);
  }

  async update(
    principal: Principal,
    id: string,
    input: MediaUpdate,
    now = new Date(),
  ): Promise<MediaAsset> {
    this.policy.require(principal, "recipe:edit");
    validateUpdate(input);
    const row = this.row(id);
    this.recipes.get(row.recipeId);
    const focalChanged =
      row.focalX !== input.focalX || row.focalY !== input.focalY;
    let nextSocialName = row.socialPath;
    let nextSocialPath: string | undefined;

    if (focalChanged) {
      const original = await readFile(
        join(this.paths.mediaOriginals, row.originalPath),
      );
      const social = await createSocialDerivative(
        original,
        row.width,
        row.height,
        input.focalX,
        input.focalY,
      );
      nextSocialName = `${id}-social-${randomUUID()}.webp`;
      nextSocialPath = join(this.paths.mediaWeb, nextSocialName);
      const temporaryPath = `${nextSocialPath}.tmp`;
      try {
        await writeFile(temporaryPath, social, { flag: "wx", mode: 0o600 });
        await rename(temporaryPath, nextSocialPath);
      } catch (error) {
        await Promise.allSettled([
          safeUnlink(temporaryPath),
          safeUnlink(nextSocialPath),
        ]);
        throw error;
      }
    }

    try {
      this.sqlite
        .prepare(
          `UPDATE media_assets
           SET alt_text = ?, caption = ?, position = ?, focal_x = ?, focal_y = ?,
               social_path = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.altText.trim(),
          input.caption?.trim() ?? "",
          input.position,
          input.focalX,
          input.focalY,
          nextSocialName,
          now.toISOString(),
          id,
        );
    } catch (error) {
      if (nextSocialPath) await safeUnlink(nextSocialPath);
      throw error;
    }

    if (focalChanged) {
      await Promise.allSettled([
        safeUnlink(join(this.paths.mediaWeb, row.socialPath)),
      ]);
    }
    return this.get(principal, id);
  }

  async remove(principal: Principal, id: string): Promise<void> {
    this.policy.require(principal, "recipe:edit");
    const row = this.row(id);
    this.recipes.get(row.recipeId);
    const paths = [
      join(this.paths.mediaOriginals, row.originalPath),
      join(this.paths.mediaWeb, row.webPath),
      join(this.paths.mediaWeb, row.socialPath),
    ];
    const quarantine = paths.map((path) => `${path}.delete-${randomUUID()}`);
    const moved: number[] = [];
    try {
      for (const [index, path] of paths.entries()) {
        await rename(path, quarantine[index]);
        moved.push(index);
      }
      this.sqlite.prepare("DELETE FROM media_assets WHERE id = ?").run(id);
    } catch (error) {
      for (const index of moved.reverse()) {
        await rename(quarantine[index], paths[index]).catch(() => undefined);
      }
      throw error;
    }
    await Promise.allSettled(quarantine.map((path) => safeUnlink(path)));
  }

  list(principal: Principal, recipeId: string): MediaAsset[] {
    this.policy.require(principal, "recipe:read");
    return (this.rowsForRecipe(recipeId) as MediaRow[]).map(toAsset);
  }

  get(principal: Principal, id: string): MediaAsset {
    this.policy.require(principal, "recipe:read");
    return toAsset(this.row(id));
  }

  file(
    id: string,
    variant: MediaVariant,
  ): {
    contentType: string;
    path: string;
    recipeId: string;
  } {
    const row = this.row(id);
    const fileName =
      variant === "original"
        ? row.originalPath
        : variant === "social"
          ? row.socialPath
          : row.webPath;
    return {
      contentType: variant === "original" ? "image/jpeg" : "image/webp",
      path: join(
        variant === "original"
          ? this.paths.mediaOriginals
          : this.paths.mediaWeb,
        fileName,
      ),
      recipeId: row.recipeId,
    };
  }

  hero(recipeId: string): MediaAsset | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT ${columns()} FROM media_assets
         WHERE recipe_id = ? AND role = 'hero' LIMIT 1`,
      )
      .get(recipeId) as MediaRow | undefined;
    return row ? toAsset(row) : undefined;
  }

  private row(id: string): MediaRow {
    const row = this.sqlite
      .prepare(`SELECT ${columns()} FROM media_assets WHERE id = ?`)
      .get(id) as MediaRow | undefined;
    if (!row) throw new Error("Media asset not found");
    return row;
  }

  private rowsForRecipe(recipeId: string) {
    return this.sqlite
      .prepare(
        `SELECT ${columns()} FROM media_assets
         WHERE recipe_id = ? ORDER BY position, created_at`,
      )
      .all(recipeId);
  }

  private nextPosition(recipeId: string): number {
    const row = this.sqlite
      .prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM media_assets WHERE recipe_id = ?",
      )
      .get(recipeId) as { position: number };
    return row.position;
  }
}

function validateUpload(input: MediaUpload): void {
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error("Image upload must be between 1 byte and 20 MiB");
  }
  if (!input.altText.trim() || input.altText.trim().length > 300) {
    throw new Error("Alt text is required and must be at most 300 characters");
  }
  if (
    !(["hero", "gallery", "component", "step"] as const).includes(input.role)
  ) {
    throw new Error("Unknown media role");
  }
  for (const value of [input.focalX ?? 50, input.focalY ?? 50]) {
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new Error("Focal coordinates must be integers from 0 through 100");
    }
  }
}

function validateUpdate(input: MediaUpdate): void {
  if (!input.altText.trim() || input.altText.trim().length > 300) {
    throw new Error("Alt text is required and must be at most 300 characters");
  }
  if (!Number.isInteger(input.position) || input.position < 0) {
    throw new Error("Photo position must be a non-negative integer");
  }
  for (const value of [input.focalX, input.focalY]) {
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new Error("Focal coordinates must be integers from 0 through 100");
    }
  }
}

function validateAttachment(
  input: MediaUpload,
  recipe: ReturnType<RecipeService["get"]>,
): void {
  if (
    input.role === "component" &&
    !recipe.components.some((item) => item.id === input.componentId)
  ) {
    throw new Error("Component media must reference a recipe component");
  }
  if (
    input.role === "step" &&
    !recipe.steps.some((item) => item.id === input.stepId)
  ) {
    throw new Error("Step media must reference a recipe step");
  }
}

function columns(): string {
  return `id, recipe_id AS recipeId, role, component_id AS componentId,
    step_id AS stepId, original_path AS originalPath, web_path AS webPath,
    social_path AS socialPath, checksum, alt_text AS altText, caption,
    position, focal_x AS focalX, focal_y AS focalY, width, height,
    created_at AS createdAt, updated_at AS updatedAt`;
}

function toAsset(row: MediaRow): MediaAsset {
  return {
    altText: row.altText,
    caption: row.caption,
    checksum: row.checksum,
    ...(row.componentId ? { componentId: row.componentId } : {}),
    createdAt: row.createdAt,
    focalX: row.focalX,
    focalY: row.focalY,
    height: row.height,
    id: row.id,
    position: row.position,
    recipeId: row.recipeId,
    role: row.role,
    ...(row.stepId ? { stepId: row.stepId } : {}),
    updatedAt: row.updatedAt,
    width: row.width,
  };
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
  }
}

async function createSocialDerivative(
  original: Buffer,
  width: number,
  height: number,
  focalX: number,
  focalY: number,
): Promise<Buffer> {
  const targetRatio = 1200 / 630;
  let cropWidth = width;
  let cropHeight = height;
  if (width / height > targetRatio)
    cropWidth = Math.round(height * targetRatio);
  else cropHeight = Math.round(width / targetRatio);
  const left = Math.round((width - cropWidth) * (focalX / 100));
  const top = Math.round((height - cropHeight) * (focalY / 100));
  return sharp(original, { limitInputPixels: MAX_INPUT_PIXELS })
    .extract({ height: cropHeight, left, top, width: cropWidth })
    .resize({ height: 630, width: 1200 })
    .webp({ effort: 4, quality: 84 })
    .timeout({ seconds: 10 })
    .toBuffer();
}
