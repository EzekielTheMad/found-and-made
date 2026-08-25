import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";

import type { Principal } from "../../modules/identity/identity.types";
import type { MediaService } from "../../modules/media/media.service.server";
import {
  diagnosePrintFit,
  planPrintDocument,
  renderPrintDocument,
} from "../../modules/printing/pdf-renderer.server";
import type {
  PrintFitDiagnostic,
  PrintPagePlan,
  PrintLayout as RenderLayout,
  PrintRenderDocument,
  PrintRenderItem,
  PrintRenderRecipe,
} from "../../modules/printing/print-renderer.types.server";
import type { PrintingService } from "../../modules/printing/printing.service.server";
import type {
  PrintJob,
  PrintJobRequest,
  PrintLayout,
  PrintOutlineItem,
  PrintRecipeSelection,
} from "../../modules/printing/printing.types";
import type { RecipeAccessService } from "../../modules/recipes/recipe-access.service.server";

const POINTS_PER_MILLIMETER = 72 / 25.4;

export interface PrintGenerationResult {
  diagnostics: readonly PrintFitDiagnostic[];
  job: PrintJob;
  recipePageBoundaries: ReadonlyArray<{
    itemIndex: number;
    pageIndex: number;
    recipeId: string;
  }>;
}

export class PrintGenerationService {
  constructor(
    private readonly printing: PrintingService,
    private readonly recipes: RecipeAccessService,
    private readonly media: MediaService,
  ) {}

  collectionRequest(
    principal: Principal,
    collectionId: string,
  ): PrintJobRequest {
    const collection = this.printing.getCollection(principal, collectionId);
    if (!collection.profileId) {
      throw new Error(
        "A print profile is required before previewing a cookbook",
      );
    }
    const profile = this.printing.getProfile(principal, collection.profileId);
    const selections = collection.outline
      .filter(
        (item): item is Extract<PrintOutlineItem, { type: "recipe" }> =>
          item.type === "recipe",
      )
      .map((item) => {
        const recipe = this.recipes.get(principal, item.recipeId);
        return {
          layout: item.layoutOverride ?? collection.globalLayout,
          recipeId: recipe.id,
          recipeVersion: recipe.version,
          targetServings: item.targetServings ?? recipe.baseYield,
        };
      });
    return {
      collection,
      globalLayout: collection.globalLayout,
      numberingMode: collection.numberingMode,
      profile,
      selections,
    };
  }

  async prepareDocument(
    principal: Principal,
    request: PrintJobRequest,
    options: { includeImageBytes?: boolean } = {},
  ): Promise<PrintRenderDocument> {
    const recipeSelections = [...request.selections];
    let selectionIndex = 0;
    const sourceOutline: readonly PrintOutlineItem[] = request.collection
      ? request.collection.outline
      : recipeSelections.map((selection, index) => ({
          id: `direct-${index}`,
          layoutOverride: selection.layout,
          recipeId: selection.recipeId,
          targetServings: selection.targetServings,
          type: "recipe" as const,
        }));
    const outline: PrintRenderItem[] = [];

    for (const [outlineIndex, item] of sourceOutline.entries()) {
      if (item.type === "recipe") {
        const selection = recipeSelections[selectionIndex];
        selectionIndex += 1;
        if (!selection || selection.recipeId !== item.recipeId) {
          throw new Error(
            "Print outline and recipe selections are inconsistent",
          );
        }
        outline.push({
          kind: "recipe",
          recipe: await this.recipeDocument(
            principal,
            selection,
            request.profile.config.includePhotos,
            options.includeImageBytes ?? true,
          ),
        });
      } else if (item.type === "cover") {
        outline.push({
          kind: "cover",
          ...(item.subtitle ? { subtitle: item.subtitle } : {}),
          title: item.title,
        });
      } else if (item.type === "notes") {
        outline.push({
          kind: "notes",
          lineCount: item.lines,
          title: item.heading || "Notes",
        });
      } else {
        outline.push({
          ...(item.type === "section"
            ? {
                entries: recipesInSection(
                  sourceOutline,
                  outlineIndex,
                  (recipeId) => this.recipes.get(principal, recipeId).title,
                ),
              }
            : {}),
          ...(item.subtitle ? { description: item.subtitle } : {}),
          kind: item.type,
          title: item.title,
        });
      }
    }

    const config = request.profile.config;
    return {
      edition: request.numberingMode,
      outline,
      profile: {
        baseFontSizePt: config.typography.bodyFontSizePt,
        colorMode: config.colorMode ?? "color",
        duplex: config.duplex,
        includeMetadata: config.includeMetadata,
        includePhotos: config.includePhotos,
        marginBottomPt: config.marginsMm.bottom * POINTS_PER_MILLIMETER,
        marginLeftPt: config.marginsMm.left * POINTS_PER_MILLIMETER,
        marginRightPt: config.marginsMm.right * POINTS_PER_MILLIMETER,
        marginTopPt: config.marginsMm.top * POINTS_PER_MILLIMETER,
        numbering: request.numberingMode === "fixed",
        pageSize: config.pageSize,
        visualStyle: config.visualStyle ?? "heirloom",
      },
      title: request.collection?.name ?? "Found & Made recipes",
    };
  }

  async diagnostics(
    principal: Principal,
    request: PrintJobRequest,
  ): Promise<readonly PrintFitDiagnostic[]> {
    return diagnosePrintFit(
      await this.prepareDocument(principal, request, {
        includeImageBytes: false,
      }),
    );
  }

  async pagePlan(
    principal: Principal,
    request: PrintJobRequest,
  ): Promise<PrintPagePlan> {
    return planPrintDocument(
      await this.prepareDocument(principal, request, {
        includeImageBytes: false,
      }),
    );
  }

  async generate(
    principal: Principal,
    jobId: string,
  ): Promise<PrintGenerationResult> {
    let job = this.printing.getPrintJob(principal, jobId);
    if (job.status === "completed") {
      return {
        diagnostics: await this.diagnostics(principal, job.request),
        job,
        recipePageBoundaries: [],
      };
    }
    if (job.status !== "queued") {
      throw new Error("Only a queued print job can be generated");
    }

    job = this.printing.markPrintJobRendering(principal, job.id, {
      expectedVersion: job.version,
    });
    const relativePath = this.printing.suggestedArtifactRelativePath(job.id);
    const targetPath = this.printing.resolveArtifactPath(relativePath);
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;

    try {
      const result = await renderPrintDocument(
        await this.prepareDocument(principal, job.request),
      );
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(temporaryPath, result.bytes, {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, targetPath);
      job = this.printing.completePrintJob(principal, job.id, {
        artifactRelativePath: relativePath,
        expectedVersion: job.version,
        pageCount: result.pageCount,
      });
      return {
        diagnostics: result.diagnostics,
        job,
        recipePageBoundaries: result.recipePageBoundaries,
      };
    } catch (error) {
      await Promise.allSettled([unlink(temporaryPath), unlink(targetPath)]);
      const current = this.printing.getPrintJob(principal, job.id);
      if (current.status === "rendering") {
        this.printing.failPrintJob(principal, job.id, {
          errorCode: "pdf_render_failed",
          expectedVersion: current.version,
        });
      }
      throw error;
    }
  }

  private async recipeDocument(
    principal: Principal,
    selection: PrintRecipeSelection,
    includePhoto: boolean,
    includeImageBytes: boolean,
  ): Promise<PrintRenderRecipe> {
    const recipe = this.recipes.get(principal, selection.recipeId);
    const projection = this.recipes.project(
      principal,
      selection.recipeId,
      selection.targetServings,
    );
    const hero = includePhoto
      ? this.media
          .list(principal, recipe.id)
          .find((asset) => asset.role === "hero")
      : undefined;
    const heroFile =
      hero && includeImageBytes
        ? this.media.file(hero.id, "original")
        : undefined;

    return {
      ...(hero && (!includeImageBytes || heroFile)
        ? {
            heroImage: {
              bytes:
                includeImageBytes && heroFile
                  ? new Uint8Array(await readFile(heroFile.path))
                  : new Uint8Array(),
              height: hero.height,
              mimeType: "image/jpeg" as const,
              width: hero.width,
            },
          }
        : {}),
      id: recipe.id,
      ingredients: projection.classic.flatMap((component) =>
        component.ingredients.map((ingredient) => ({
          displayQuantity: ingredient.displayQuantity,
          ...(ingredient.guidance ? { guidance: ingredient.guidance } : {}),
          id: ingredient.id,
          name: ingredient.name,
          requirement: ingredient.requirement,
          stepIds: ingredient.stepIds,
        })),
      ),
      layout: rendererLayout(selection.layout),
      metadata: {
        "Recipe version": String(recipe.version),
        "Target servings": String(selection.targetServings),
      },
      steps: projection.guided.map((step) => ({
        id: step.id,
        instruction: step.instruction,
        linkedIngredientIds: step.ingredients.map(
          (ingredient) => ingredient.id,
        ),
      })),
      targetServings: selection.targetServings,
      title: recipe.title,
      yieldText: `${selection.targetServings} servings`,
    };
  }
}

export function rendererLayout(layout: PrintLayout): RenderLayout {
  switch (layout) {
    case "classic-single-column":
      return "classic";
    case "classic-two-column":
      return "two-column";
    case "landscape-merge-grid":
      return "merge-table";
    case "step-linked":
      return "step-linked";
    case "compact-card":
      return "compact-card";
  }
}

function recipesInSection(
  outline: readonly PrintOutlineItem[],
  sectionIndex: number,
  titleForRecipe: (recipeId: string) => string,
): string[] {
  const titles: string[] = [];
  for (const item of outline.slice(sectionIndex + 1)) {
    if (
      item.type === "section" ||
      item.type === "divider" ||
      item.type === "cover"
    ) {
      break;
    }
    if (item.type === "recipe") titles.push(titleForRecipe(item.recipeId));
  }
  return titles;
}
