import { describe, expect, it } from "vitest";

import { inferStandardImportTags } from "#src/modules/imports/import-classification";
import type { StructuredRecipeCandidate } from "#src/modules/imports/import.types";

describe("standard import classification", () => {
  it("maps source language to a small canonical vocabulary", () => {
    expect(
      inferStandardImportTags(
        recipe("Ninja Creami chocolate ice cream", [
          "Desserts",
          "Summer recipes",
        ]),
      ),
    ).toEqual(["Dessert", "Seasonal"]);
    expect(
      inferStandardImportTags(
        recipe("Blood orange margarita", ["cocktail", "drinks"]),
      ),
    ).toEqual(["Cocktails"]);
    expect(
      inferStandardImportTags(recipe("Smash burgers", ["Main Dishes"])),
    ).toEqual(["Dinner"]);
  });

  it("never copies arbitrary source tags and caps assignments at three", () => {
    const tags = inferStandardImportTags(
      recipe("Holiday brunch salad and dessert cocktail", [
        "Breakfast",
        "Lunch",
        "Dinner",
        "user-generated-tag-1",
        "user-generated-tag-2",
      ]),
    );
    expect(tags).toHaveLength(3);
    expect(tags).toEqual(["Breakfast", "Lunch", "Dinner"]);
    expect(tags).not.toContain("user-generated-tag-1");
  });
});

function recipe(
  title: string,
  classificationHints: string[],
): StructuredRecipeCandidate {
  return {
    baseYield: 1,
    classificationHints,
    ingredients: [],
    steps: [],
    title,
    yieldText: "1 serving",
  };
}
