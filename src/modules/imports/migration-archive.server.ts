import { createHash } from "node:crypto";

import { unzipSync } from "fflate";

import type { ImportSource, MigrationFormat } from "./import.types";

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_EXPANDED_JSON_BYTES = 50 * 1024 * 1024;
const MAX_EXPANDED_IMAGE_BYTES = 200 * 1024 * 1024;
const MAX_IMAGE_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_FILES = 500;
const MAX_JSON_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_JSON_FILES = 1_000;
const MAX_RECIPES = 500;
const MAX_RECIPE_BYTES = 2 * 1024 * 1024;

export interface ParsedMigrationRecipe {
  heroImage?: {
    bytes: Uint8Array;
    fileName: string;
  };
  source: Extract<ImportSource, { kind: "migration_json" }>;
  sourceName: string;
}

export class MigrationUploadError extends Error {
  public override readonly name = "MigrationUploadError";
}

export async function parseMigrationUpload(
  file: File,
  format: MigrationFormat,
): Promise<ParsedMigrationRecipe[]> {
  if (file.size < 1 || file.size > MAX_ARCHIVE_BYTES) {
    throw new MigrationUploadError(
      "Migration files must be between 1 byte and 100 MiB",
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const documents = isZip(bytes)
    ? jsonDocumentsFromZip(bytes, format)
    : [{ bytes, name: file.name || "migration.json" }];
  const recipes: ParsedMigrationRecipe[] = [];
  const fingerprints = new Set<string>();

  for (const document of documents) {
    const value = parseJson(document.bytes, document.name);
    const records = migrationRecords(value, format);
    for (const payload of records) {
      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized) > MAX_RECIPE_BYTES) {
        throw new MigrationUploadError(
          `Recipe data in ${document.name} exceeds the 2 MiB per-recipe limit`,
        );
      }
      const fingerprint = createHash("sha256").update(serialized).digest("hex");
      if (fingerprints.has(fingerprint)) continue;
      fingerprints.add(fingerprint);
      recipes.push({
        ...(records.length === 1 && document.heroImage
          ? { heroImage: document.heroImage }
          : {}),
        source: {
          format,
          kind: "migration_json",
          originalWording: serialized,
          payload,
        },
        sourceName: document.name,
      });
      if (recipes.length > MAX_RECIPES) {
        throw new MigrationUploadError(
          `Migration archives are limited to ${MAX_RECIPES} recipes`,
        );
      }
    }
  }

  if (recipes.length === 0) {
    throw new MigrationUploadError(
      "No supported recipes were found. Export recipe data as JSON or ZIP instead of uploading a raw database backup.",
    );
  }
  return recipes;
}

function jsonDocumentsFromZip(
  archive: Uint8Array,
  format: MigrationFormat,
): Array<{
  bytes: Uint8Array;
  heroImage?: { bytes: Uint8Array; fileName: string };
  name: string;
}> {
  let expandedBytes = 0;
  let expandedImageBytes = 0;
  let imageFiles = 0;
  let jsonFiles = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(archive, {
      filter(file) {
        if (!safeArchiveName(file.name) || file.name.endsWith("/"))
          return false;
        const isJson = file.name.toLocaleLowerCase().endsWith(".json");
        const isNextcloudRecipe = /(?:^|\/)recipe\.json$/i.test(file.name);
        const isMealieHero = format === "mealie" && mealieHeroImage(file.name);
        if (
          (!isJson || (format === "nextcloud" && !isNextcloudRecipe)) &&
          !isMealieHero
        ) {
          return false;
        }
        if (isMealieHero) {
          imageFiles += 1;
          if (imageFiles > MAX_IMAGE_FILES) {
            throw new MigrationUploadError(
              `Migration archives are limited to ${MAX_IMAGE_FILES} original recipe images`,
            );
          }
          if (file.originalSize > MAX_IMAGE_ENTRY_BYTES) {
            throw new MigrationUploadError(
              `Recipe image ${file.name} exceeds the 20 MiB expanded limit`,
            );
          }
          expandedImageBytes += file.originalSize;
          if (expandedImageBytes > MAX_EXPANDED_IMAGE_BYTES) {
            throw new MigrationUploadError(
              "Migration archive images expand beyond the 200 MiB safety limit",
            );
          }
          return true;
        }
        jsonFiles += 1;
        if (jsonFiles > MAX_JSON_FILES) {
          throw new MigrationUploadError(
            `Migration archives are limited to ${MAX_JSON_FILES} JSON files`,
          );
        }
        if (file.originalSize > MAX_JSON_ENTRY_BYTES) {
          throw new MigrationUploadError(
            `JSON entry ${file.name} exceeds the 10 MiB expanded limit`,
          );
        }
        expandedBytes += file.originalSize;
        if (expandedBytes > MAX_EXPANDED_JSON_BYTES) {
          throw new MigrationUploadError(
            "Migration archive JSON expands beyond the 50 MiB safety limit",
          );
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof MigrationUploadError) {
      throw error;
    }
    throw new MigrationUploadError("Migration ZIP could not be read safely", {
      cause: error,
    });
  }

  const normalizedFiles = new Map(
    Object.entries(files).map(([name, bytes]) => [
      name.replaceAll("\\", "/").toLocaleLowerCase(),
      { bytes, name },
    ]),
  );
  return Object.entries(files)
    .filter(([name]) => name.toLocaleLowerCase().endsWith(".json"))
    .map(([name, bytes]) => {
      if (bytes.byteLength > MAX_JSON_ENTRY_BYTES) {
        throw new MigrationUploadError(
          `JSON entry ${name} exceeds the 10 MiB expanded limit`,
        );
      }
      const hero = mealieHeroForDocument(name, normalizedFiles);
      return {
        bytes,
        ...(hero
          ? { heroImage: { bytes: hero.bytes, fileName: hero.name } }
          : {}),
        name,
      };
    });
}

function mealieHeroForDocument(
  documentName: string,
  files: Map<string, { bytes: Uint8Array; name: string }>,
): { bytes: Uint8Array; name: string } | undefined {
  const normalized = documentName.replaceAll("\\", "/").toLocaleLowerCase();
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return undefined;
  const directory = normalized.slice(0, slash);
  for (const extension of ["webp", "jpg", "jpeg", "png"]) {
    const file = files.get(`${directory}/images/original.${extension}`);
    if (file) return file;
  }
  return undefined;
}

function mealieHeroImage(name: string): boolean {
  return /(?:^|\/)images\/original\.(?:webp|jpe?g|png)$/i.test(
    name.replaceAll("\\", "/"),
  );
}

function migrationRecords(
  value: unknown,
  format: MigrationFormat,
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => migrationRecords(item, format));
  }
  const record = asRecord(value);
  if (!record) return [];
  if (looksLikeRecipe(record, format)) return [record];

  const candidates = [
    record.recipe,
    record.recipes,
    record.items,
    record.results,
    record.data,
    record["@graph"],
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined) {
      const nested = migrationRecords(candidate, format);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

function looksLikeRecipe(
  record: Record<string, unknown>,
  format: MigrationFormat,
): boolean {
  const types = Array.isArray(record["@type"])
    ? record["@type"]
    : [record["@type"]];
  if (types.some(isRecipeType)) return true;

  const hasTitle = nonEmptyString(record.name) || nonEmptyString(record.title);
  if (!hasTitle) return false;
  if (format === "tandoor") {
    return Array.isArray(record.steps) || Array.isArray(record.ingredients);
  }
  if (format === "mealie") {
    return [
      record.recipe_ingredient,
      record.recipe_instructions,
      record.recipeIngredient,
      record.recipeInstructions,
    ].some(isPopulatedRecipeField);
  }
  return [
    record.recipeIngredient,
    record.recipeIngredients,
    record.ingredients,
    record.recipeInstructions,
    record.instructions,
    record.steps,
  ].some(isPopulatedRecipeField);
}

function parseJson(bytes: Uint8Array, name: string): unknown {
  if (bytes.byteLength > MAX_JSON_ENTRY_BYTES) {
    throw new MigrationUploadError(`${name} exceeds the 10 MiB JSON limit`);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new MigrationUploadError(`${name} is not valid UTF-8 JSON`);
  }
}

function safeArchiveName(name: string): boolean {
  if (!name || name.includes("\0") || name.startsWith("/")) return false;
  const segments = name.replaceAll("\\", "/").split("/");
  return (
    segments.length <= 8 &&
    segments.every((segment) => segment !== ".." && segment !== ".")
  );
}

function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isPopulatedRecipeField(value: unknown): boolean {
  return (Array.isArray(value) && value.length > 0) || nonEmptyString(value);
}

function isRecipeType(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value === "Recipe" || /(?:[/#])Recipe$/.test(value))
  );
}
