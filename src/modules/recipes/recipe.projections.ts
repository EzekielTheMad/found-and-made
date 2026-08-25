import {
  divideRational,
  formatKitchenQuantity,
  multiplyRational,
  projectIngredient,
  rationalFromNumber,
  type UnitPreference,
} from "./recipe.scaling";
import type {
  MergeGridCell,
  ProjectedIngredient,
  RecipeAggregate,
  RecipeProjection,
} from "./recipe.types";

export function projectRecipe(
  recipe: RecipeAggregate,
  targetYield = recipe.baseYield,
  unitPreference: UnitPreference = "as-written",
): RecipeProjection {
  if (!Number.isFinite(targetYield) || targetYield <= 0)
    throw new Error("Target yield must be a positive number");

  const factor = divideRational(
    rationalFromNumber(targetYield),
    rationalFromNumber(recipe.baseYield),
  );
  const ingredients = recipe.ingredients.map((ingredient) =>
    projectIngredient(ingredient, factor, unitPreference),
  );
  const ingredientById = new Map(
    ingredients.map((ingredient) => [ingredient.id, ingredient]),
  );
  const sortedComponents = [...recipe.components].sort(
    (left, right) => left.position - right.position,
  );
  const sortedSteps = [...recipe.steps].sort(
    (left, right) => left.position - right.position,
  );

  const classic = sortedComponents.map((component) => ({
    id: component.id,
    ingredients: ingredients.filter(
      (ingredient) => ingredient.componentId === component.id,
    ),
    name: component.name,
    steps: sortedSteps.filter((step) => step.componentId === component.id),
  }));

  const guided = sortedSteps.map((step) => ({
    ...step,
    ingredients: recipe.ingredients
      .filter((ingredient) => ingredient.stepIds.includes(step.id))
      .map((ingredient) => ingredientById.get(ingredient.id))
      .filter(
        (ingredient): ingredient is ProjectedIngredient =>
          ingredient !== undefined,
      ),
  }));

  const actions = Array.from(new Set(sortedSteps.map((step) => step.action)));
  const stepsById = new Map(sortedSteps.map((step) => [step.id, step]));
  const rows = ingredients.map((ingredient) => {
    const cells: MergeGridCell[] = ingredient.stepIds.flatMap((stepId) => {
      const step = stepsById.get(stepId);
      return step ? [{ action: step.action, stepId }] : [];
    });
    return {
      cells,
      componentId: ingredient.componentId,
      ingredient,
    };
  });
  const subRecipes = recipe.subRecipes.map((subRecipe) => {
    const projectedRequiredYield = multiplyRational(
      rationalFromNumber(subRecipe.requiredYield),
      factor,
    );
    return {
      ...subRecipe,
      displayRequiredYield: formatKitchenQuantity(projectedRequiredYield),
      projectedRequiredYield,
      stepIds: [...subRecipe.stepIds],
    };
  });

  return {
    baseYield: recipe.baseYield,
    classic,
    equipment: recipe.equipment.map((equipment) => ({ ...equipment })),
    factor,
    guided,
    id: recipe.id,
    mergeGrid: { actions, rows },
    subRecipes,
    targetYield,
    title: recipe.title,
    version: recipe.version,
    yieldText: recipe.yieldText,
  };
}
