import { randomUUID } from "node:crypto";

import type { RecipeAggregate } from "#src/modules/recipes/recipe.types";
import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/exports-selection";

export async function action({ context, request }: Route.ActionArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const form = await request.formData();
  try {
    const recipeIds = form
      .getAll("recipeIds")
      .filter((value): value is string => typeof value === "string");
    if (recipeIds.length === 0) throw new Error("Select at least one recipe");
    if (recipeIds.length > 500)
      throw new Error("Select no more than 500 recipes");

    const includeSource = form.get("includeSource") === "on";
    const includeClassifications = form.get("includeClassifications") === "on";
    const includePhotoReferences = form.get("includePhotoReferences") === "on";
    const unitPreference =
      field(form, "unitPreference") === "metric" ? "metric" : "as-written";
    const exportedAt = new Date().toISOString();
    const recipes = recipeIds.map((recipeId) => {
      const exported = runtime.exportService.exportRecipeJson(
        principal,
        recipeId,
        { unitPreference },
      ).dto;
      const portableRecipe = withoutInternalRecipeFields(exported.recipe);
      return {
        ...(includePhotoReferences ? { media: exported.media } : {}),
        projection: exported.projection,
        recipe: {
          ...portableRecipe,
          ...(!includeClassifications ? { allergens: [], diets: [] } : {}),
          ...(!includeSource ? { creatorName: undefined, source: {} } : {}),
        },
        targetYield: exported.targetYield,
        unitPreference: exported.unitPreference,
      };
    });
    const artifactName = `recipe-selection-${randomUUID()}.json`;
    return new Response(
      `${JSON.stringify(
        {
          exportedAt,
          recipeCount: recipes.length,
          recipes,
          schema: "found-made.recipe-selection-export",
          version: 1,
        },
        null,
        2,
      )}\n`,
      {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Disposition": `attachment; filename="${artifactName}"`,
          "Content-Type": "application/json; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch {
    return Response.json(
      { error: "Recipe selection export failed" },
      { headers: { "Cache-Control": "private, no-store" }, status: 400 },
    );
  }
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function withoutInternalRecipeFields(
  recipe: RecipeAggregate,
): Omit<RecipeAggregate, "createdByUserId" | "fingerprint"> {
  const { createdByUserId, fingerprint, ...portableRecipe } = recipe;
  void createdByUserId;
  void fingerprint;
  return portableRecipe;
}
