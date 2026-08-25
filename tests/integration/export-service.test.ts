import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { ExportService } from "#src/modules/exports/export.service.server";
import type {
  LibraryExportManifestV1,
  RecipeExportV1,
} from "#src/modules/exports/export.types";
import type { Principal } from "#src/modules/identity/identity.types";
import { createRuntime, type AppRuntime } from "#src/platform/runtime.server";
import { fourServingRecipe } from "../fixtures/four-serving-recipe";

const owner: Principal = { kind: "user", role: "owner", userId: "owner" };
const editor: Principal = { kind: "user", role: "editor", userId: "editor" };
const viewer: Principal = { kind: "user", role: "viewer", userId: "viewer" };
const anonymous: Principal = { kind: "anonymous" };
const exportedAt = new Date("2026-07-31T20:00:00.000Z");

describe("machine-readable export service", () => {
  const cleanup: Array<{ directory: string; runtime: AppRuntime }> = [];

  afterEach(async () => {
    for (const item of cleanup.splice(0)) {
      await item.runtime.close();
      await rm(item.directory, { force: true, recursive: true });
    }
  });

  it("matches shared 4/6/8/12 serving projections exactly", async () => {
    const { runtime, service } = await fixture();
    const recipe = runtime.recipeService.create(fourServingRecipe());

    for (const targetYield of [4, 6, 8, 12]) {
      const exported = service.exportRecipeJson(viewer, recipe.id, {
        now: exportedAt,
        targetYield,
      });
      expect(exported.dto.projection).toEqual(
        runtime.recipeService.project(recipe.id, targetYield, "as-written"),
      );
      expect(exported.dto.targetYield).toBe(targetYield);
      expect(exported.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(exported.artifactName).toMatch(/^recipe-[a-f0-9-]{36}\.json$/);
    }

    const metric = service.exportRecipeJson(viewer, recipe.id, {
      now: exportedAt,
      targetYield: 8,
      unitPreference: "metric",
    });
    expect(metric.dto.projection).toEqual(
      runtime.recipeService.project(recipe.id, 8, "metric"),
    );
  });

  it("preserves authored classifications and guidance without private state or paths", async () => {
    const { directory, runtime, service } = await fixture();
    const recipe = runtime.recipeService.create(fourServingRecipe());
    const exported = service.exportRecipeJson(viewer, recipe.id, {
      now: exportedAt,
      targetYield: 6,
    });
    const serialized = JSON.stringify(exported.dto);

    expect(
      exported.dto.recipe.ingredients.find((item) => item.id === "parsley")
        ?.requirement,
    ).toBe("optional");
    expect(
      exported.dto.recipe.ingredients.find((item) => item.id === "onion")
        ?.substitutions,
    ).toEqual([
      {
        name: "sweet onion",
        note: "Slightly sweeter; reduce browning time if needed.",
      },
    ]);
    expect(exported.dto.recipe.equipment.map((item) => item.name)).toHaveLength(
      2,
    );
    expect(exported.dto.recipe.allergens).toEqual(
      expect.arrayContaining([
        { confirmed: true, name: "Dairy" },
        { confirmed: false, name: "Wheat" },
      ]),
    );
    expect(exported.dto.recipe.diets).toEqual([
      { confirmed: false, name: "Nut-free" },
    ]);
    expect(serialized).not.toContain(directory);
    expect(serialized).not.toContain(runtime.dataPaths.db);
    expect(serialized).not.toMatch(
      /"(?:favorite|rating|personal|password|token)"/i,
    );
    expect(serialized).not.toMatch(/[A-Z]:\\/);
    expect(
      (await readdir(runtime.dataPaths.exports).catch(() => [])).filter(
        (name) => name.startsWith("recipe-") && name.endsWith(".json"),
      ),
    ).toEqual([]);
  });

  it("enforces reader and Owner boundaries", async () => {
    const { runtime, service } = await fixture();
    const recipe = runtime.recipeService.create(fourServingRecipe());

    expect(
      service.exportRecipeJson(viewer, recipe.id, { now: exportedAt }),
    ).toMatchObject({ dto: { schema: "found-made.recipe-export" } });
    expect(() =>
      service.exportRecipeJson(anonymous, recipe.id, { now: exportedAt }),
    ).toThrow("authorized");
    await expect(
      service.exportLibrary(viewer, { now: exportedAt }),
    ).rejects.toThrow("Owner");
    await expect(
      service.exportLibrary(editor, { now: exportedAt }),
    ).rejects.toThrow("Owner");
    const library = await service.exportLibrary(owner, { now: exportedAt });
    expect(library).toMatchObject({
      fileCount: 3,
    });
    await expect(
      service.verifyLibraryExport(
        viewer,
        library.artifactName,
        library.manifest.sha256,
      ),
    ).rejects.toThrow("Owner");
  });

  it("atomically exports sanitized media with deterministic checksums and detects tampering", async () => {
    const { directory, runtime, service } = await fixture();
    const first = runtime.recipeService.create(fourServingRecipe());
    runtime.recipeService.create(
      fourServingRecipe({
        source: { originalUrl: "https://example.com/second" },
        title: "Second Recipe",
      }),
      { allowDuplicate: true },
    );
    const source = await sharp({
      create: {
        background: { alpha: 1, b: 40, g: 90, r: 160 },
        channels: 4,
        height: 600,
        width: 900,
      },
    })
      .jpeg()
      .withExif({ IFD0: { Artist: "Private camera owner" } })
      .toBuffer();
    const asset = await runtime.mediaService.upload(owner, {
      altText: "Golden lasagna on a serving board",
      bytes: source,
      caption: "Sunday table",
      recipeId: first.id,
      role: "hero",
    });

    const result = await service.exportLibrary(owner, { now: exportedAt });
    const artifactRoot = join(runtime.dataPaths.exports, result.artifactName);
    const manifest = JSON.parse(
      await readFile(join(artifactRoot, "manifest.json"), "utf8"),
    ) as LibraryExportManifestV1;

    expect(manifest.files.map((file) => file.path)).toEqual(
      [...manifest.files.map((file) => file.path)].sort(),
    );
    expect(manifest.recipes.map((item) => item.recipeId)).toEqual(
      [...manifest.recipes.map((item) => item.recipeId)].sort(),
    );
    expect(manifest.files).toHaveLength(6);
    for (const file of manifest.files) {
      const bytes = await readFile(join(artifactRoot, file.path));
      expect(bytes.byteLength).toBe(file.size);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        file.sha256,
      );
      expect(file.path).not.toContain(first.id);
      expect(file.path).not.toContain(asset.id);
    }

    const recipeEntry = manifest.recipes.find(
      (item) => item.recipeId === first.id,
    );
    expect(recipeEntry).toBeDefined();
    const recipeDto = JSON.parse(
      await readFile(join(artifactRoot, recipeEntry?.path ?? ""), "utf8"),
    ) as RecipeExportV1;
    expect(recipeDto.media[0]).toMatchObject({
      altText: "Golden lasagna on a serving board",
      caption: "Sunday table",
      id: asset.id,
    });
    expect(recipeDto.media[0]?.variants.map((item) => item.variant)).toEqual([
      "original",
      "social",
      "web",
    ]);
    const originalReference = recipeDto.media[0]?.variants.find(
      (item) => item.variant === "original",
    );
    const exportedOriginal = await readFile(
      join(artifactRoot, originalReference?.path ?? ""),
    );
    expect((await sharp(exportedOriginal).metadata()).exif).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain(directory);
    expect(
      await service.verifyLibraryExport(
        owner,
        result.artifactName,
        result.manifest.sha256,
      ),
    ).toEqual({ errors: [], filesVerified: 6, valid: true });

    const mediaDescriptor = manifest.files.find(
      (file) => file.kind === "media",
    );
    expect(mediaDescriptor).toBeDefined();
    await writeFile(
      join(artifactRoot, mediaDescriptor?.path ?? ""),
      Buffer.from("tampered"),
    );
    const tampered = await service.verifyLibraryExport(
      owner,
      result.artifactName,
      result.manifest.sha256,
    );
    expect(tampered.valid).toBe(false);
    expect(tampered.errors.join(" ")).toMatch(
      /Size mismatch|Checksum mismatch/,
    );

    const manifestPath = join(artifactRoot, "manifest.json");
    await writeFile(
      manifestPath,
      (await readFile(manifestPath, "utf8")).replace(
        '"recipeCount": 2',
        '"recipeCount": 3',
      ),
    );
    const manifestTamper = await service.verifyLibraryExport(
      owner,
      result.artifactName,
      result.manifest.sha256,
    );
    expect(manifestTamper.errors).toContain("Manifest checksum mismatch");
  });

  it("includes deleted recipes, revision history, organization, personal state, and safe contributor identity", async () => {
    const { directory, runtime, service } = await fixture();
    const account = await runtime.identityService.createInitialOwner({
      email: "archive-owner@example.test",
      name: "Archive Owner",
      password: "archive owner password",
    });
    const principal = {
      kind: "user",
      role: "owner",
      userId: account.id,
    } as const;
    const first = runtime.recipeAccessService.create(
      principal,
      fourServingRecipe({ sharedNotes: "Shared family note" }),
    );
    const edit = structuredClone(
      runtime.recipeAccessService.get(principal, first.id),
    );
    edit.sharedNotes = "Updated shared family note";
    const updated = runtime.recipeAccessService.update(
      principal,
      first.id,
      edit,
      { expectedVersion: first.version, reason: "Archive revision" },
    );
    const deleted = runtime.recipeAccessService.create(
      principal,
      fourServingRecipe({
        source: { originalUrl: "https://example.com/deleted-archive-recipe" },
        title: "Deleted archive recipe",
      }),
      { allowDuplicate: true },
    );
    runtime.recipeAccessService.trash(principal, deleted.id, deleted.version);
    const categoryGroupId = runtime.discoveryService.createFacetGroup(
      principal,
      {
        name: "Recipe category",
        slug: "recipe-type",
      },
    );
    const category = runtime.discoveryService.createFacetTerm(principal, {
      aliases: ["evening meal"],
      groupId: categoryGroupId,
      name: "Archive Dinner",
    });
    runtime.discoveryService.assignTerms(principal, first.id, [category.id]);
    runtime.discoveryService.assignLabels(principal, first.id, [
      "Family archive",
    ]);
    const collectionId = runtime.discoveryService.createCollection(principal, {
      description: "Portable collection",
      title: "Archive collection",
    });
    runtime.discoveryService.assignCollectionRecipes(principal, collectionId, [
      first.id,
    ]);
    runtime.cookingService.upsertPersonalFields(principal, first.id, {
      favorite: true,
      note: "Private cooking note",
      rating: 5,
    });

    const result = await service.exportLibrary(principal, { now: exportedAt });
    const artifactRoot = join(runtime.dataPaths.exports, result.artifactName);
    const manifest = JSON.parse(
      await readFile(join(artifactRoot, "manifest.json"), "utf8"),
    ) as LibraryExportManifestV1;
    const libraryState = JSON.parse(
      await readFile(join(artifactRoot, manifest.libraryState.path), "utf8"),
    ) as {
      contributors: Array<{ id: string; name: string; role: string }>;
      records: Record<string, Array<Record<string, unknown>>>;
      schema: string;
    };

    expect(manifest.recipeCount).toBe(2);
    expect(manifest.recipes.map((item) => item.recipeId)).toContain(deleted.id);
    const deletedEntry = manifest.recipes.find(
      (item) => item.recipeId === deleted.id,
    );
    const deletedDto = JSON.parse(
      await readFile(join(artifactRoot, deletedEntry!.path), "utf8"),
    ) as RecipeExportV1;
    expect(deletedDto.recipe.deletedAt).toBeDefined();
    expect(libraryState).toMatchObject({
      contributors: [{ id: account.id, name: "Archive Owner", role: "owner" }],
      schema: "found-made.library-state",
    });
    expect(libraryState.records.recipeRevisions).toHaveLength(2);
    expect(libraryState.records.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Archive Dinner" }),
      ]),
    );
    expect(libraryState.records.labels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Family archive" }),
      ]),
    );
    expect(libraryState.records.collections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Archive collection" }),
      ]),
    );
    expect(libraryState.records.personalRecipeStates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ note: "Private cooking note", rating: 5 }),
      ]),
    );
    const serialized = JSON.stringify(libraryState);
    expect(serialized).not.toContain(directory);
    expect(serialized).not.toMatch(/password|token_hash|original_path/i);
    expect(updated.sharedNotes).toBe("Updated shared family note");
  });

  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "found-made-export-"));
    const runtime = await createRuntime({
      dataDir: directory,
      startWorker: false,
    });
    cleanup.push({ directory, runtime });
    let counter = 0;
    const service = new ExportService(
      runtime.recipeAccessService,
      runtime.mediaService,
      runtime.database.sqlite,
      runtime.dataPaths.exports,
      {
        createId: () => {
          counter += 1;
          return `00000000-0000-4000-8000-${counter.toString().padStart(12, "0")}`;
        },
        now: () => exportedAt,
      },
    );
    return { directory, runtime, service };
  }
});
