import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  QuantityRange,
  RecipeAggregate,
  RecipeDraft,
  Rational,
} from "./recipe.types";
import { RecipeValidationError } from "./recipe.types";
import {
  RECIPE_CREATOR_MAX_LENGTH,
  RECIPE_SHARED_NOTES_MAX_LENGTH,
  RECIPE_SOURCE_URL_MAX_LENGTH,
  RECIPE_TITLE_MAX_LENGTH,
  RECIPE_YIELD_MAX_LENGTH,
  sanitizeSingleLine,
} from "./recipe-metadata";

const rationalSchema = z
  .object({
    denominator: z.number().int().positive().safe(),
    numerator: z.number().int().nonnegative().safe(),
  })
  .strict();

const quantityRangeSchema = z
  .object({
    from: rationalSchema,
    to: rationalSchema.optional(),
  })
  .strict();

const ingredientQuantitySchema = z
  .object({
    asWritten: quantityRangeSchema.optional(),
    kind: z.enum(["count", "measure", "package"]),
    metricEquivalent: z
      .object({ quantity: quantityRangeSchema, unit: z.string() })
      .strict()
      .optional(),
    scaling: z.enum(["invariant", "proportional"]),
    text: z.string().optional(),
    unit: z.string(),
  })
  .strict();

const componentSchema = z
  .object({ id: z.string(), name: z.string(), position: z.number().int() })
  .strict();

const ingredientSchema = z
  .object({
    alternativeGroupId: z.string().optional(),
    componentId: z.string(),
    id: z.string(),
    name: z.string(),
    quantity: ingredientQuantitySchema,
    requirement: z.enum(["alternative", "optional", "required"]),
    sourceText: z.string(),
    stepIds: z.array(z.string()),
    substitutions: z.array(
      z.object({ name: z.string(), note: z.string() }).strict(),
    ),
  })
  .strict();

const stepSchema = z
  .object({
    action: z.string(),
    componentId: z.string(),
    equipmentIds: z.array(z.string()),
    id: z.string(),
    instruction: z.string(),
    packageGuidance: z.string().optional(),
    panGuidance: z.string().optional(),
    position: z.number().int(),
    temperature: z.string().optional(),
    time: z.string().optional(),
  })
  .strict();

const equipmentSchema = z
  .object({ id: z.string(), name: z.string(), required: z.boolean() })
  .strict();

const classificationSchema = z
  .object({ confirmed: z.boolean(), name: z.string() })
  .strict();

const sourceSchema = z
  .object({
    canonicalUrl: z.string().max(RECIPE_SOURCE_URL_MAX_LENGTH).optional(),
    originalUrl: z.string().max(RECIPE_SOURCE_URL_MAX_LENGTH).optional(),
    originalWording: z.string().optional(),
  })
  .strict();

const subRecipeSchema = z
  .object({
    authoredYield: z.number().positive(),
    componentId: z.string(),
    id: z.string(),
    recipeId: z.string(),
    requiredYield: z.number().positive(),
    stepIds: z.array(z.string()),
    title: z.string(),
  })
  .strict();

const recipeAggregateSchema = z
  .object({
    allergens: z.array(classificationSchema),
    baseYield: z.number().positive(),
    components: z.array(componentSchema),
    createdAt: z.iso.datetime(),
    createdByUserId: z.string().min(1).optional(),
    creatorName: z.string().max(RECIPE_CREATOR_MAX_LENGTH).optional(),
    deletedAt: z.iso.datetime().optional(),
    diets: z.array(classificationSchema),
    equipment: z.array(equipmentSchema),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    id: z.string().min(1),
    ingredients: z.array(ingredientSchema),
    sharedNotes: z.string().max(RECIPE_SHARED_NOTES_MAX_LENGTH).optional(),
    source: sourceSchema,
    steps: z.array(stepSchema),
    subRecipes: z.array(subRecipeSchema),
    title: z.string().max(RECIPE_TITLE_MAX_LENGTH),
    updatedAt: z.iso.datetime(),
    variantOfId: z.string().optional(),
    version: z.number().int().positive(),
    yieldText: z.string().max(RECIPE_YIELD_MAX_LENGTH),
  })
  .strict();

export function validateRecipeDraft(draft: RecipeDraft): void {
  if (!draft.title.trim())
    throw new RecipeValidationError("Recipe title is required");
  if (draft.title.length > RECIPE_TITLE_MAX_LENGTH)
    throw new RecipeValidationError(
      `Recipe title must be ${RECIPE_TITLE_MAX_LENGTH} characters or fewer`,
    );
  if (!Number.isFinite(draft.baseYield) || draft.baseYield <= 0)
    throw new RecipeValidationError("Base yield must be a positive number");
  if (!draft.yieldText.trim())
    throw new RecipeValidationError("Descriptive yield is required");
  if (draft.yieldText.length > RECIPE_YIELD_MAX_LENGTH)
    throw new RecipeValidationError(
      `Descriptive yield must be ${RECIPE_YIELD_MAX_LENGTH} characters or fewer`,
    );
  if (
    draft.creatorName &&
    draft.creatorName.trim().length > RECIPE_CREATOR_MAX_LENGTH
  )
    throw new RecipeValidationError(
      `Recipe creator must be ${RECIPE_CREATOR_MAX_LENGTH} characters or fewer`,
    );
  if (
    draft.sharedNotes &&
    [...draft.sharedNotes].length > RECIPE_SHARED_NOTES_MAX_LENGTH
  )
    throw new RecipeValidationError(
      `Shared notes must be ${RECIPE_SHARED_NOTES_MAX_LENGTH} characters or fewer`,
    );
  if (draft.components.length === 0)
    throw new RecipeValidationError("At least one component is required");
  if (draft.ingredients.length === 0)
    throw new RecipeValidationError("At least one ingredient is required");
  if (draft.steps.length === 0)
    throw new RecipeValidationError("At least one step is required");

  assertUniqueIds(draft.components, "component");
  assertUniqueIds(draft.ingredients, "ingredient");
  assertUniqueIds(draft.steps, "step");
  assertUniqueIds(draft.equipment, "equipment");
  assertUniqueIds(draft.subRecipes, "sub-recipe edge");

  const componentIds = new Set(
    draft.components.map((component) => component.id),
  );
  const stepById = new Map(draft.steps.map((step) => [step.id, step]));
  const equipmentIds = new Set(
    draft.equipment.map((equipment) => equipment.id),
  );

  for (const step of draft.steps) {
    if (!componentIds.has(step.componentId))
      throw new RecipeValidationError(
        `Step ${step.id} references a missing component`,
      );
    if (!step.instruction.trim())
      throw new RecipeValidationError(`Step ${step.id} requires instructions`);
    if (!step.action.trim())
      throw new RecipeValidationError(`Step ${step.id} requires an action`);
    for (const equipmentId of step.equipmentIds) {
      if (!equipmentIds.has(equipmentId))
        throw new RecipeValidationError(
          `Step ${step.id} references missing equipment ${equipmentId}`,
        );
    }
  }

  for (const ingredient of draft.ingredients) {
    if (!componentIds.has(ingredient.componentId))
      throw new RecipeValidationError(
        `Ingredient ${ingredient.id} references a missing component`,
      );
    if (!ingredient.name.trim())
      throw new RecipeValidationError(
        `Ingredient ${ingredient.id} requires a name`,
      );
    if (ingredient.stepIds.length === 0)
      throw new RecipeValidationError(
        `Ingredient ${ingredient.id} must map to at least one step`,
      );
    if (
      ingredient.requirement === "alternative" &&
      !ingredient.alternativeGroupId
    ) {
      throw new RecipeValidationError(
        `Alternative ingredient ${ingredient.id} requires an alternative group`,
      );
    }
    if (ingredient.quantity.asWritten) {
      validateQuantityRange(ingredient.quantity.asWritten);
    } else if (!ingredient.quantity.text?.trim()) {
      throw new RecipeValidationError(
        `Ingredient ${ingredient.id} requires a numeric or text quantity`,
      );
    }
    if (ingredient.quantity.metricEquivalent)
      validateQuantityRange(ingredient.quantity.metricEquivalent.quantity);

    for (const stepId of new Set(ingredient.stepIds)) {
      const step = stepById.get(stepId);
      if (!step)
        throw new RecipeValidationError(
          `Ingredient ${ingredient.id} references missing step ${stepId}`,
        );
      if (step.componentId !== ingredient.componentId)
        throw new RecipeValidationError(
          `Ingredient ${ingredient.id} must map within its component`,
        );
    }
  }

  for (const subRecipe of draft.subRecipes) {
    if (!componentIds.has(subRecipe.componentId))
      throw new RecipeValidationError(
        `Sub-recipe ${subRecipe.id} references a missing component`,
      );
    if (!subRecipe.recipeId.trim())
      throw new RecipeValidationError(
        `Sub-recipe ${subRecipe.id} requires a recipe reference`,
      );
    if (
      !Number.isFinite(subRecipe.authoredYield) ||
      subRecipe.authoredYield <= 0 ||
      !Number.isFinite(subRecipe.requiredYield) ||
      subRecipe.requiredYield <= 0
    ) {
      throw new RecipeValidationError(
        `Sub-recipe ${subRecipe.id} requires positive yields`,
      );
    }
    for (const stepId of subRecipe.stepIds) {
      const step = stepById.get(stepId);
      if (!step || step.componentId !== subRecipe.componentId)
        throw new RecipeValidationError(
          `Sub-recipe ${subRecipe.id} must map to a step in its component`,
        );
    }
  }

  for (const classification of [...draft.allergens, ...draft.diets]) {
    if (!classification.name.trim())
      throw new RecipeValidationError("Classification names cannot be empty");
  }
}

export function fingerprintRecipe(
  recipe: RecipeDraft | RecipeAggregate,
): string {
  const components = [...recipe.components]
    .sort((left, right) => left.position - right.position)
    .map((component) => normalizeText(component.name));
  const ingredients = [...recipe.ingredients]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((ingredient) => ({
      component: normalizeText(
        recipe.components.find(
          (component) => component.id === ingredient.componentId,
        )?.name ?? "",
      ),
      name: normalizeText(ingredient.name),
      quantity: ingredient.quantity,
      requirement: ingredient.requirement,
      source: normalizeText(ingredient.sourceText),
    }));
  const subRecipes = [...recipe.subRecipes]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((subRecipe) => ({
      authoredYield: subRecipe.authoredYield,
      component: normalizeText(
        recipe.components.find(
          (component) => component.id === subRecipe.componentId,
        )?.name ?? "",
      ),
      recipeId: subRecipe.recipeId,
      requiredYield: subRecipe.requiredYield,
      title: normalizeText(subRecipe.title),
    }));
  const steps = [...recipe.steps]
    .sort((left, right) => left.position - right.position)
    .map((step) => ({
      action: normalizeText(step.action),
      instruction: normalizeText(step.instruction),
    }));
  const payload = JSON.stringify({
    baseYield: recipe.baseYield,
    components,
    ingredients,
    steps,
    subRecipes,
    title: normalizeText(recipe.title),
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function canonicalizeSourceUrl(value?: string): string | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > RECIPE_SOURCE_URL_MAX_LENGTH)
    throw new RecipeValidationError(
      `Source URL must be ${RECIPE_SOURCE_URL_MAX_LENGTH} characters or fewer`,
    );
  if (sanitizeSingleLine(trimmed, RECIPE_SOURCE_URL_MAX_LENGTH) !== trimmed)
    throw new RecipeValidationError(
      "Source URL contains unsupported characters",
    );
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new RecipeValidationError("Source URL must be an absolute URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new RecipeValidationError("Source URL must use HTTP or HTTPS");
  if (parsed.username || parsed.password)
    throw new RecipeValidationError("Source URL cannot include credentials");

  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  parsed.searchParams.sort();
  return parsed.toString();
}

export function assertRecipeAggregate(value: unknown): RecipeAggregate {
  return recipeAggregateSchema.parse(value);
}

function validateQuantityRange(quantity: QuantityRange): void {
  validateRational(quantity.from);
  if (quantity.to) {
    validateRational(quantity.to);
    if (
      quantity.from.numerator * quantity.to.denominator >
      quantity.to.numerator * quantity.from.denominator
    ) {
      throw new RecipeValidationError(
        "Quantity range start cannot exceed its end",
      );
    }
  }
}

function validateRational(value: Rational): void {
  if (
    !Number.isSafeInteger(value.numerator) ||
    !Number.isSafeInteger(value.denominator) ||
    value.numerator < 0 ||
    value.denominator <= 0
  ) {
    throw new RecipeValidationError(
      "Quantities require non-negative safe-integer fractions",
    );
  }
}

function assertUniqueIds(values: Array<{ id: string }>, label: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (!value.id.trim())
      throw new RecipeValidationError(`${label} ID cannot be empty`);
    if (ids.has(value.id))
      throw new RecipeValidationError(`Duplicate ${label} ID ${value.id}`);
    ids.add(value.id);
  }
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}
