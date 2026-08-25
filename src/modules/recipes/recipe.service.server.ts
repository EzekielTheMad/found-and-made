import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
  divideRational,
  rationalFromNumber,
  scaleQuantityRange,
  type UnitPreference,
} from "./recipe.scaling";
import { projectRecipe } from "./recipe.projections";
import { RecipeRepository } from "./recipe.repository.server";
import {
  sanitizeRecipeCreator,
  sanitizeRecipeSharedNotes,
  sanitizeRecipeTitle,
  sanitizeRecipeYield,
} from "./recipe-metadata";
import {
  RecipeConflictError,
  RecipeDuplicateError,
  RecipeNotFoundError,
  type RecipeAggregate,
  type RecipeDraft,
  type RecipeProjection,
  type RecipeRevision,
  type RecipeSummary,
} from "./recipe.types";
import {
  canonicalizeSourceUrl,
  fingerprintRecipe,
  validateRecipeDraft,
} from "./recipe.validation";

export interface CreateRecipeOptions {
  allowDuplicate?: boolean;
  createdByUserId?: string;
  now?: Date;
}

interface UpdateRecipeOptions {
  expectedVersion: number;
  now?: Date;
  reason: string;
}

export class RecipeService {
  private readonly repository: RecipeRepository;

  constructor(private readonly sqlite: Database.Database) {
    this.repository = new RecipeRepository(sqlite);
  }

  create(
    draft: RecipeDraft,
    options: CreateRecipeOptions = {},
  ): RecipeAggregate {
    const id = draft.id ?? randomUUID();
    const normalized = normalizeDraft({ ...draft, id });
    validateRecipeDraft(normalized);
    this.validateSubRecipeReferences(normalized, id);
    const fingerprint = fingerprintRecipe(normalized);
    const matches = this.repository.findDuplicates(
      fingerprint,
      normalized.source.canonicalUrl,
    );
    if (!options.allowDuplicate && matches.length > 0)
      throw new RecipeDuplicateError(matches);

    const timestamp = (options.now ?? new Date()).toISOString();
    const recipe: RecipeAggregate = {
      ...cloneDraft(normalized),
      createdAt: timestamp,
      ...(options.createdByUserId?.trim()
        ? { createdByUserId: options.createdByUserId.trim() }
        : {}),
      fingerprint,
      id,
      updatedAt: timestamp,
      version: 1,
    };
    this.repository.insert(recipe);
    return cloneRecipe(recipe);
  }

  get(id: string, includeDeleted = false): RecipeAggregate {
    const recipe = this.repository.findById(id);
    if (!recipe || (recipe.deletedAt && !includeDeleted))
      throw new RecipeNotFoundError(id);
    return cloneRecipe(recipe);
  }

  list(includeDeleted = false): RecipeSummary[] {
    return this.repository.list(includeDeleted);
  }

  project(
    id: string,
    targetYield?: number,
    unitPreference?: UnitPreference,
  ): RecipeProjection {
    const recipe = this.get(id);
    return projectRecipe(recipe, targetYield, unitPreference);
  }

  update(
    id: string,
    draft: RecipeDraft,
    options: UpdateRecipeOptions,
  ): RecipeAggregate {
    const previous = this.get(id, true);
    if (previous.version !== options.expectedVersion)
      throw new RecipeConflictError(options.expectedVersion, previous.version);

    const normalized = normalizeDraft({ ...draft, id });
    validateRecipeDraft(normalized);
    this.validateSubRecipeReferences(normalized, id);
    const fingerprint = fingerprintRecipe(normalized);
    const matches = this.repository.findDuplicates(
      fingerprint,
      normalized.source.canonicalUrl,
      id,
    );
    if (!normalized.variantOfId && matches.length > 0)
      throw new RecipeDuplicateError(matches);

    const timestamp = (options.now ?? new Date()).toISOString();
    const next: RecipeAggregate = {
      ...cloneDraft(normalized),
      ...(previous.deletedAt ? { deletedAt: previous.deletedAt } : {}),
      createdAt: previous.createdAt,
      ...(previous.createdByUserId
        ? { createdByUserId: previous.createdByUserId }
        : {}),
      fingerprint,
      id,
      updatedAt: timestamp,
      version: previous.version + 1,
    };
    const revision = makeRevision(previous, options.reason, timestamp);
    if (!this.repository.replace(previous, next, revision)) {
      const actual = this.repository.findById(id)?.version ?? previous.version;
      throw new RecipeConflictError(options.expectedVersion, actual);
    }
    return cloneRecipe(next);
  }

  saveVariant(
    sourceRecipeId: string,
    targetYield: number,
    title: string,
    now = new Date(),
    createdByUserId?: string,
  ): RecipeAggregate {
    const source = this.get(sourceRecipeId);
    if (!Number.isFinite(targetYield) || targetYield <= 0)
      throw new Error("Variant target yield must be positive");
    const factor = divideRational(
      rationalFromNumber(targetYield),
      rationalFromNumber(source.baseYield),
    );
    const draft: RecipeDraft = {
      allergens: source.allergens.map((value) => ({ ...value })),
      baseYield: targetYield,
      components: source.components.map((value) => ({ ...value })),
      ...(source.creatorName ? { creatorName: source.creatorName } : {}),
      diets: source.diets.map((value) => ({ ...value })),
      equipment: source.equipment.map((value) => ({ ...value })),
      ingredients: source.ingredients.map((ingredient) => ({
        ...ingredient,
        quantity: {
          ...ingredient.quantity,
          ...(ingredient.quantity.asWritten
            ? {
                asWritten:
                  ingredient.quantity.scaling === "proportional"
                    ? scaleQuantityRange(ingredient.quantity.asWritten, factor)
                    : structuredClone(ingredient.quantity.asWritten),
              }
            : {}),
          ...(ingredient.quantity.metricEquivalent
            ? {
                metricEquivalent: {
                  ...ingredient.quantity.metricEquivalent,
                  quantity:
                    ingredient.quantity.scaling === "proportional"
                      ? scaleQuantityRange(
                          ingredient.quantity.metricEquivalent.quantity,
                          factor,
                        )
                      : structuredClone(
                          ingredient.quantity.metricEquivalent.quantity,
                        ),
                },
              }
            : {}),
        },
        stepIds: [...ingredient.stepIds],
        substitutions: ingredient.substitutions.map((value) => ({
          ...value,
        })),
      })),
      ...(source.sharedNotes ? { sharedNotes: source.sharedNotes } : {}),
      source: { ...source.source },
      steps: source.steps.map((value) => ({
        ...value,
        equipmentIds: [...value.equipmentIds],
      })),
      subRecipes: source.subRecipes.map((subRecipe) => ({
        ...subRecipe,
        requiredYield:
          subRecipe.requiredYield * (targetYield / source.baseYield),
        stepIds: [...subRecipe.stepIds],
      })),
      title: title.trim(),
      variantOfId: source.id,
      yieldText: `${targetYield} servings`,
    };
    return this.create(draft, {
      allowDuplicate: true,
      createdByUserId,
      now,
    });
  }

  trash(
    id: string,
    expectedVersion: number,
    now = new Date(),
  ): RecipeAggregate {
    const previous = this.get(id);
    if (previous.version !== expectedVersion)
      throw new RecipeConflictError(expectedVersion, previous.version);
    return this.replaceState(previous, {
      deletedAt: now.toISOString(),
      now,
      reason: "Moved to recycle bin",
    });
  }

  trashMany(
    recipes: readonly { id: string; expectedVersion: number }[],
    now = new Date(),
  ): RecipeAggregate[] {
    const selected = uniqueVersionedRecipes(recipes);
    if (selected.length < 1 || selected.length > 500) {
      throw new Error("Bulk deletion requires between 1 and 500 recipes");
    }
    return this.sqlite
      .transaction(() => {
        for (const item of selected) {
          const recipe = this.get(item.id);
          if (recipe.version !== item.expectedVersion) {
            throw new RecipeConflictError(item.expectedVersion, recipe.version);
          }
        }
        return selected.map((item) =>
          this.trash(item.id, item.expectedVersion, now),
        );
      })
      .immediate();
  }

  restore(
    id: string,
    expectedVersion: number,
    now = new Date(),
  ): RecipeAggregate {
    const previous = this.get(id, true);
    if (!previous.deletedAt) return previous;
    if (previous.version !== expectedVersion)
      throw new RecipeConflictError(expectedVersion, previous.version);
    return this.replaceState(previous, {
      deletedAt: undefined,
      now,
      reason: "Restored from recycle bin",
    });
  }

  revisions(id: string): RecipeRevision[] {
    this.get(id, true);
    return this.repository.listRevisions(id).map((revision) => ({
      ...revision,
      snapshot: cloneRecipe(revision.snapshot),
    }));
  }

  restoreRevision(
    id: string,
    revisionVersion: number,
    expectedVersion: number,
    now = new Date(),
  ): RecipeAggregate {
    const revision = this.repository
      .listRevisions(id)
      .find((item) => item.version === revisionVersion);
    if (!revision)
      throw new Error(`Recipe revision ${revisionVersion} was not found`);
    return this.update(id, draftFromAggregate(revision.snapshot), {
      expectedVersion,
      now,
      reason: `Restored content from version ${revisionVersion}`,
    });
  }

  duplicates(draft: RecipeDraft, excludeId?: string) {
    const normalized = normalizeDraft(draft);
    validateRecipeDraft(normalized);
    return this.repository.findDuplicates(
      fingerprintRecipe(normalized),
      normalized.source.canonicalUrl,
      excludeId,
    );
  }

  private replaceState(
    previous: RecipeAggregate,
    options: {
      deletedAt: string | undefined;
      now: Date;
      reason: string;
    },
  ): RecipeAggregate {
    const next: RecipeAggregate = {
      ...cloneRecipe(previous),
      ...(options.deletedAt ? { deletedAt: options.deletedAt } : {}),
      updatedAt: options.now.toISOString(),
      version: previous.version + 1,
    };
    if (!options.deletedAt) delete next.deletedAt;
    const revision = makeRevision(
      previous,
      options.reason,
      options.now.toISOString(),
    );
    if (!this.repository.replace(previous, next, revision))
      throw new RecipeConflictError(previous.version, previous.version + 1);
    return cloneRecipe(next);
  }

  private validateSubRecipeReferences(
    draft: RecipeDraft,
    selfId: string,
  ): void {
    for (const edge of draft.subRecipes) {
      if (edge.recipeId === selfId)
        throw new Error("A recipe cannot include itself as a sub-recipe");
      const referenced = this.repository.findById(edge.recipeId);
      if (!referenced || referenced.deletedAt)
        throw new RecipeNotFoundError(edge.recipeId);
      if (dependsOn(referenced, selfId, this.repository, new Set()))
        throw new Error("Sub-recipe references cannot form a cycle");
    }
  }
}

function uniqueVersionedRecipes(
  recipes: readonly { id: string; expectedVersion: number }[],
): Array<{ id: string; expectedVersion: number }> {
  const selected = new Map<string, number>();
  for (const recipe of recipes) {
    const id = recipe.id.trim();
    if (!id || !Number.isInteger(recipe.expectedVersion)) {
      throw new Error("Bulk recipe selection is invalid");
    }
    const previous = selected.get(id);
    if (previous !== undefined && previous !== recipe.expectedVersion) {
      throw new Error("Bulk recipe selection contains conflicting versions");
    }
    selected.set(id, recipe.expectedVersion);
  }
  return [...selected].map(([id, expectedVersion]) => ({
    id,
    expectedVersion,
  }));
}

function normalizeDraft(draft: RecipeDraft): RecipeDraft {
  const canonicalUrl = canonicalizeSourceUrl(
    draft.source.canonicalUrl ?? draft.source.originalUrl,
  );
  const normalized: RecipeDraft = {
    ...cloneDraft(draft),
    source: canonicalUrl
      ? { ...draft.source, canonicalUrl, originalUrl: canonicalUrl }
      : { ...draft.source },
    title: sanitizeRecipeTitle(draft.title),
    yieldText: sanitizeRecipeYield(draft.yieldText),
  };
  const creatorName = sanitizeRecipeCreator(draft.creatorName);
  if (creatorName) normalized.creatorName = creatorName;
  else delete normalized.creatorName;
  const sharedNotes = sanitizeRecipeSharedNotes(draft.sharedNotes);
  if (sharedNotes) normalized.sharedNotes = sharedNotes;
  else delete normalized.sharedNotes;
  return normalized;
}

function makeRevision(
  previous: RecipeAggregate,
  reason: string,
  timestamp: string,
): RecipeRevision {
  return {
    createdAt: timestamp,
    id: randomUUID(),
    reason,
    recipeId: previous.id,
    snapshot: cloneRecipe(previous),
    version: previous.version,
  };
}

function cloneDraft<T extends RecipeDraft>(draft: T): T {
  return structuredClone(draft);
}

function cloneRecipe(recipe: RecipeAggregate): RecipeAggregate {
  return structuredClone(recipe);
}

function draftFromAggregate(recipe: RecipeAggregate): RecipeDraft {
  return structuredClone({
    allergens: recipe.allergens,
    baseYield: recipe.baseYield,
    components: recipe.components,
    ...(recipe.creatorName ? { creatorName: recipe.creatorName } : {}),
    diets: recipe.diets,
    equipment: recipe.equipment,
    id: recipe.id,
    ingredients: recipe.ingredients,
    ...(recipe.sharedNotes ? { sharedNotes: recipe.sharedNotes } : {}),
    source: recipe.source,
    steps: recipe.steps,
    subRecipes: recipe.subRecipes,
    title: recipe.title,
    ...(recipe.variantOfId ? { variantOfId: recipe.variantOfId } : {}),
    yieldText: recipe.yieldText,
  });
}

function dependsOn(
  recipe: RecipeAggregate,
  targetId: string,
  repository: RecipeRepository,
  visited: Set<string>,
): boolean {
  if (visited.has(recipe.id)) return false;
  visited.add(recipe.id);
  for (const edge of recipe.subRecipes) {
    if (edge.recipeId === targetId) return true;
    const nested = repository.findById(edge.recipeId);
    if (nested && dependsOn(nested, targetId, repository, visited)) return true;
  }
  return false;
}
