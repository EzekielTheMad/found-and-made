import type { CookingService } from "../../modules/cooking/cooking.service.server";
import type {
  CookingTimer,
  PersonalOfflineOperation,
} from "../../modules/cooking/cooking.types";
import type { Principal } from "../../modules/identity/identity.types";
import type { MediaService } from "../../modules/media/media.service.server";
import {
  parseOfflineOperation,
  type OfflineOperation,
} from "../../modules/offline/offline-queue";
import type { RecipeAccessService } from "../../modules/recipes/recipe-access.service.server";

interface OfflineServices {
  cooking: CookingService;
  media: MediaService;
  recipes: RecipeAccessService;
}

export function offlineLibrary(
  principal: Principal,
  services: OfflineServices,
) {
  return {
    generatedAt: new Date().toISOString(),
    recipes: services.recipes.list(principal).map((recipe) => {
      const hero = services.media.hero(recipe.id);
      return {
        cached: false,
        ...(hero
          ? {
              heroAlt: hero.altText,
              heroUrl: `/api/media/${hero.id}/web`,
            }
          : {}),
        id: recipe.id,
        title: recipe.title,
        updatedAt: recipe.updatedAt,
        yieldText: recipe.yieldText,
      };
    }),
  };
}

export function offlineRecipe(
  principal: Principal,
  recipeId: string,
  services: OfflineServices,
) {
  const recipe = services.recipes.get(principal, recipeId);
  const summary = services.cooking.getForRecipe(principal, recipeId);
  const session = summary.activeSession;
  const checked = new Set(session?.checkedIngredientIds ?? []);
  const guidedStepIndex = session?.guidedStepIndex ?? 0;
  return {
    baseYield: recipe.baseYield,
    id: recipe.id,
    ingredients: recipe.ingredients.map((ingredient) => ({
      checked: checked.has(ingredient.id),
      componentId: ingredient.componentId,
      id: ingredient.id,
      name: ingredient.name,
      quantity: ingredient.quantity,
      requirement: ingredient.requirement,
    })),
    media: services.media.list(principal, recipe.id).map((asset) => ({
      altText: asset.altText,
      ...(asset.componentId ? { componentId: asset.componentId } : {}),
      role: asset.role,
      ...(asset.stepId ? { stepId: asset.stepId } : {}),
      url: `/api/media/${asset.id}/web`,
    })),
    personal: {
      favorite: summary.state.favorite,
      note: summary.state.note,
      rating: summary.state.rating ?? null,
      sessionId: session?.id ?? null,
      sessionVersion: session?.version ?? 0,
      stateVersion: summary.state.version,
      targetYield: session?.targetServings ?? recipe.baseYield,
      timers:
        session?.timers.map((timer) => ({
          durationSeconds: timer.durationSeconds,
          id: timer.id,
          label: timer.label,
          remainingSeconds: timer.remainingSeconds,
          startedAt: timer.startedAt ?? null,
          state: timer.status === "completed" ? "complete" : timer.status,
        })) ?? [],
    },
    steps: recipe.steps.map((step, index) => ({
      action: step.action,
      id: step.id,
      instruction: step.instruction,
      status:
        index < guidedStepIndex
          ? ("completed" as const)
          : index === guidedStepIndex && session
            ? ("active" as const)
            : ("pending" as const),
      ...(step.temperature ? { temperature: step.temperature } : {}),
      ...(step.time ? { time: step.time } : {}),
    })),
    title: recipe.title,
    updatedAt: recipe.updatedAt,
    yieldText: recipe.yieldText,
  };
}

export function applyOfflineOperations(
  principal: Principal,
  values: readonly unknown[],
  cooking: CookingService,
  recipes: RecipeAccessService,
): string[] {
  if (values.length > 100)
    throw new Error("At most 100 offline operations may sync at once");
  return values.map((value) => {
    const operation = parseOfflineOperation(value);
    const recipe = recipes.get(principal, operation.recipeId);
    cooking.applyOfflineOperation(
      principal,
      toPersonalOfflineOperation(operation, recipe.baseYield),
    );
    return operation.id;
  });
}

export function toPersonalOfflineOperation(
  operation: OfflineOperation,
  baseYield: number,
): PersonalOfflineOperation {
  const payload = operation.payload;
  if (operation.kind === "cooking.note.set") {
    return {
      clientOperationId: operation.id,
      fields: { note: stringField(payload, "value") },
      kind: "personal.update",
      recipeId: operation.recipeId,
    };
  }

  const expectedVersion = integerField(payload, "expectedVersion");
  const clientSessionId = stringField(payload, "clientSessionId");
  const input = sessionInput(operation, baseYield);
  if (expectedVersion === 0) {
    return {
      clientOperationId: operation.id,
      input: { ...input, clientSessionId },
      kind: "session.start",
      recipeId: operation.recipeId,
    };
  }
  return {
    clientOperationId: operation.id,
    expectedVersion,
    input,
    kind: "session.update",
    recipeId: operation.recipeId,
    sessionId: stringField(payload, "sessionId"),
  };
}

function sessionInput(
  operation: OfflineOperation,
  baseYield: number,
): {
  checkedIngredientIds?: readonly string[];
  guidedStepIndex?: number;
  targetServings?: number;
  timers?: readonly CookingTimer[];
} & { targetServings: number } {
  const payload = operation.payload;
  switch (operation.kind) {
    case "cooking.ingredient-check.set":
      return {
        checkedIngredientIds: stringArrayField(payload, "checkedIngredientIds"),
        targetServings: numberField(payload, "targetYield", baseYield),
      };
    case "cooking.step-progress.set":
      return {
        guidedStepIndex: integerField(payload, "guidedStepIndex"),
        targetServings: numberField(payload, "targetYield", baseYield),
      };
    case "cooking.timer.set":
      return {
        targetServings: numberField(payload, "targetYield", baseYield),
        timers: timerArrayField(payload, "timers"),
      };
    case "cooking.scale.set":
      return { targetServings: numberField(payload, "targetYield") };
    case "cooking.note.set":
      throw new Error("Notes are not cooking-session operations");
  }
}

function timerArrayField(
  record: Readonly<Record<string, unknown>>,
  name: string,
): CookingTimer[] {
  const value = record[name];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new Error("Timer must be an object");
    const timer = candidate as Record<string, unknown>;
    const status = stringField(timer, "status");
    return {
      durationSeconds: numberField(timer, "durationSeconds"),
      id: stringField(timer, "id"),
      label: stringField(timer, "label"),
      remainingSeconds: numberField(timer, "remainingSeconds"),
      ...(typeof timer.startedAt === "string"
        ? { startedAt: timer.startedAt }
        : {}),
      status: status === "complete" ? "completed" : cookingTimerStatus(status),
    };
  });
}

function cookingTimerStatus(
  value: string,
): "cancelled" | "completed" | "paused" | "running" {
  if (
    value === "cancelled" ||
    value === "completed" ||
    value === "paused" ||
    value === "running"
  ) {
    return value;
  }
  throw new Error("Unknown cooking timer status");
}

function stringArrayField(
  record: Readonly<Record<string, unknown>>,
  name: string,
): string[] {
  const value = record[name];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(`${name} must be a string array`);
  return value;
}

function stringField(
  record: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = record[name];
  if (typeof value !== "string" || !value)
    throw new Error(`${name} is required`);
  return value;
}

function integerField(
  record: Readonly<Record<string, unknown>>,
  name: string,
): number {
  const value = record[name];
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error(`${name} must be an integer`);
  return value;
}

function numberField(
  record: Readonly<Record<string, unknown>>,
  name: string,
  fallback?: number,
): number {
  const value = record[name];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} must be a number`);
  return value;
}
