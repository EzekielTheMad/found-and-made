import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RecipeConflictError,
  RecipeDuplicateError,
  RecipeValidationError,
  type RecipeDraft,
} from "#src/modules/recipes/recipe.types";
import { createRuntime, type AppRuntime } from "#src/platform/runtime.server";
import { fourServingRecipe } from "../fixtures/four-serving-recipe";

describe("recipe application service", () => {
  const cleanup: Array<{ directory: string; runtime?: AppRuntime }> = [];

  afterEach(async () => {
    for (const item of cleanup.splice(0)) {
      await item.runtime?.close();
      await rm(item.directory, { force: true, recursive: true });
    }
  });

  it("persists a canonical recipe and all three projections across reopen", async () => {
    const item = await runtimeFixture();
    const created = item.runtime.recipeService.create(fourServingRecipe(), {
      now: new Date("2026-07-30T00:00:00.000Z"),
    });
    expect(created.source.canonicalUrl).toBe(
      "https://example.com/lasagna?a=1&b=2",
    );
    await item.runtime.close();
    item.runtime = await createRuntime({
      dataDir: item.directory,
      startWorker: false,
    });

    const reloaded = item.runtime.recipeService.get(created.id);
    expect(reloaded).toEqual(created);
    const projection = item.runtime.recipeService.project(created.id, 8);
    expect(projection.classic).toHaveLength(3);
    expect(projection.guided).toHaveLength(6);
    expect(projection.mergeGrid.actions).toEqual([
      "soffritto",
      "brown",
      "simmer",
      "roux",
      "layer",
      "bake",
    ]);
  });

  it("preserves immutable uploader provenance while editing recipe creator metadata", async () => {
    const { runtime } = await runtimeFixture();
    const created = runtime.recipeService.create(
      fourServingRecipe({ creatorName: "  Aunt June  " }),
      { createdByUserId: "uploader-user" },
    );

    expect(created).toMatchObject({
      createdByUserId: "uploader-user",
      creatorName: "Aunt June",
    });
    expect(runtime.recipeService.list()[0]).toMatchObject({
      createdByUserId: "uploader-user",
    });

    const draft = editable(created);
    draft.creatorName = "Family friend Sam";
    draft.sharedNotes = "  Use the blue serving dish.\r\nMade every winter.  ";
    const updated = runtime.recipeService.update(created.id, draft, {
      expectedVersion: created.version,
      reason: "Corrected creator attribution",
    });
    expect(updated).toMatchObject({
      createdByUserId: "uploader-user",
      creatorName: "Family friend Sam",
      sharedNotes: "Use the blue serving dish.\nMade every winter.",
    });
  });

  it("sanitizes single-line metadata and rejects unsafe source URLs", async () => {
    const { runtime } = await runtimeFixture();
    const created = runtime.recipeService.create(
      fourServingRecipe({
        creatorName: "  Aunt\u0000   June\u202e  ",
        source: {
          originalUrl: "https://EXAMPLE.com/family/?b=2&a=1#private",
        },
        title: `  Sunday\u0000   Lasagna\u202e ${"x".repeat(400)}  `,
        yieldText: "  Serves\u0000   4\u202e  ",
      }),
    );

    expect(created.creatorName).toBe("Aunt June");
    expect(created.title).toHaveLength(300);
    expect(created.title).toMatch(/^Sunday Lasagna x+/);
    expect(created.yieldText).toBe("Serves 4");
    expect(created.source).toMatchObject({
      canonicalUrl: "https://example.com/family?a=1&b=2",
      originalUrl: "https://example.com/family?a=1&b=2",
    });

    expect(() =>
      runtime.recipeService.create(
        fourServingRecipe({
          source: { originalUrl: "https://user:secret@example.com/recipe" },
        }),
      ),
    ).toThrow(/credentials/);
    expect(() =>
      runtime.recipeService.create(
        fourServingRecipe({
          source: {
            originalUrl: `https://example.com/${"x".repeat(2_100)}`,
          },
        }),
      ),
    ).toThrow(/2048/);
  });

  it("detects stale edits and retains revision snapshots", async () => {
    const { runtime } = await runtimeFixture();
    const created = runtime.recipeService.create(fourServingRecipe());
    const draft = editable(created);
    draft.title = "Sunday Lasagna, Updated";
    const updated = runtime.recipeService.update(created.id, draft, {
      expectedVersion: 1,
      now: new Date("2026-07-30T01:00:00.000Z"),
      reason: "Updated title",
    });

    expect(updated.version).toBe(2);
    expect(runtime.recipeService.revisions(created.id)).toMatchObject([
      {
        reason: "Updated title",
        snapshot: { title: "Sunday Lasagna", version: 1 },
        version: 1,
      },
    ]);
    expect(() =>
      runtime.recipeService.update(created.id, draft, {
        expectedVersion: 1,
        reason: "Stale browser tab",
      }),
    ).toThrow(RecipeConflictError);
  });

  it("creates an independent scaled variant without mutating its origin", async () => {
    const { runtime } = await runtimeFixture();
    const original = runtime.recipeService.create(fourServingRecipe());
    const variant = runtime.recipeService.saveVariant(
      original.id,
      6,
      "Sunday Lasagna for Six",
      new Date("2026-07-30T02:00:00.000Z"),
    );

    expect(variant.variantOfId).toBe(original.id);
    expect(variant.baseYield).toBe(6);
    expect(
      variant.ingredients.find((ingredient) => ingredient.id === "onion")
        ?.quantity.asWritten?.from,
    ).toEqual({ denominator: 2, numerator: 3 });
    expect(
      variant.ingredients.find((ingredient) => ingredient.id === "noodles")
        ?.quantity.asWritten?.from,
    ).toEqual({ denominator: 1, numerator: 1 });
    expect(runtime.recipeService.get(original.id)).toEqual(original);

    const originalDraft = editable(original);
    originalDraft.title = "Sunday Lasagna, Family Edition";
    const updatedOriginal = runtime.recipeService.update(
      original.id,
      originalDraft,
      {
        expectedVersion: original.version,
        reason: "Edited original after saving a variant",
      },
    );
    expect(updatedOriginal.title).toBe("Sunday Lasagna, Family Edition");
  });

  it("soft deletes and restores while preserving history", async () => {
    const { runtime } = await runtimeFixture();
    const recipe = runtime.recipeService.create(fourServingRecipe());
    const trashed = runtime.recipeService.trash(
      recipe.id,
      recipe.version,
      new Date("2026-07-30T03:00:00.000Z"),
    );

    expect(runtime.recipeService.list()).toEqual([]);
    expect(runtime.recipeService.list(true)[0]?.deletedAt).toBeDefined();
    const restored = runtime.recipeService.restore(
      recipe.id,
      trashed.version,
      new Date("2026-07-30T04:00:00.000Z"),
    );
    expect(restored.deletedAt).toBeUndefined();
    expect(restored.version).toBe(3);
    expect(runtime.recipeService.revisions(recipe.id)).toHaveLength(2);
  });

  it("bulk trashes atomically and lets a clean re-import ignore recycled recipes", async () => {
    const { runtime } = await runtimeFixture();
    const first = runtime.recipeService.create(fourServingRecipe());
    const second = runtime.recipeService.create(
      fourServingRecipe({
        source: { originalUrl: "https://example.com/second-lasagna" },
        title: "Second Lasagna",
      }),
    );

    expect(() =>
      runtime.recipeService.trashMany([
        { expectedVersion: first.version, id: first.id },
        { expectedVersion: second.version + 1, id: second.id },
      ]),
    ).toThrow(RecipeConflictError);
    expect(runtime.recipeService.list()).toHaveLength(2);

    runtime.recipeService.trashMany([
      { expectedVersion: first.version, id: first.id },
      { expectedVersion: second.version, id: second.id },
    ]);
    expect(runtime.recipeService.list()).toEqual([]);
    expect(runtime.recipeService.list(true)).toHaveLength(2);
    expect(() =>
      runtime.recipeService.create(fourServingRecipe()),
    ).not.toThrow();
  });

  it("restores an earlier revision as a new append-only revision", async () => {
    const { runtime } = await runtimeFixture();
    const created = runtime.recipeService.create(fourServingRecipe());
    const changedDraft = editable(created);
    changedDraft.title = "Changed Lasagna";
    const changed = runtime.recipeService.update(created.id, changedDraft, {
      expectedVersion: created.version,
      reason: "Changed title",
    });

    const restored = runtime.recipeService.restoreRevision(
      created.id,
      1,
      changed.version,
      new Date("2026-07-30T05:00:00.000Z"),
    );
    expect(restored).toMatchObject({
      title: "Sunday Lasagna",
      version: 3,
    });
    expect(runtime.recipeService.revisions(created.id)).toMatchObject([
      { reason: "Restored content from version 1", version: 2 },
      { reason: "Changed title", version: 1 },
    ]);
  });

  it("detects canonical-source and fingerprint duplicates", async () => {
    const { runtime } = await runtimeFixture();
    runtime.recipeService.create(fourServingRecipe());

    expect(() =>
      runtime.recipeService.create(
        fourServingRecipe({
          source: {
            originalUrl: "https://EXAMPLE.com/lasagna?a=1&b=2#different",
          },
        }),
      ),
    ).toThrow(RecipeDuplicateError);
  });

  it("links and scales reusable sub-recipes while rejecting dependency cycles", async () => {
    const { runtime } = await runtimeFixture();
    const sauce = runtime.recipeService.create(
      fourServingRecipe({
        source: {},
        title: "Besciamella Base",
        yieldText: "Makes sauce for 4 servings",
      }),
    );
    const mainDraft = fourServingRecipe({
      source: {},
      subRecipes: [
        {
          authoredYield: 4,
          componentId: "assembly",
          id: "besciamella-edge",
          recipeId: sauce.id,
          requiredYield: 4,
          stepIds: ["layer"],
          title: "Besciamella Base",
        },
      ],
      title: "Lasagna with linked sauce",
    });
    const main = runtime.recipeService.create(mainDraft);
    expect(
      runtime.recipeService.project(main.id, 8).subRecipes[0],
    ).toMatchObject({
      displayRequiredYield: "8",
      recipeId: sauce.id,
    });

    const cyclicSauce = editable(sauce);
    cyclicSauce.subRecipes = [
      {
        authoredYield: 4,
        componentId: "assembly",
        id: "lasagna-edge",
        recipeId: main.id,
        requiredYield: 4,
        stepIds: ["layer"],
        title: main.title,
      },
    ];
    expect(() =>
      runtime.recipeService.update(sauce.id, cyclicSauce, {
        expectedVersion: sauce.version,
        reason: "Attempt cycle",
      }),
    ).toThrow("Sub-recipe references cannot form a cycle");
  });

  it("rejects unmapped ingredients and cross-component mappings", async () => {
    const { runtime } = await runtimeFixture();
    const unmapped = fourServingRecipe();
    unmapped.ingredients[0] = {
      ...unmapped.ingredients[0],
      stepIds: [],
    };
    expect(() => runtime.recipeService.create(unmapped)).toThrow(
      RecipeValidationError,
    );

    const crossComponent = fourServingRecipe();
    crossComponent.ingredients[0] = {
      ...crossComponent.ingredients[0],
      stepIds: ["roux"],
    };
    expect(() => runtime.recipeService.create(crossComponent)).toThrow(
      RecipeValidationError,
    );
  });

  it("rejects malformed persisted aggregate JSON at the repository boundary", async () => {
    const { runtime } = await runtimeFixture();
    const created = runtime.recipeService.create(fourServingRecipe());
    runtime.database.sqlite
      .prepare("UPDATE recipes SET aggregate = ? WHERE id = ?")
      .run(JSON.stringify({ id: created.id, version: 1 }), created.id);

    expect(() => runtime.recipeService.get(created.id)).toThrow();
  });

  async function runtimeFixture() {
    const directory = await mkdtemp(join(tmpdir(), "found-made-recipes-"));
    const item: { directory: string; runtime: AppRuntime } = {
      directory,
      runtime: await createRuntime({
        dataDir: directory,
        startWorker: false,
      }),
    };
    cleanup.push(item);
    return item;
  }
});

function editable(
  recipe: ReturnType<AppRuntime["recipeService"]["get"]>,
): RecipeDraft {
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
