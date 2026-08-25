import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { projectRecipe } from "#src/modules/recipes/recipe.projections";
import {
  formatKitchenQuantity,
  rational,
} from "#src/modules/recipes/recipe.scaling";
import type { RecipeAggregate } from "#src/modules/recipes/recipe.types";
import { fingerprintRecipe } from "#src/modules/recipes/recipe.validation";
import { fourServingRecipe } from "../fixtures/four-serving-recipe";

describe("recipe scaling and projections", () => {
  it.each([
    [4, "1", "2–3 cups"],
    [6, "1½", "3–4½ cups"],
    [8, "2", "4–6 cups"],
    [12, "3", "6–9 cups"],
  ])(
    "keeps Classic, Guided, and Grid quantities aligned at %s servings",
    (targetYield, onionQuantity, tomatoQuantity) => {
      const recipe = aggregate();
      const projection = projectRecipe(recipe, targetYield);

      const classicIngredients = projection.classic.flatMap(
        (component) => component.ingredients,
      );
      const onion = classicIngredients.find(
        (ingredient) => ingredient.id === "onion",
      );
      const tomatoes = classicIngredients.find(
        (ingredient) => ingredient.id === "tomatoes",
      );
      expect(onion?.displayQuantity).toBe(onionQuantity);
      expect(tomatoes?.displayQuantity).toBe(tomatoQuantity);

      const guidedOnion = projection.guided
        .flatMap((step) => step.ingredients)
        .find((ingredient) => ingredient.id === "onion");
      const gridOnion = projection.mergeGrid.rows.find(
        (row) => row.ingredient.id === "onion",
      )?.ingredient;
      expect(guidedOnion?.quantity).toEqual(onion?.quantity);
      expect(gridOnion?.quantity).toEqual(onion?.quantity);
    },
  );

  it("keeps time, temperature, pan, and package values invariant", () => {
    const projection = projectRecipe(aggregate(), 12);
    const bake = projection.guided.find((step) => step.id === "bake");
    const noodles = projection.classic
      .flatMap((component) => component.ingredients)
      .find((ingredient) => ingredient.id === "noodles");

    expect(bake).toMatchObject({
      panGuidance: "Use a 9 × 13 inch baking dish.",
      temperature: "375°F",
      time: "45 minutes",
    });
    expect(noodles?.displayQuantity).toBe("1 package");
    expect(noodles?.guidance).toContain("do not scale automatically");
  });

  it("keeps unit conversion independent from serving scaling", () => {
    const asWritten = projectRecipe(aggregate(), 6, "as-written");
    const metric = projectRecipe(aggregate(), 6, "metric");
    const getBeef = (projection: ReturnType<typeof projectRecipe>) =>
      projection.classic
        .flatMap((component) => component.ingredients)
        .find((ingredient) => ingredient.id === "beef");

    expect(getBeef(asWritten)?.displayQuantity).toBe("1½ lb");
    expect(getBeef(metric)?.displayQuantity).toBe("680 g");
  });

  it("preserves text-only quantities at every serving target", () => {
    const draft = fourServingRecipe();
    draft.ingredients = draft.ingredients.map((ingredient) =>
      ingredient.id === "parsley"
        ? {
            ...ingredient,
            quantity: {
              kind: "measure",
              scaling: "invariant",
              text: "to taste",
              unit: "",
            },
            sourceText: "parsley, to taste",
          }
        : ingredient,
    );
    const projection = projectRecipe(
      {
        ...draft,
        createdAt: "2026-07-30T00:00:00.000Z",
        fingerprint: fingerprintRecipe(draft),
        id: "text-quantity",
        updatedAt: "2026-07-30T00:00:00.000Z",
        version: 1,
      },
      12,
    );
    const parsley = projection.classic
      .flatMap((component) => component.ingredients)
      .find((ingredient) => ingredient.id === "parsley");
    expect(parsley?.displayQuantity).toBe("to taste");
    expect(parsley?.quantity).toBeUndefined();
  });

  it("maintains exact cross-view quantity parity over the full slider range", () => {
    const recipe = aggregate();
    fc.assert(
      fc.property(fc.integer({ max: 24, min: 1 }), (targetYield) => {
        const projection = projectRecipe(recipe, targetYield);
        const classic = new Map(
          projection.classic
            .flatMap((component) => component.ingredients)
            .map((ingredient) => [ingredient.id, ingredient.quantity]),
        );
        const guided = new Map(
          projection.guided
            .flatMap((step) => step.ingredients)
            .map((ingredient) => [ingredient.id, ingredient.quantity]),
        );
        for (const row of projection.mergeGrid.rows) {
          expect(row.ingredient.quantity).toEqual(
            classic.get(row.ingredient.id),
          );
          expect(row.ingredient.quantity).toEqual(
            guided.get(row.ingredient.id),
          );
        }
      }),
      { numRuns: 100 },
    );
  });

  it("formats thirds and kitchen fractions without decimal drift", () => {
    expect(formatKitchenQuantity(rational(2, 3))).toBe("⅔");
    expect(formatKitchenQuantity(rational(3, 2))).toBe("1½");
    expect(formatKitchenQuantity(rational(21, 8))).toBe("2⅝");
  });
});

function aggregate(): RecipeAggregate {
  const draft = fourServingRecipe();
  return {
    ...draft,
    createdAt: "2026-07-30T00:00:00.000Z",
    fingerprint: fingerprintRecipe(draft),
    id: "recipe-lasagna",
    updatedAt: "2026-07-30T00:00:00.000Z",
    version: 1,
  };
}
