import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { parseMigrationUpload } from "#src/modules/imports/migration-archive.server";

function recipe(name: string) {
  return {
    name,
    recipeIngredient: ["1 cup beans"],
    recipeInstructions: ["Simmer the beans."],
    recipeServings: 4,
  };
}

describe("migration archive parsing", () => {
  it("expands a Mealie collection into distinct durable import sources", async () => {
    const file = new File(
      [JSON.stringify({ items: [recipe("Bean soup"), recipe("Bean stew")] })],
      "mealie-recipes.json",
      { type: "application/json" },
    );

    const parsed = await parseMigrationUpload(file, "mealie");

    expect(parsed).toHaveLength(2);
    expect(parsed.map((item) => item.source.payload)).toMatchObject([
      { name: "Bean soup" },
      { name: "Bean stew" },
    ]);
    expect(parsed.every((item) => item.source.kind === "migration_json")).toBe(
      true,
    );
  });

  it("reads native Mealie backup recipes with snake-case fields", async () => {
    const archive = zipSync({
      "recipes/bean-soup/bean-soup.json": strToU8(
        JSON.stringify({
          author: { name: "Mealie Export Author" },
          name: "Native Mealie soup",
          orgURL: "https://recipes.example.test/native-mealie-soup",
          recipe_ingredient: [
            {
              display: "2 cups beans",
              note: "beans",
              quantity: 2,
              unit: { name: "cups" },
            },
          ],
          recipe_instructions: [{ text: "Simmer the beans." }],
          recipe_servings: 4,
          recipe_yield: "4 servings",
        }),
      ),
      "Recipes/Bean-Soup/Images/ORIGINAL.WEBP": new Uint8Array([1, 2, 3]),
    });

    const parsed = await parseMigrationUpload(
      new File([Buffer.from(archive)], "mealie-backup.zip"),
      "mealie",
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      heroImage: {
        bytes: new Uint8Array([1, 2, 3]),
        fileName: "Recipes/Bean-Soup/Images/ORIGINAL.WEBP",
      },
      source: {
        payload: {
          author: { name: "Mealie Export Author" },
          name: "Native Mealie soup",
          orgURL: "https://recipes.example.test/native-mealie-soup",
          recipe_ingredient: [{ note: "beans", quantity: 2 }],
          recipe_instructions: [{ text: "Simmer the beans." }],
        },
      },
      sourceName: "recipes/bean-soup/bean-soup.json",
    });
  });

  it("finds a Tandoor recipe inside an export wrapper", async () => {
    const parsed = await parseMigrationUpload(
      new File(
        [
          JSON.stringify({
            recipe: {
              name: "Tandoor soup",
              servings: 4,
              steps: [
                {
                  ingredients: [
                    { amount: 1, food: { name: "beans" }, unit: "cup" },
                  ],
                  instruction: "Simmer the beans.",
                },
              ],
            },
          }),
        ],
        "tandoor-export.json",
      ),
      "tandoor",
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.source.payload).toMatchObject({ name: "Tandoor soup" });
  });

  it("reads Nextcloud Cookbook recipe.json files and ignores archive media", async () => {
    const archive = zipSync({
      "Recipes/Soup/full.jpg": new Uint8Array([1, 2, 3]),
      "Recipes/Soup/recipe.json": strToU8(JSON.stringify(recipe("Soup"))),
      "Recipes/Stew/recipe.json": strToU8(JSON.stringify(recipe("Stew"))),
      "settings.json": strToU8(JSON.stringify({ theme: "dark" })),
    });
    const file = new File([Buffer.from(archive)], "Recipes.zip", {
      type: "application/zip",
    });

    const parsed = await parseMigrationUpload(file, "nextcloud");

    expect(parsed.map((item) => item.sourceName)).toEqual([
      "Recipes/Soup/recipe.json",
      "Recipes/Stew/recipe.json",
    ]);
  });

  it("deduplicates repeated recipe records across export documents", async () => {
    const archive = zipSync({
      "first.json": strToU8(JSON.stringify(recipe("Soup"))),
      "second.json": strToU8(JSON.stringify(recipe("Soup"))),
    });

    const parsed = await parseMigrationUpload(
      new File([Buffer.from(archive)], "recipes.zip"),
      "schema_org",
    );

    expect(parsed).toHaveLength(1);
  });

  it("accepts full Recipe IRIs and nested Schema.org instructions", async () => {
    const parsed = await parseMigrationUpload(
      new File(
        [
          JSON.stringify({
            "@type": "https://schema.org/Recipe",
            name: "Nested soup",
            recipeIngredient: "1 cup lentils",
            recipeInstructions: {
              "@type": "HowToSection",
              itemListElement: [
                { "@type": "HowToStep", text: "Simmer the lentils." },
              ],
            },
          }),
        ],
        "recipe.jsonld",
      ),
      "schema_org",
    );

    expect(parsed).toHaveLength(1);
  });

  it("rejects database dumps and unrelated JSON instead of creating empty recipes", async () => {
    const file = new File(
      [JSON.stringify({ users: [{ email: "private@example.com" }] })],
      "database.json",
    );

    await expect(parseMigrationUpload(file, "mealie")).rejects.toThrow(
      /No supported recipes were found/,
    );
  });

  it("bounds a migration batch before any import sessions are created", async () => {
    const recipes = Array.from({ length: 501 }, (_, index) =>
      recipe(`Recipe ${index + 1}`),
    );

    await expect(
      parseMigrationUpload(
        new File([JSON.stringify(recipes)], "too-many.json"),
        "mealie",
      ),
    ).rejects.toThrow(/limited to 500 recipes/);
  });
});
