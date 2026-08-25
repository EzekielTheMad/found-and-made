import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import type { Principal } from "#src/modules/identity/identity.types";
import {
  type ImportModelProvider,
  type ImportMediaTextExtractor,
  type ImportSource,
  type PublicContentAcquirer,
  type StructuredRecipeCandidate,
} from "#src/modules/imports/import.types";
import { ImportService } from "#src/modules/imports/import.service.server";
import { OpenAICompatibleImportProvider } from "#src/modules/imports/openai-import-provider.server";
import { MediaService } from "#src/modules/media/media.service.server";
import { DiscoveryService } from "#src/modules/discovery/discovery.service.server";
import { RecipeAccessService } from "#src/modules/recipes/recipe-access.service.server";
import { RecipeService } from "#src/modules/recipes/recipe.service.server";
import {
  openDatabase,
  type DatabaseHandle,
} from "#src/platform/db/database.server";
import {
  ensureDataPaths,
  resolveDataPaths,
} from "#src/platform/files/data-paths.server";
import { ImportUploadStore } from "#src/platform/files/import-upload.server";
import { JobQueue, type JobRecord } from "#src/platform/jobs/job-queue.server";
import type { JobHandlerContext } from "#src/platform/jobs/job-worker.server";
import { fourServingRecipe } from "../fixtures/four-serving-recipe";

const owner: Principal = { kind: "user", role: "owner", userId: "owner" };
const editor: Principal = {
  kind: "user",
  role: "editor",
  userId: "editor-a",
};
const otherEditor: Principal = {
  kind: "user",
  role: "editor",
  userId: "editor-b",
};
const viewer: Principal = {
  kind: "user",
  role: "viewer",
  userId: "viewer",
};

describe("durable import service", () => {
  const cleanup: Harness[] = [];

  afterEach(async () => {
    for (const harness of cleanup.splice(0)) {
      harness.database.close();
      await rm(harness.directory, { force: true, recursive: true });
    }
  });

  it("automatically saves the representative source matrix as private recipes", async () => {
    const publicContent: PublicContentAcquirer = {
      acquire(request) {
        expect(request).toEqual({
          preference: ["official_metadata", "public_page"],
          url: "https://example.com/recipe",
        });
        return Promise.resolve({
          canonicalUrl: request.url,
          method: "official_metadata",
          text: recipeText("Website soup", "Website Chef"),
        });
      },
    };
    const harness = await makeHarness(cleanup, { publicContent });
    const sources: ImportSource[] = [
      {
        draft: fourServingRecipe({ creatorName: "Manual Chef" }),
        kind: "manual",
        originalWording: "Hand-entered family recipe",
      },
      {
        kind: "pasted_text",
        text: recipeText(
          "Pasted soup",
          "Pasted Chef",
          "https://recipes.example.test/pasted-soup",
        ),
      },
      { kind: "website", url: "https://example.com/recipe" },
      {
        format: "mealie",
        kind: "migration_json",
        payload: {
          author: { name: "Grandma Rosa" },
          name: "Mealie soup",
          orgURL: "https://recipes.example.test/mealie-soup",
          recipe_ingredient: [
            {
              display: "1 cup lentils",
              food: { name: "lentils" },
              quantity: 1,
              unit: { name: "cup" },
            },
          ],
          recipe_instructions: [{ text: "Simmer lentils until tender." }],
          recipe_servings: 4,
          recipe_yield: "4 servings",
        },
      },
      {
        format: "tandoor",
        kind: "migration_json",
        payload: {
          author: { name: "Tandoor Chef" },
          ingredients: [{ amount: 1, food: { name: "beans" }, unit: "cup" }],
          name: "Tandoor soup",
          servings: 4,
          source_url: "https://recipes.example.test/tandoor-soup",
          steps: [{ instruction: "Simmer beans until tender." }],
          url: "/recipes/tandoor-soup",
        },
      },
      {
        format: "nextcloud",
        kind: "migration_json",
        payload: {
          "@type": "Recipe",
          author: "",
          name: "Nextcloud soup",
          recipeAuthor: "Nextcloud Chef",
          recipeIngredient: ["1 cup peas"],
          recipeInstructions: ["Simmer peas until tender."],
          recipeYield: "3 servings",
          url: "https://recipes.example.test/nextcloud-soup",
        },
      },
      {
        format: "schema_org",
        kind: "migration_json",
        payload: {
          "@type": "https://schema.org/Recipe",
          author: [{ name: "Schema Chef" }],
          name: "Schema soup",
          recipeIngredient: "1 cup chickpeas",
          recipeInstructions: {
            "@type": "HowToSection",
            itemListElement: [
              {
                "@type": "HowToStep",
                text: "Simmer chickpeas until tender.",
              },
            ],
          },
          recipeYield: "2 servings",
          url: "https://recipes.example.test/schema-soup#recipe",
        },
      },
      {
        fileName: "scan.jpg",
        kind: "image",
        mimeType: "image/jpeg",
        storageRef: "uploads/imports/scan-1",
        userText: recipeText("Scanned soup", "Scanned Recipe Author"),
      },
      {
        fileName: "recipe.pdf",
        kind: "pdf",
        storageRef: "uploads/imports/pdf-1",
        userText: recipeText("PDF soup", "PDF Recipe Author"),
      },
      {
        fileName: "clip.mp4",
        kind: "audio_video",
        mediaType: "video",
        storageRef: "uploads/imports/video-1",
        transcript: recipeText("Video soup", "Video Recipe Author"),
      },
      {
        caption: recipeText("Social soup", "Social Recipe Author"),
        kind: "social_url",
        platform: "instagram",
        url: "https://instagram.com/p/public",
      },
    ];

    const sessions = sources.map((source, index) =>
      harness.service.start(editor, source, {
        idempotencyKey: `matrix-${index}`,
      }),
    );
    for (let index = 0; index < sessions.length; index += 1)
      await processNext(harness, `matrix-worker-${index}`);

    const expectedCreators = [
      "Manual Chef",
      "Pasted Chef",
      "Website Chef",
      "Grandma Rosa",
      "Tandoor Chef",
      "Nextcloud Chef",
      "Schema Chef",
      "Scanned Recipe Author",
      "PDF Recipe Author",
      "Video Recipe Author",
      "Social Recipe Author",
    ];
    for (const [index, session] of sessions.entries()) {
      const persisted = harness.service.get(editor, session.id);
      expect(persisted.status).toBe("completed");
      expect(persisted.progress).toBe(100);
      expect(persisted.resultingRecipeId).toBeTruthy();
      expect(
        harness.recipeAccess.get(editor, persisted.resultingRecipeId ?? ""),
      ).toMatchObject({
        createdByUserId: "editor-a",
        creatorName: expectedCreators[index],
      });
      expect(harness.service.checkpoints(editor, session.id)).toHaveLength(7);
      expect(harness.service.review(editor, session.id)).toMatchObject({
        mandatory: false,
        privacy: "private",
        publishRequested: false,
      });
    }
    expect(
      harness.database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM recipes")
        .get(),
    ).toEqual({ count: sources.length });
    expect(harness.service.review(editor, sessions[3].id).draft).toMatchObject({
      baseYield: 4,
      ingredients: [{ name: "lentils", quantity: { unit: "cup" } }],
      creatorName: "Grandma Rosa",
      steps: [{ instruction: "Simmer lentils until tender." }],
      title: "Mealie soup",
      yieldText: "4 servings",
    });
    expect(harness.service.review(editor, sessions[4].id).draft).toMatchObject({
      baseYield: 4,
      creatorName: "Tandoor Chef",
      ingredients: [{ name: "beans" }],
      source: {
        canonicalUrl: "https://recipes.example.test/tandoor-soup",
      },
      steps: [{ instruction: "Simmer beans until tender." }],
      title: "Tandoor soup",
    });
    expect(harness.service.review(editor, sessions[5].id).draft).toMatchObject({
      baseYield: 3,
      creatorName: "Nextcloud Chef",
      ingredients: [{ name: "peas" }],
      steps: [{ instruction: "Simmer peas until tender." }],
      title: "Nextcloud soup",
    });
    expect(harness.service.review(editor, sessions[6].id).draft).toMatchObject({
      baseYield: 2,
      creatorName: "Schema Chef",
      ingredients: [{ name: "chickpeas" }],
      steps: [{ instruction: "Simmer chickpeas until tender." }],
      title: "Schema soup",
    });
    expect(harness.service.review(editor, sessions[1].id).draft.source).toEqual(
      expect.objectContaining({
        canonicalUrl: "https://recipes.example.test/pasted-soup",
      }),
    );
    expect(harness.service.review(editor, sessions[3].id).draft.source).toEqual(
      expect.objectContaining({
        canonicalUrl: "https://recipes.example.test/mealie-soup",
      }),
    );
    expect(harness.service.review(editor, sessions[6].id).draft.source).toEqual(
      expect.objectContaining({
        canonicalUrl: "https://recipes.example.test/schema-soup",
      }),
    );
  });

  it("creates idempotent migration batches atomically", async () => {
    const harness = await makeHarness(cleanup);
    const valid: ImportSource = {
      format: "mealie",
      kind: "migration_json",
      payload: {
        name: "Batch soup",
        recipeIngredient: ["1 cup beans"],
        recipeInstructions: ["Simmer beans."],
      },
    };
    const invalid: ImportSource = {
      format: "mealie",
      kind: "migration_json",
      payload: { value: BigInt(1) },
    };

    expect(() =>
      harness.service.startBatch(editor, [valid, invalid], {
        idempotencyKey: "atomic-batch",
      }),
    ).toThrow(/serializ/);
    expect(harness.service.list(editor)).toHaveLength(0);

    const first = harness.service.startBatch(editor, [valid, valid], {
      idempotencyKey: "repeatable-batch",
    });
    const repeated = harness.service.startBatch(editor, [valid, valid], {
      idempotencyKey: "repeatable-batch",
    });

    expect(first.map((session) => session.id)).toEqual(
      repeated.map((session) => session.id),
    );
    expect(harness.service.list(editor)).toHaveLength(2);
  });

  it("structures schema.org Recipe metadata without requiring an AI provider", async () => {
    const publicContent: PublicContentAcquirer = {
      acquire() {
        return Promise.resolve({
          method: "official_metadata",
          text: JSON.stringify({
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": ["Thing", "Recipe"],
                author: { name: "Metadata Chef" },
                name: "Metadata lentil soup",
                recipeIngredient: ["1 cup lentils", "2 cups water"],
                recipeInstructions: [
                  {
                    "@type": "HowToStep",
                    text: "Simmer lentils until tender.",
                  },
                ],
                recipeYield: ["4 servings"],
                url: "https://canonical.example.test/metadata-lentil-soup#recipe",
              },
            ],
          }),
        });
      },
    };
    const harness = await makeHarness(cleanup, { publicContent });
    const session = harness.service.start(
      editor,
      { kind: "website", url: "https://example.com/metadata-recipe" },
      { idempotencyKey: "schema-org-metadata" },
    );

    await processNext(harness, "metadata-worker");

    expect(harness.service.review(editor, session.id).draft).toMatchObject({
      baseYield: 4,
      creatorName: "Metadata Chef",
      source: {
        canonicalUrl: "https://example.com/metadata-recipe",
        originalUrl: "https://example.com/metadata-recipe",
      },
      title: "Metadata lentil soup",
      yieldText: "4 servings",
    });
    expect(
      harness.service.review(editor, session.id).draft.ingredients,
    ).toHaveLength(2);
    expect(harness.service.review(editor, session.id).draft.steps).toEqual([
      expect.objectContaining({ instruction: "Simmer lentils until tender." }),
    ]);
  });

  it("imports a public Found & Made URL as an independent private copy", async () => {
    const sourceRecipeId = "remote-public-recipe";
    const sourceUrl = `https://shared.example.test/public/recipes/${sourceRecipeId}`;
    const publicContent: PublicContentAcquirer = {
      acquire(request) {
        expect(request.url).toBe(sourceUrl);
        return Promise.resolve({
          canonicalUrl: sourceUrl,
          method: "official_metadata",
          text: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Recipe",
            author: { name: "Shared Cookbook Author" },
            name: "Shared public soup",
            recipeIngredient: ["2 cups tomatoes", "1 cup stock"],
            recipeInstructions: [
              { "@type": "HowToStep", text: "Simmer for 20 minutes." },
            ],
            recipeYield: "4 servings",
            url: sourceUrl,
          }),
        });
      },
    };
    const harness = await makeHarness(cleanup, { publicContent });
    const session = harness.service.start(
      editor,
      { kind: "website", url: sourceUrl },
      { idempotencyKey: "public-found-made-copy" },
    );

    await processNext(harness, "public-found-made-worker");
    const completed = harness.service.get(editor, session.id);
    const copy = harness.recipeAccess.get(
      editor,
      completed.resultingRecipeId ?? "",
    );
    expect(copy).toMatchObject({
      creatorName: "Shared Cookbook Author",
      source: { canonicalUrl: sourceUrl, originalUrl: sourceUrl },
      title: "Shared public soup",
    });
    expect(copy.id).not.toBe(sourceRecipeId);
    expect(
      harness.database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM recipe_publications")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("keeps unsafe imported source URLs out of clickable recipe metadata", async () => {
    const harness = await makeHarness(cleanup);
    const session = harness.service.start(
      editor,
      {
        format: "tandoor",
        kind: "migration_json",
        payload: {
          author: "Safe Recipe Author",
          ingredients: ["1 cup lentils"],
          name: "Unsafe metadata soup",
          source_url: "https://private:secret@example.com/recipe",
          steps: [{ instruction: "Simmer the lentils." }],
        },
      },
      { idempotencyKey: "unsafe-imported-source-url" },
    );

    await processNext(harness, "unsafe-source-worker");

    const recipe = harness.recipeAccess.get(
      editor,
      harness.service.get(editor, session.id).resultingRecipeId ?? "",
    );
    expect(recipe).toMatchObject({
      createdByUserId: "editor-a",
      creatorName: "Safe Recipe Author",
    });
    expect(recipe.source).not.toHaveProperty("canonicalUrl");
    expect(recipe.source).not.toHaveProperty("originalUrl");
  });

  it("uses a sanitized batch creator only when imported author metadata is missing", async () => {
    const harness = await makeHarness(cleanup);
    const sessions = harness.service.startBatch(
      editor,
      [
        {
          defaultCreatorName: "  Family\u0000   Archive\u202e  ",
          format: "mealie",
          kind: "migration_json",
          payload: {
            name: "Missing author soup",
            recipeIngredient: ["1 cup lentils"],
            recipeInstructions: ["Simmer the lentils."],
          },
        },
        {
          defaultCreatorName: "Family Archive",
          format: "mealie",
          kind: "migration_json",
          payload: {
            author: { name: "Explicit Recipe Author" },
            name: "Authored soup",
            recipeIngredient: ["1 cup peas"],
            recipeInstructions: ["Simmer the peas."],
          },
        },
      ],
      { idempotencyKey: "default-creator-precedence" },
    );
    await processNext(harness, "default-creator-worker-1");
    await processNext(harness, "default-creator-worker-2");

    const recipes = sessions.map((session) =>
      harness.recipeAccess.get(
        editor,
        harness.service.get(editor, session.id).resultingRecipeId ?? "",
      ),
    );
    expect(recipes[0]).toMatchObject({
      createdByUserId: "editor-a",
      creatorName: "Family Archive",
    });
    expect(recipes[1]).toMatchObject({
      createdByUserId: "editor-a",
      creatorName: "Explicit Recipe Author",
    });
  });

  it("does not mistake an instruction beginning with by for a creator", async () => {
    const harness = await makeHarness(cleanup);
    const session = harness.service.start(
      editor,
      {
        kind: "pasted_text",
        text: [
          "  Control\u202e\tSoup  ",
          "Serves\u0000   4",
          "Ingredients:",
          "1 cup lentils",
          "Instructions:",
          "By hand, mix the lentils and water.",
        ].join("\n"),
      },
      { idempotencyKey: "instruction-is-not-creator" },
    );
    await processNext(harness, "byline-safety-worker");

    const recipe = harness.recipeAccess.get(
      editor,
      harness.service.get(editor, session.id).resultingRecipeId ?? "",
    );
    expect(recipe.title).toBe("Control Soup");
    expect(recipe.yieldText).toBe("Serves 4");
    expect(recipe).not.toHaveProperty("creatorName");
    expect(recipe.steps[0]?.instruction).toBe(
      "By hand, mix the lentils and water.",
    );
  });

  it("preserves exact private provenance and never publishes automatically", async () => {
    const harness = await makeHarness(cleanup);
    const exactSource = recipeText("Grandma's pancakes");
    const session = harness.service.start(
      editor,
      { kind: "pasted_text", text: exactSource },
      { idempotencyKey: "private-review" },
    );
    await processNext(harness, "private-worker");

    expect(harness.recipeAccess.list(editor)).toHaveLength(1);
    const persisted = harness.service.get(editor, session.id);
    const recipe = harness.recipeAccess.get(
      editor,
      persisted.resultingRecipeId ?? "",
    );

    expect(recipe.source.originalWording).toBe(exactSource);
    expect(persisted).toMatchObject({
      resultingRecipeId: recipe.id,
      status: "completed",
    });
    expect(
      harness.database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM recipe_publications")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("resumes checkpoints idempotently after terminal failure, manual retry, and an expired lease", async () => {
    let acquisitionCalls = 0;
    const publicContent: PublicContentAcquirer = {
      acquire() {
        acquisitionCalls += 1;
        return Promise.resolve({
          method: "official_metadata",
          text: recipeText("Recovered soup", "Recovered Recipe Author"),
        });
      },
    };
    let providerCalls = 0;
    const modelProvider: ImportModelProvider = {
      id: "fail-once",
      structure(input): Promise<StructuredRecipeCandidate> {
        providerCalls += 1;
        if (providerCalls === 1)
          return Promise.reject(new Error("simulated provider crash"));
        return Promise.resolve(
          candidate(
            input.source.kind === "pasted_text"
              ? "Lease soup"
              : "Recovered soup",
          ),
        );
      },
    };
    const harness = await makeHarness(cleanup, {
      modelProvider,
      publicContent,
    });
    const first = harness.service.start(
      editor,
      { kind: "website", url: "https://example.com/recovered" },
      { idempotencyKey: "resume-once", maxAttempts: 1 },
    );
    const duplicateStart = harness.service.start(
      editor,
      { kind: "website", url: "https://example.com/recovered" },
      { idempotencyKey: "resume-once", maxAttempts: 1 },
    );
    expect(duplicateStart.id).toBe(first.id);

    const failedJob = requireClaim(harness, "failed-worker", 30_000);
    await expect(
      harness.service.jobHandler(
        failedJob,
        contextFor(harness, failedJob, "failed-worker"),
      ),
    ).rejects.toThrow("simulated provider crash");
    harness.queue.fail(failedJob.id, "failed-worker", "provider_failed");
    expect(harness.queue.get(failedJob.id)?.status).toBe("failed");
    expect(harness.service.get(editor, first.id).status).toBe("failed");
    const acquireHash = harness.service.checkpoints(editor, first.id)[0]
      ?.artifactHash;

    harness.service.retry(editor, first.id);
    await processNext(harness, "retry-worker");
    expect(harness.service.get(editor, first.id).status).toBe("completed");
    expect(
      harness.recipeAccess.get(
        editor,
        harness.service.get(editor, first.id).resultingRecipeId ?? "",
      ),
    ).toMatchObject({
      createdByUserId: "editor-a",
      creatorName: "Recovered Recipe Author",
    });
    expect(harness.service.checkpoints(editor, first.id)[0]?.artifactHash).toBe(
      acquireHash,
    );
    expect(acquisitionCalls).toBe(1);
    expect(providerCalls).toBe(2);

    const leased = harness.service.start(
      editor,
      { kind: "pasted_text", text: recipeText("Lease soup") },
      { idempotencyKey: "lease-recovery" },
    );
    expect(requireClaim(harness, "interrupted-worker", 1).id).toBe(
      leased.jobId,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await processNext(harness, "recovery-worker");
    expect(harness.service.get(editor, leased.id).status).toBe("completed");
    expect(harness.queue.get(leased.jobId ?? "")?.attempts).toBe(2);
  });

  it("retries every failed import in one authorized batch", async () => {
    let fail = true;
    const modelProvider: ImportModelProvider = {
      id: "batch-retry",
      structure(input): Promise<StructuredRecipeCandidate> {
        if (fail) return Promise.reject(new Error("batch provider failure"));
        const url =
          input.source.kind === "website" ? input.source.url : "recipe";
        return Promise.resolve(candidate(`Recovered ${url.split("/").at(-1)}`));
      },
    };
    const publicContent: PublicContentAcquirer = {
      acquire(request) {
        return Promise.resolve({
          method: "official_metadata",
          text: recipeText(request.url),
        });
      },
    };
    const harness = await makeHarness(cleanup, {
      modelProvider,
      publicContent,
    });
    const sessions = harness.service.startBatch(
      editor,
      [
        { kind: "website", url: "https://example.com/first" },
        { kind: "website", url: "https://example.com/second" },
      ],
      { idempotencyKey: "retry-this-batch", maxAttempts: 1 },
    );
    for (let index = 0; index < sessions.length; index += 1) {
      const job = requireClaim(harness, `failed-batch-${index}`, 30_000);
      await expect(
        harness.service.jobHandler(
          job,
          contextFor(harness, job, `failed-batch-${index}`),
        ),
      ).rejects.toThrow("batch provider failure");
      harness.queue.fail(job.id, `failed-batch-${index}`, "provider_failed");
    }
    expect(
      sessions.map((session) => harness.service.get(editor, session.id).status),
    ).toEqual(["failed", "failed"]);

    fail = false;
    expect(harness.service.retryFailedBatch(editor, "retry-this-batch")).toBe(
      2,
    );
    await processNext(harness, "batch-retry-first");
    await processNext(harness, "batch-retry-second");
    expect(
      sessions.map((session) => harness.service.get(editor, session.id).status),
    ).toEqual(["completed", "completed"]);
  });

  it("preserves blocked URL material and returns an actionable cookie-free fallback", async () => {
    let requestKeys: string[] = [];
    const publicContent: PublicContentAcquirer = {
      acquire(request) {
        requestKeys = Object.keys(request).sort();
        return Promise.resolve({
          method: "blocked",
          reason: "Official embed denied access",
        });
      },
    };
    const harness = await makeHarness(cleanup, { publicContent });
    const url = "https://www.tiktok.com/@cook/video/123";
    const session = harness.service.start(
      editor,
      { kind: "social_url", platform: "tiktok", url },
      { idempotencyKey: "blocked-social" },
    );
    const blockedJob = requireClaim(harness, "blocked-worker", 30_000);
    await expect(
      harness.service.jobHandler(
        blockedJob,
        contextFor(harness, blockedJob, "blocked-worker"),
      ),
    ).rejects.toThrow("At least one ingredient is required");

    const acquire = harness.service.checkpoints(editor, session.id)[0];
    expect(requestKeys).toEqual(["preference", "url"]);
    expect(acquire?.artifact).toMatchObject({
      canonicalUrl: url,
      fallback: {
        acceptedInputs: ["caption", "media", "pasted_text"],
      },
      method: "blocked",
      originalWording: url,
      source: { kind: "social_url", url },
    });
    const review = harness.service.review(editor, session.id);
    expect(review.fallback).toMatchObject({
      acceptedInputs: ["caption", "media", "pasted_text"],
    });
    expect(review.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "blocked_source" }),
      ]),
    );
  });

  it("uses a best guess for brand-sensitive normalization and keeps the warning", async () => {
    const harness = await makeHarness(cleanup);
    const source = [
      "Quick biscuits",
      "Serves 4",
      "Ingredients:",
      "1 cup Bisquick",
      "Instructions:",
      "Mix the Bisquick with water and bake.",
    ].join("\n");
    const session = harness.service.start(
      editor,
      { kind: "pasted_text", text: source },
      { idempotencyKey: "brand-sensitive" },
    );
    await processNext(harness, "brand-worker");
    const review = harness.service.review(editor, session.id);
    expect(review.draft.ingredients[0]).toMatchObject({
      name: "complete baking mix",
      sourceText: "1 cup Bisquick",
    });
    expect(review.brandConfirmations).toHaveLength(1);
    const persisted = harness.service.get(editor, session.id);
    const recipe = harness.recipeAccess.get(
      editor,
      persisted.resultingRecipeId ?? "",
    );
    expect(recipe.ingredients[0]?.name).toBe("complete baking mix");
    expect(recipe.ingredients[0]?.sourceText).toBe("1 cup Bisquick");
  });

  it("imports a stored Mealie original image as a sanitized hero", async () => {
    const harness = await makeHarness(cleanup);
    const bytes = await sharp({
      create: {
        background: { alpha: 1, b: 60, g: 120, r: 80 },
        channels: 4,
        height: 8,
        width: 8,
      },
    })
      .webp()
      .toBuffer();
    const stored = await harness.importUploads.store(
      new File([bytes], "original.webp", { type: "image/webp" }),
    );
    const session = harness.service.start(
      editor,
      {
        format: "mealie",
        heroImage: { fileName: "original.webp", ...stored },
        kind: "migration_json",
        payload: {
          name: "Mealie photo soup",
          recipeIngredient: ["1 cup beans"],
          recipeInstructions: ["Simmer beans."],
        },
      },
      { idempotencyKey: "mealie-photo" },
    );

    await processNext(harness, "photo-worker");

    const persisted = harness.service.get(editor, session.id);
    expect(persisted.status).toBe("completed");
    const hero = harness.mediaService.hero(persisted.resultingRecipeId ?? "");
    expect(hero).toMatchObject({
      caption: "Imported from mealie",
      role: "hero",
    });
    await expect(
      harness.importUploads.read(stored.storageRef),
    ).rejects.toThrow();
  });

  it("imports and sanitizes a website hero while applying only standardized tags", async () => {
    const bytes = await sharp({
      create: {
        background: { alpha: 1, b: 90, g: 45, r: 120 },
        channels: 4,
        height: 8,
        width: 8,
      },
    })
      .webp()
      .toBuffer();
    const publicContent: PublicContentAcquirer = {
      acquire() {
        return Promise.resolve({
          canonicalUrl: "https://recipes.example.test/chocolate-ice-cream",
          heroImageUrl: "https://cdn.example.test/chocolate.webp",
          method: "official_metadata",
          text: JSON.stringify({
            "@type": "Recipe",
            keywords: ["Summer recipes", "source-only-noise"],
            name: "Chocolate ice cream",
            recipeCategory: ["Desserts"],
            recipeIngredient: ["1 cup cream"],
            recipeInstructions: ["Freeze the cream mixture."],
          }),
        });
      },
      acquireImage() {
        return Promise.resolve({ bytes, mimeType: "image/webp" });
      },
    };
    const harness = await makeHarness(cleanup, { publicContent });
    const session = harness.service.start(
      editor,
      {
        kind: "website",
        url: "https://recipes.example.test/chocolate-ice-cream",
      },
      { idempotencyKey: "website-photo-tags" },
    );

    await processNext(harness, "website-photo-worker");

    const persisted = harness.service.get(editor, session.id);
    const recipeId = persisted.resultingRecipeId ?? "";
    expect(persisted.status).toBe("completed");
    expect(harness.mediaService.hero(recipeId)).toMatchObject({
      caption: "Imported from cdn.example.test",
      role: "hero",
    });
    const classification = harness.discoveryService.recipeClassification(
      editor,
      recipeId,
    );
    const assignedNames = harness.discoveryService
      .terms(editor)
      .filter((term) => classification.termIds.includes(term.id))
      .map((term) => term.name);
    expect(assignedNames).toEqual(["Dessert", "Seasonal"]);
    expect(harness.discoveryService.terms(editor)).toHaveLength(2);
  });

  it("skips exact active duplicates but permits reimport after recycling", async () => {
    const harness = await makeHarness(cleanup);
    const source = {
      kind: "pasted_text",
      text: recipeText("Duplicate soup"),
    } as const;
    const first = harness.service.start(editor, source, {
      idempotencyKey: "duplicate-first",
    });
    await processNext(harness, "duplicate-first-worker");
    const firstPersisted = harness.service.get(editor, first.id);

    const second = harness.service.start(editor, source, {
      idempotencyKey: "duplicate-second",
    });
    await processNext(harness, "duplicate-second-worker");
    expect(harness.service.get(editor, second.id)).toMatchObject({
      resultingRecipeId: null,
      status: "skipped",
    });
    expect(harness.recipeAccess.list(editor)).toHaveLength(1);

    const original = harness.recipeAccess.get(
      editor,
      firstPersisted.resultingRecipeId ?? "",
    );
    harness.recipeAccess.trash(owner, original.id, original.version);
    const third = harness.service.start(editor, source, {
      idempotencyKey: "duplicate-after-trash",
    });
    await processNext(harness, "duplicate-after-trash-worker");
    expect(harness.service.get(editor, third.id).status).toBe("completed");
  });

  it("scopes import history and review access while Owners can inspect all sessions", async () => {
    const harness = await makeHarness(cleanup);
    const first = harness.service.start(
      editor,
      { kind: "pasted_text", text: recipeText("Editor A") },
      { idempotencyKey: "editor-a" },
    );
    const second = harness.service.start(
      otherEditor,
      { kind: "pasted_text", text: recipeText("Editor B") },
      { idempotencyKey: "editor-b" },
    );

    expect(harness.service.list(editor).map((item) => item.id)).toEqual([
      first.id,
    ]);
    expect(harness.service.list(otherEditor).map((item) => item.id)).toEqual([
      second.id,
    ]);
    expect(new Set(harness.service.list(owner).map((item) => item.id))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(() => harness.service.get(editor, second.id)).toThrow("authorized");
    expect(() => harness.service.list(viewer)).toThrow("authorized");
    expect(() =>
      harness.service.start(
        viewer,
        { kind: "pasted_text", text: recipeText("Denied") },
        { idempotencyKey: "denied" },
      ),
    ).toThrow("authorized");
  });

  it("supports an externally configured OpenAI-compatible provider without live services", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const request = ((input: URL | RequestInfo, init?: RequestInit) => {
      requestUrl =
        input instanceof URL
          ? input.href
          : typeof input === "string"
            ? input
            : input.url;
      requestInit = init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    ...candidate("Provider soup"),
                    creatorName: "Provider Recipe Author",
                  }),
                },
              },
            ],
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
      );
    }) as typeof fetch;
    const provider = new OpenAICompatibleImportProvider(
      {
        apiKey: "test-only-key",
        baseUrl: "http://provider.test/api/",
        model: "local-recipe-model",
      },
      request,
    );
    const result = await provider.structure({
      source: { kind: "pasted_text", text: "Provider soup" },
      sourceText: "Provider soup",
    });

    expect(requestUrl).toBe("http://provider.test/api/v1/chat/completions");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe(
      "Bearer test-only-key",
    );
    expect(requestInit?.redirect).toBe("error");
    expect(result.title).toBe("Provider soup");
    expect(result.creatorName).toBe("Provider Recipe Author");
  });

  it("extracts uploaded media during the durable extract stage before structuring", async () => {
    const mediaTextExtractor: ImportMediaTextExtractor = {
      id: "test-media-extractor",
      extract(input) {
        expect(input.kind).toBe("image");
        expect(input.mimeType).toBe("image/png");
        expect(input.bytes.byteLength).toBeGreaterThan(20);
        return Promise.resolve(
          recipeText("Extracted image soup", "Camera Recipe Author"),
        );
      },
    };
    const harness = await makeHarness(cleanup, { mediaTextExtractor });
    const bytes = await sharp({
      create: {
        background: { alpha: 1, b: 245, g: 245, r: 245 },
        channels: 4,
        height: 40,
        width: 80,
      },
    })
      .png()
      .toBuffer();
    const stored = await harness.importUploads.store(
      new File([bytes], "recipe-card.png", { type: "image/png" }),
    );
    const session = harness.service.start(
      editor,
      {
        fileName: "recipe-card.png",
        kind: "image",
        mimeType: stored.mimeType,
        storageRef: stored.storageRef,
      },
      { idempotencyKey: "media-extraction" },
    );

    await processNext(harness, "media-extraction-worker");
    const completed = harness.service.get(editor, session.id);
    expect(completed.status).toBe("completed");
    expect(
      harness.recipeAccess.get(editor, completed.resultingRecipeId ?? ""),
    ).toMatchObject({
      creatorName: "Camera Recipe Author",
      title: "Extracted image soup",
    });
    const checkpoint = harness.database.sqlite
      .prepare(
        "SELECT artifact FROM import_checkpoints WHERE session_id = ? AND stage = 'extract'",
      )
      .get(session.id) as { artifact: string } | undefined;
    expect(checkpoint?.artifact).toContain("Extracted image soup");
  });
});

interface HarnessOptions {
  mediaTextExtractor?: ImportMediaTextExtractor;
  modelProvider?: ImportModelProvider;
  publicContent?: PublicContentAcquirer;
}

interface Harness {
  database: DatabaseHandle;
  directory: string;
  discoveryService: DiscoveryService;
  importUploads: ImportUploadStore;
  mediaService: MediaService;
  queue: JobQueue;
  recipeAccess: RecipeAccessService;
  service: ImportService;
}

async function makeHarness(
  cleanup: Harness[],
  options: HarnessOptions = {},
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "found-made-import-"));
  const paths = resolveDataPaths(directory);
  await ensureDataPaths(paths);
  const database = openDatabase({ filePath: join(paths.db, "app.db") });
  for (const [id, role] of [
    ["owner", "owner"],
    ["editor-a", "editor"],
    ["editor-b", "editor"],
    ["viewer", "viewer"],
  ] as const) {
    insertUser(database, id, role);
  }
  const queue = new JobQueue(database.sqlite);
  const recipes = new RecipeService(database.sqlite);
  const recipeAccess = new RecipeAccessService(recipes);
  const discoveryService = new DiscoveryService(database.sqlite, recipes);
  const importUploads = new ImportUploadStore(paths);
  const mediaService = new MediaService(database.sqlite, paths, recipes);
  const service = new ImportService({
    discoveryService,
    importUploads,
    jobQueue: queue,
    ...(options.mediaTextExtractor
      ? { mediaTextExtractor: options.mediaTextExtractor }
      : {}),
    ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
    ...(options.publicContent
      ? { publicContentAcquirer: options.publicContent }
      : {}),
    mediaService,
    recipeAccess,
    sqlite: database.sqlite,
  });
  const harness = {
    database,
    directory,
    discoveryService,
    importUploads,
    mediaService,
    queue,
    recipeAccess,
    service,
  };
  cleanup.push(harness);
  return harness;
}

function insertUser(
  database: DatabaseHandle,
  id: string,
  role: "editor" | "owner" | "viewer",
): void {
  const now = new Date().toISOString();
  database.sqlite
    .prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(id, id, `${id}@example.test`, now, now);
  database.sqlite
    .prepare(
      `INSERT INTO app_users (user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, role, now, now);
}

async function processNext(harness: Harness, workerId: string): Promise<void> {
  const job = requireClaim(harness, workerId, 30_000);
  await harness.service.jobHandler(job, contextFor(harness, job, workerId));
  harness.queue.complete(job.id, workerId);
}

function requireClaim(
  harness: Harness,
  workerId: string,
  leaseDurationMs: number,
): JobRecord {
  const job = harness.queue.claim(workerId, leaseDurationMs);
  if (!job) throw new Error("Expected a claimable import job");
  return job;
}

function contextFor(
  harness: Harness,
  job: JobRecord,
  workerId: string,
): JobHandlerContext {
  return {
    progress(value, artifactRefs) {
      harness.queue.setProgress(job.id, workerId, value, artifactRefs);
    },
    renewLease() {
      harness.queue.renewLease(job.id, workerId, 30_000);
    },
  };
}

function recipeText(
  title: string,
  creatorName?: string,
  sourceUrl?: string,
): string {
  return [
    title,
    ...(creatorName ? [`Recipe by ${creatorName}`] : []),
    ...(sourceUrl ? [`Source: ${sourceUrl}`] : []),
    "Serves 4",
    "Ingredients:",
    "1 cup lentils",
    "2 cups water",
    "Instructions:",
    "Combine the lentils and water.",
    "Simmer until tender.",
  ].join("\n");
}

function candidate(title: string): StructuredRecipeCandidate {
  return {
    baseYield: 4,
    ingredients: [
      {
        name: "lentils",
        quantityText: "1 cup",
        sourceText: "1 cup lentils",
      },
    ],
    steps: ["Simmer lentils until tender."],
    title,
    yieldText: "Serves 4",
  };
}
