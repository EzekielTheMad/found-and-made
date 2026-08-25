import type {
  IngredientQuantity,
  RecipeDraft,
  RecipeIngredient,
} from "../recipes/recipe.types";
import {
  sanitizeRecipeCreator,
  sanitizeRecipeTitle,
  sanitizeRecipeYield,
} from "../recipes/recipe-metadata";
import { normalizeIngredientName } from "./ingredient-normalization";
import { inferStandardImportTags } from "./import-classification";
import type {
  BrandConfirmation,
  MappedImport,
  NormalizedImport,
  RecipeDependencyCandidate,
  StructuredImport,
} from "./import.types";

export function normalizeStructuredImport(
  structured: StructuredImport,
): NormalizedImport {
  const componentId = "main";
  const brandConfirmations: BrandConfirmation[] = [];
  const warnings = [...structured.warnings];
  const ids = new Set<string>();
  const ingredients: RecipeIngredient[] = structured.candidate.ingredients.map(
    (candidate, position) => {
      const id = uniqueId(
        slug(candidate.name) || `ingredient-${position + 1}`,
        ids,
      );
      const normalized = normalizeIngredientName(candidate);
      warnings.push(...normalized.warnings);
      if (candidate.confidence !== undefined && candidate.confidence < 0.75) {
        warnings.push({
          code: "low_confidence",
          field: id,
          message: `Ingredient extraction confidence is ${Math.round(candidate.confidence * 100)}%.`,
          severity: "warning",
        });
      }
      if (normalized.confirmation) {
        brandConfirmations.push({
          ...normalized.confirmation,
          ingredientId: id,
          sourceText: candidate.sourceText,
        });
      }
      return {
        componentId,
        id,
        name: normalized.name,
        quantity: parseQuantity(candidate.quantityText),
        requirement: "required" as const,
        sourceText: candidate.sourceText,
        stepIds: [],
        substitutions: [],
      };
    },
  );
  const steps = structured.candidate.steps.map((instruction, position) => ({
    action: firstWord(instruction) || `step ${position + 1}`,
    componentId,
    equipmentIds: [],
    id: `step-${position + 1}`,
    instruction,
    position,
  }));
  const sourceUrl =
    structured.acquired.canonicalUrl ?? structured.candidate.sourceUrl;
  const creatorName = sanitizeRecipeCreator(structured.candidate.creatorName);
  const source = sourceUrl
    ? {
        canonicalUrl: sourceUrl,
        originalUrl: sourceUrl,
        originalWording: structured.acquired.originalWording,
      }
    : { originalWording: structured.acquired.originalWording };
  const draft: RecipeDraft = {
    allergens: [],
    baseYield: structured.candidate.baseYield,
    components: [{ id: componentId, name: "Main", position: 0 }],
    ...(creatorName ? { creatorName } : {}),
    diets: [],
    equipment: [],
    ingredients,
    source,
    steps,
    subRecipes: [],
    title: sanitizeRecipeTitle(structured.candidate.title),
    yieldText: sanitizeRecipeYield(structured.candidate.yieldText),
  };
  return {
    brandConfirmations,
    draft,
    standardizedTags: inferStandardImportTags(structured.candidate),
    ...(structured.acquired.fallback
      ? { fallback: structured.acquired.fallback }
      : {}),
    warnings,
  };
}

export function normalizeManualImport(
  structured: StructuredImport,
  manualDraft: RecipeDraft,
): NormalizedImport {
  const draft = structuredClone(manualDraft);
  const warnings = [...structured.warnings];
  const brandConfirmations: BrandConfirmation[] = [];
  draft.ingredients = draft.ingredients.map((ingredient, index) => {
    const candidate = structured.candidate.ingredients[index] ?? {
      name: ingredient.name,
      quantityText: ingredient.quantity.text ?? ingredient.sourceText,
      sourceText: ingredient.sourceText,
    };
    const normalized = normalizeIngredientName(candidate);
    warnings.push(...normalized.warnings);
    if (normalized.confirmation) {
      brandConfirmations.push({
        ...normalized.confirmation,
        ingredientId: ingredient.id,
        sourceText: ingredient.sourceText,
      });
    }
    return { ...ingredient, name: normalized.name };
  });
  draft.source = {
    ...draft.source,
    originalWording: structured.acquired.originalWording,
  };
  return {
    brandConfirmations,
    draft,
    standardizedTags: inferStandardImportTags(structured.candidate),
    ...(structured.acquired.fallback
      ? { fallback: structured.acquired.fallback }
      : {}),
    warnings,
  };
}

export function mapImportIngredients(
  normalized: NormalizedImport,
): MappedImport {
  const warnings = [...normalized.warnings];
  const steps = normalized.draft.steps;
  const mappings = normalized.draft.ingredients.map((ingredient) => {
    const componentSteps = steps.filter(
      (step) => step.componentId === ingredient.componentId,
    );
    const significant = ingredient.name
      .toLocaleLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2);
    let stepIds = componentSteps
      .filter((step) => {
        const text = step.instruction.toLocaleLowerCase();
        return significant.some((token) => text.includes(token));
      })
      .map((step) => step.id);
    if (stepIds.length === 0 && componentSteps[0]) {
      stepIds = [componentSteps[0].id];
      warnings.push({
        code: "unmapped_ingredient",
        field: ingredient.id,
        message: "Ingredient-to-step mapping needs human confirmation.",
        severity: "warning",
      });
    }
    return { ingredientId: ingredient.id, stepIds };
  });
  const mappingByIngredient = new Map(
    mappings.map((mapping) => [mapping.ingredientId, mapping.stepIds]),
  );
  const draft: RecipeDraft = {
    ...structuredClone(normalized.draft),
    ingredients: normalized.draft.ingredients.map((ingredient) => ({
      ...ingredient,
      stepIds: mappingByIngredient.get(ingredient.id) ?? [],
    })),
  };
  return {
    ...normalized,
    dependencies: detectDependencies(draft),
    draft,
    mappings,
    warnings,
  };
}

function detectDependencies(draft: RecipeDraft): RecipeDependencyCandidate[] {
  return draft.steps.flatMap((step) => {
    const match = step.instruction.match(
      /\b(?:prepare|make|rest|chill|marinate)\s+([^,.]+)/i,
    );
    if (!match?.[1]) return [];
    return [
      {
        description: match[1].trim(),
        kind: "preparation" as const,
        stepId: step.id,
      },
    ];
  });
}

function parseQuantity(value: string): IngredientQuantity {
  const trimmed = value.trim();
  const mixed = trimmed.match(/^(\d+)\s+(\d+)\/(\d+)(?:\s+|$)(.*)$/);
  const simple = trimmed.match(
    /^(?:(\d+)\/(\d+)|(\d+(?:\.\d+)?))(?:\s+|$)(.*)$/,
  );
  const match = mixed ?? simple;
  if (!match) {
    return {
      kind: "measure",
      scaling: "proportional",
      text: trimmed || "as needed",
      unit: "",
    };
  }
  let numerator: number;
  let denominator: number;
  let unit: string;
  if (mixed) {
    denominator = Number(mixed[3]);
    numerator = Number(mixed[1]) * denominator + Number(mixed[2]);
    unit = (mixed[4] ?? "").trim();
  } else if (simple?.[1] && simple[2]) {
    denominator = Number(simple[2]);
    numerator = Number(simple[1]);
    unit = (simple[4] ?? "").trim();
  } else {
    const rational = decimalRational(Number(simple?.[3]));
    numerator = rational.numerator;
    denominator = rational.denominator;
    unit = (simple?.[4] ?? "").trim();
  }
  return {
    asWritten: { from: { denominator, numerator } },
    kind: /package|packet|can/i.test(unit) ? "package" : "measure",
    scaling: "proportional",
    unit,
  };
}

function decimalRational(value: number): {
  denominator: number;
  numerator: number;
} {
  const text = String(value);
  const decimals = text.split(".")[1]?.length ?? 0;
  const denominator = 10 ** decimals;
  return { denominator, numerator: Math.round(value * denominator) };
}

function firstWord(value: string): string {
  return (
    value
      .trim()
      .split(/\s+/)[0]
      ?.replace(/[^\p{L}\p{N}-]/gu, "") ?? ""
  );
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function uniqueId(base: string, ids: Set<string>): string {
  let id = base;
  let suffix = 2;
  while (ids.has(id)) id = `${base}-${suffix++}`;
  ids.add(id);
  return id;
}
