import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { McpScaledRecipeDto } from "#src/modules/mcp/mcp.types";
import type { PrintRenderRecipe } from "#src/modules/printing/print-renderer.types.server";
import { createRuntime, type AppRuntime } from "#src/platform/runtime.server";
import { fourServingRecipe } from "../fixtures/four-serving-recipe";

describe("shared recipe projection parity", () => {
  const cleanup: Array<{ directory: string; runtime: AppRuntime }> = [];

  afterEach(async () => {
    for (const item of cleanup.splice(0)) {
      await item.runtime.close();
      await rm(item.directory, { force: true, recursive: true });
    }
  });

  it("keeps UI, print, export, and Hermes quantities identical at 6, 8, and 12 servings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "found-made-parity-"));
    const runtime = await createRuntime({
      dataDir: directory,
      startWorker: false,
    });
    cleanup.push({ directory, runtime });
    const account = await runtime.identityService.createInitialOwner({
      email: "parity-owner@example.test",
      name: "Parity Owner",
      password: "parity owner password",
    });
    const owner = {
      kind: "user",
      role: "owner",
      userId: account.id,
    } as const;
    const recipe = runtime.recipeAccessService.create(
      owner,
      fourServingRecipe(),
    );
    const profile = runtime.printingService.createProfile(owner, {
      config: {
        defaultLayout: "classic-single-column",
        duplex: true,
        includeMetadata: true,
        includePhotos: false,
        marginsMm: { bottom: 12, left: 12, right: 12, top: 12 },
        pageSize: "letter",
        typography: {
          bodyFontSizePt: 10,
          fontFamily: "Source Serif 4",
          headingFontSizePt: 20,
        },
      },
      name: "Parity profile",
    });
    runtime.mcpService.setRecipeApproval(owner, recipe.id, true);
    const token = runtime.mcpService.issueToken(owner, {
      name: "Parity token",
      scopes: ["recipes:read"],
    });

    for (const targetServings of [6, 8, 12]) {
      const uiProjection = runtime.recipeAccessService.project(
        owner,
        recipe.id,
        targetServings,
      );
      const exported = runtime.exportService.exportRecipeJson(
        owner,
        recipe.id,
        { targetYield: targetServings },
      );
      const printJob = runtime.printingService.createPrintJob(owner, {
        idempotencyKey: `parity-${targetServings}`,
        profileId: profile.id,
        selections: [{ recipeId: recipe.id, targetServings }],
      });
      const printDocument =
        await runtime.printGenerationService.prepareDocument(
          owner,
          printJob.request,
          { includeImageBytes: false },
        );
      const printRecipe = printDocument.outline.find(
        (item): item is { kind: "recipe"; recipe: PrintRenderRecipe } =>
          item.kind === "recipe",
      )?.recipe;
      const hermes = runtime.mcpService.execute(token.token, {
        arguments: {
          recipeId: recipe.id,
          targetServings,
          unitPreference: "as-written",
        },
        tool: "get_scaled_recipe",
      }) as McpScaledRecipeDto;
      const expected = uiProjection.classic.flatMap((component) =>
        component.ingredients.map((ingredient) => ({
          amount: ingredient.displayQuantity,
          name: ingredient.name,
        })),
      );

      expect(exported.dto.projection).toEqual(uiProjection);
      expect(
        printRecipe?.ingredients.map((ingredient) => ({
          amount: ingredient.displayQuantity,
          name: ingredient.name,
        })),
      ).toEqual(expected);
      expect(
        hermes.ingredients.map((ingredient) => ({
          amount: ingredient.amount,
          name: ingredient.name,
        })),
      ).toEqual(expected);
      expect(printRecipe?.targetServings).toBe(targetServings);
      expect(hermes.targetServings).toBe(targetServings);
      expect(
        hermes.steps.map(({ temperature, time }) => ({ temperature, time })),
      ).toEqual(
        recipe.steps.map(({ temperature, time }) => ({ temperature, time })),
      );
    }
  });
});
