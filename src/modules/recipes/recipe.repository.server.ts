import type Database from "better-sqlite3";

import type {
  DuplicateMatch,
  RecipeAggregate,
  RecipeRevision,
  RecipeSummary,
} from "./recipe.types";
import { assertRecipeAggregate } from "./recipe.validation";

interface RecipeRow {
  aggregate: string;
  created_at: string;
  deleted_at: string | null;
  fingerprint: string;
  id: string;
  source_canonical_url: string | null;
  title: string;
  updated_at: string;
  variant_of_id: string | null;
  version: number;
}

interface RevisionRow {
  created_at: string;
  id: string;
  reason: string;
  recipe_id: string;
  snapshot: string;
  version: number;
}

export class RecipeRepository {
  constructor(private readonly sqlite: Database.Database) {}

  insert(recipe: RecipeAggregate): void {
    this.sqlite
      .prepare(
        `INSERT INTO recipes (
          aggregate, created_at, deleted_at, fingerprint, id,
          source_canonical_url, title, updated_at, variant_of_id, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        JSON.stringify(recipe),
        recipe.createdAt,
        recipe.deletedAt ?? null,
        recipe.fingerprint,
        recipe.id,
        recipe.source.canonicalUrl ?? null,
        recipe.title,
        recipe.updatedAt,
        recipe.variantOfId ?? null,
        recipe.version,
      );
  }

  findById(id: string): RecipeAggregate | undefined {
    const row = this.sqlite
      .prepare("SELECT * FROM recipes WHERE id = ?")
      .get(id) as RecipeRow | undefined;
    return row ? parseAggregate(row.aggregate) : undefined;
  }

  list(includeDeleted = false): RecipeSummary[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id, title, base_yield, created_by_user_id, yield_text,
          version, variant_of_id,
          deleted_at, updated_at
        FROM (
          SELECT
            id,
            title,
            json_extract(aggregate, '$.baseYield') AS base_yield,
            json_extract(aggregate, '$.createdByUserId') AS created_by_user_id,
            json_extract(aggregate, '$.yieldText') AS yield_text,
            version,
            variant_of_id,
            deleted_at,
            updated_at
          FROM recipes
        )
        WHERE (? = 1 OR deleted_at IS NULL)
        ORDER BY updated_at DESC, title ASC`,
      )
      .all(includeDeleted ? 1 : 0) as Array<{
      base_yield: number;
      created_by_user_id: string | null;
      deleted_at: string | null;
      id: string;
      title: string;
      updated_at: string;
      variant_of_id: string | null;
      version: number;
      yield_text: string;
    }>;
    return rows.map((row) => ({
      baseYield: row.base_yield,
      ...(row.created_by_user_id
        ? { createdByUserId: row.created_by_user_id }
        : {}),
      ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      ...(row.variant_of_id ? { variantOfId: row.variant_of_id } : {}),
      version: row.version,
      yieldText: row.yield_text,
    }));
  }

  findDuplicates(
    fingerprint: string,
    sourceCanonicalUrl: string | undefined,
    excludeId?: string,
  ): DuplicateMatch[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id, title, fingerprint, source_canonical_url
        FROM recipes
        WHERE deleted_at IS NULL
          AND id != COALESCE(?, '')
          AND (? IS NULL OR COALESCE(variant_of_id, '') != ?)
          AND (
            fingerprint = ?
            OR (? IS NOT NULL AND source_canonical_url = ?)
          )`,
      )
      .all(
        excludeId ?? null,
        excludeId ?? null,
        excludeId ?? null,
        fingerprint,
        sourceCanonicalUrl ?? null,
        sourceCanonicalUrl ?? null,
      ) as Array<{
      fingerprint: string;
      id: string;
      source_canonical_url: string | null;
      title: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      match:
        sourceCanonicalUrl && row.source_canonical_url === sourceCanonicalUrl
          ? "source"
          : "fingerprint",
      title: row.title,
    }));
  }

  replace(
    previous: RecipeAggregate,
    next: RecipeAggregate,
    revision: RecipeRevision,
  ): boolean {
    const transaction = this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `INSERT INTO recipe_revisions (
            created_at, id, reason, recipe_id, snapshot, version
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revision.createdAt,
          revision.id,
          revision.reason,
          revision.recipeId,
          JSON.stringify(revision.snapshot),
          revision.version,
        );

      const result = this.sqlite
        .prepare(
          `UPDATE recipes SET
            aggregate = ?,
            deleted_at = ?,
            fingerprint = ?,
            source_canonical_url = ?,
            title = ?,
            updated_at = ?,
            variant_of_id = ?,
            version = ?
          WHERE id = ? AND version = ?`,
        )
        .run(
          JSON.stringify(next),
          next.deletedAt ?? null,
          next.fingerprint,
          next.source.canonicalUrl ?? null,
          next.title,
          next.updatedAt,
          next.variantOfId ?? null,
          next.version,
          next.id,
          previous.version,
        );
      if (result.changes !== 1) throw new ConcurrentRepositoryUpdateError();
    });

    try {
      transaction();
      return true;
    } catch (error) {
      if (error instanceof ConcurrentRepositoryUpdateError) return false;
      throw error;
    }
  }

  listRevisions(recipeId: string): RecipeRevision[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM recipe_revisions
        WHERE recipe_id = ?
        ORDER BY version DESC`,
      )
      .all(recipeId) as RevisionRow[];
    return rows.map((row) => ({
      createdAt: row.created_at,
      id: row.id,
      reason: row.reason,
      recipeId: row.recipe_id,
      snapshot: parseAggregate(row.snapshot),
      version: row.version,
    }));
  }
}

class ConcurrentRepositoryUpdateError extends Error {}

function parseAggregate(serialized: string): RecipeAggregate {
  const parsed: unknown = JSON.parse(serialized);
  return assertRecipeAggregate(parsed);
}
