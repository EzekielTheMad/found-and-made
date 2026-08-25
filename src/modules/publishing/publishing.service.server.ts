import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { RecipeAggregate } from "../recipes/recipe.types";
import type { RecipeService } from "../recipes/recipe.service.server";
import { AuthorizationPolicy } from "../identity/authorization.policy";
import type { Principal } from "../identity/identity.types";
import type { PublicCollectionDto, PublicRecipeDto } from "./publishing.types";

export interface PublicRecipeSummary {
  id: string;
  title: string;
  updatedAt: string;
  yieldText: string;
}

export class PublishingService {
  private readonly policy = new AuthorizationPolicy();

  constructor(
    private readonly sqlite: Database.Database,
    private readonly recipes: RecipeService,
  ) {}

  isPublicModeEnabled(): boolean {
    const row = this.sqlite
      .prepare("SELECT value FROM system_settings WHERE key = 'public_mode'")
      .get() as { value: string } | undefined;
    return row?.value === "enabled";
  }

  status(recipeId: string): "private" | "review" | "published" {
    const row = this.sqlite
      .prepare("SELECT status FROM recipe_publications WHERE recipe_id = ?")
      .get(recipeId) as { status: "review" | "published" } | undefined;
    return row?.status ?? "private";
  }

  statuses(
    recipeIds: readonly string[],
  ): Record<string, "private" | "review" | "published"> {
    const ids = [...new Set(recipeIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0) return {};
    const result: Record<string, "private" | "review" | "published"> =
      Object.fromEntries(ids.map((id) => [id, "private"]));
    for (const batch of chunks(ids, 500)) {
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.sqlite
        .prepare(
          `SELECT recipe_id AS recipeId, status
           FROM recipe_publications
           WHERE recipe_id IN (${placeholders})`,
        )
        .all(...batch) as Array<{
        recipeId: string;
        status: "review" | "published";
      }>;
      for (const row of rows) result[row.recipeId] = row.status;
    }
    return result;
  }

  collectionStatus(collectionId: string): "private" | "published" {
    const row = this.sqlite
      .prepare(
        "SELECT collection_id FROM collection_publications WHERE collection_id = ?",
      )
      .get(collectionId);
    return row ? "published" : "private";
  }

  setPublicMode(
    principal: Principal,
    enabled: boolean,
    now = new Date(),
  ): void {
    this.policy.require(principal, "instance:manage");
    this.sqlite
      .transaction(() => {
        this.sqlite
          .prepare(
            `INSERT INTO system_settings (key, value, updated_at)
           VALUES ('public_mode', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value,
             updated_at = excluded.updated_at`,
          )
          .run(enabled ? "enabled" : "disabled", now.toISOString());
        this.audit("public_mode.changed", principal, null, { enabled }, now);
      })
      .immediate();
  }

  requestReview(
    principal: Principal,
    recipeId: string,
    now = new Date(),
  ): void {
    this.policy.require(principal, "recipe:review");
    this.recipes.get(recipeId);
    const actorId = userId(principal);
    this.sqlite
      .transaction(() => {
        this.sqlite
          .prepare(
            `INSERT INTO recipe_publications
           (recipe_id, status, review_requested_by, review_requested_at,
            published_by, published_at, rights_attested_by,
            rights_attested_at, updated_at)
           VALUES (?, 'review', ?, ?, NULL, NULL, NULL, NULL, ?)
           ON CONFLICT(recipe_id) DO UPDATE SET status = 'review',
             review_requested_by = excluded.review_requested_by,
             review_requested_at = excluded.review_requested_at,
             published_by = NULL, published_at = NULL,
             rights_attested_by = NULL, rights_attested_at = NULL,
             updated_at = excluded.updated_at`,
          )
          .run(recipeId, actorId, now.toISOString(), now.toISOString());
        this.audit(
          "publication.review_requested",
          principal,
          recipeId,
          {},
          now,
        );
      })
      .immediate();
  }

  publish(principal: Principal, recipeId: string, now = new Date()): void {
    this.policy.require(principal, "recipe:publish");
    this.recipes.get(recipeId);
    const actorId = userId(principal);
    this.sqlite
      .transaction(() => {
        this.sqlite
          .prepare(
            `INSERT INTO recipe_publications
           (recipe_id, status, review_requested_by, review_requested_at,
            published_by, published_at, rights_attested_by,
            rights_attested_at, updated_at)
           VALUES (?, 'published', NULL, NULL, ?, ?, NULL, NULL, ?)
           ON CONFLICT(recipe_id) DO UPDATE SET status = 'published',
             published_by = excluded.published_by,
             published_at = excluded.published_at,
             rights_attested_by = NULL,
             rights_attested_at = NULL,
             updated_at = excluded.updated_at`,
          )
          .run(recipeId, actorId, now.toISOString(), now.toISOString());
        this.audit("recipe.published", principal, recipeId, {}, now);
      })
      .immediate();
  }

  unpublish(principal: Principal, recipeId: string, now = new Date()): void {
    this.policy.require(principal, "recipe:publish");
    this.sqlite
      .transaction(() => {
        this.sqlite
          .prepare("DELETE FROM recipe_publications WHERE recipe_id = ?")
          .run(recipeId);
        this.audit("recipe.unpublished", principal, recipeId, {}, now);
      })
      .immediate();
  }

  setPublishedMany(
    principal: Principal,
    recipeIds: readonly string[],
    published: boolean,
    now = new Date(),
  ): number {
    this.policy.require(principal, "recipe:publish");
    const ids = [...new Set(recipeIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length < 1) throw new Error("Select at least one recipe");
    const actorId = userId(principal);
    const timestamp = now.toISOString();
    this.sqlite
      .transaction(() => {
        for (const recipeId of ids) this.recipes.get(recipeId);
        if (published) {
          const statement = this.sqlite.prepare(
            `INSERT INTO recipe_publications
             (recipe_id, status, review_requested_by, review_requested_at,
              published_by, published_at, rights_attested_by,
              rights_attested_at, updated_at)
             VALUES (?, 'published', NULL, NULL, ?, ?, NULL, NULL, ?)
             ON CONFLICT(recipe_id) DO UPDATE SET status = 'published',
               review_requested_by = NULL, review_requested_at = NULL,
               published_by = excluded.published_by,
               published_at = excluded.published_at,
               rights_attested_by = NULL, rights_attested_at = NULL,
               updated_at = excluded.updated_at`,
          );
          for (const recipeId of ids) {
            statement.run(recipeId, actorId, timestamp, timestamp);
          }
        } else {
          const statement = this.sqlite.prepare(
            "DELETE FROM recipe_publications WHERE recipe_id = ?",
          );
          for (const recipeId of ids) statement.run(recipeId);
        }
        this.audit(
          published ? "recipes.bulk_published" : "recipes.bulk_unpublished",
          principal,
          null,
          { count: ids.length },
          now,
        );
      })
      .immediate();
    return ids.length;
  }

  setCollectionPublished(
    principal: Principal,
    collectionId: string,
    published: boolean,
    now = new Date(),
  ): void {
    this.policy.require(principal, "recipe:publish");
    const collection = this.sqlite
      .prepare("SELECT id FROM collections WHERE id = ?")
      .get(collectionId);
    if (!collection) throw new Error("Collection not found");

    const timestamp = now.toISOString();
    this.sqlite
      .transaction(() => {
        if (published) {
          this.sqlite
            .prepare(
              `INSERT INTO collection_publications
               (collection_id, published_by, published_at, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(collection_id) DO UPDATE SET
                 published_by = excluded.published_by,
                 published_at = excluded.published_at,
                 updated_at = excluded.updated_at`,
            )
            .run(collectionId, userId(principal), timestamp, timestamp);
        } else {
          this.sqlite
            .prepare(
              "DELETE FROM collection_publications WHERE collection_id = ?",
            )
            .run(collectionId);
        }
        this.audit(
          published ? "collection.published" : "collection.unpublished",
          principal,
          collectionId,
          {},
          now,
        );
      })
      .immediate();
  }

  getPublicCollection(collectionId: string): PublicCollectionDto | null {
    if (!this.isPublicModeEnabled()) return null;
    const collection = this.sqlite
      .prepare(
        `SELECT c.id, c.title, c.description
         FROM collection_publications cp
         INNER JOIN collections c ON c.id = cp.collection_id
         WHERE cp.collection_id = ?`,
      )
      .get(collectionId) as
      { description: string; id: string; title: string } | undefined;
    if (!collection) return null;

    const recipeIds = this.sqlite
      .prepare(
        `SELECT cr.recipe_id AS recipeId
         FROM collection_recipes cr
         INNER JOIN recipe_publications rp
           ON rp.recipe_id = cr.recipe_id AND rp.status = 'published'
         INNER JOIN recipes r
           ON r.id = cr.recipe_id AND r.deleted_at IS NULL
         WHERE cr.collection_id = ?
         ORDER BY cr.position, cr.recipe_id`,
      )
      .all(collectionId) as Array<{ recipeId: string }>;
    const recipes = recipeIds.flatMap(({ recipeId }) => {
      const recipe = this.getPublicRecipe(recipeId);
      return recipe
        ? [
            {
              id: recipe.id,
              title: recipe.title,
              yieldText: recipe.yieldText,
            },
          ]
        : [];
    });
    return { ...collection, recipes };
  }

  getPublicRecipe(recipeId: string): PublicRecipeDto | null {
    if (!this.isPublicModeEnabled()) return null;
    const row = this.sqlite
      .prepare(
        `SELECT status FROM recipe_publications
         WHERE recipe_id = ? AND status = 'published'`,
      )
      .get(recipeId);
    if (!row) return null;
    try {
      return toPublicRecipeDto(this.recipes.get(recipeId));
    } catch {
      return null;
    }
  }

  listPublicRecipes(): PublicRecipeSummary[] {
    if (!this.isPublicModeEnabled()) return [];
    const rows = this.sqlite
      .prepare(
        `SELECT p.recipe_id AS recipeId
         FROM recipe_publications p
         INNER JOIN recipes r ON r.id = p.recipe_id
         WHERE p.status = 'published'
           AND r.deleted_at IS NULL
         ORDER BY p.published_at DESC, p.recipe_id`,
      )
      .all() as Array<{ recipeId: string }>;
    return rows.flatMap(({ recipeId }) => {
      try {
        const recipe = this.recipes.get(recipeId);
        return [
          {
            id: recipe.id,
            title: recipe.title,
            updatedAt: recipe.updatedAt,
            yieldText: recipe.yieldText,
          },
        ];
      } catch {
        return [];
      }
    });
  }

  private audit(
    action: string,
    principal: Principal,
    subjectId: string | null,
    metadata: Record<string, unknown>,
    now: Date,
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO audit_events
         (id, action, actor_id, subject_id, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        action,
        principal.kind === "user" ? principal.userId : null,
        subjectId,
        JSON.stringify(metadata),
        now.toISOString(),
      );
  }
}

function toPublicRecipeDto(recipe: RecipeAggregate): PublicRecipeDto {
  return {
    components: recipe.components.map(({ id, name }) => ({ id, name })),
    ...(recipe.creatorName ? { creatorName: recipe.creatorName } : {}),
    id: recipe.id,
    ingredients: recipe.ingredients.map(
      ({ componentId, id, sourceText: text }) => ({ componentId, id, text }),
    ),
    steps: recipe.steps.map(({ componentId, id, instruction }) => ({
      componentId,
      id,
      instruction,
    })),
    title: recipe.title,
    yieldText: recipe.yieldText,
  };
}

function userId(principal: Principal): string | null {
  return principal.kind === "user" ? principal.userId : null;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}
