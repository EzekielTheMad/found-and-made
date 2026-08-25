import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appRuntimeContext } from "~/context";
import PublicCollection, {
  loader as publicCollectionLoader,
} from "~/routes/public-collection";
import type { Principal } from "#src/modules/identity/identity.types";
import { createRuntime, type AppRuntime } from "#src/platform/runtime.server";
import { fourServingRecipe } from "../fixtures/four-serving-recipe";

const owner = { kind: "user", role: "owner", userId: "owner-user" } as const;
const editor = {
  kind: "user",
  role: "editor",
  userId: "editor-user",
} as const;
const anonymous = { kind: "anonymous" } as const;

describe("public collection publishing", () => {
  const cleanup: Array<{ directory: string; runtime: AppRuntime }> = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const item of cleanup.splice(0)) {
      await item.runtime.close();
      await rm(item.directory, { force: true, recursive: true });
    }
  });

  it("requires an Owner and never publishes collection recipes implicitly", async () => {
    const fixture = await createFixture();
    const { collectionId, privateRecipeId, publishedRecipeId, runtime } =
      fixture;

    expect(() =>
      runtime.publishingService.setCollectionPublished(
        editor,
        collectionId,
        true,
      ),
    ).toThrow("authorized");
    expect(() =>
      runtime.publishingService.setCollectionPublished(
        anonymous,
        collectionId,
        true,
      ),
    ).toThrow("authorized");
    expect(runtime.publishingService.collectionStatus(collectionId)).toBe(
      "private",
    );

    runtime.publishingService.setCollectionPublished(owner, collectionId, true);
    expect(runtime.publishingService.collectionStatus(collectionId)).toBe(
      "published",
    );
    expect(
      runtime.database.sqlite
        .prepare(
          `SELECT action, actor_id AS actorId, subject_id AS subjectId
           FROM audit_events WHERE subject_id = ? ORDER BY created_at`,
        )
        .all(collectionId),
    ).toEqual([
      {
        action: "collection.published",
        actorId: owner.userId,
        subjectId: collectionId,
      },
    ]);
    expect(
      runtime.publishingService.getPublicCollection(collectionId),
    ).toBeNull();

    runtime.publishingService.setPublicMode(owner, true);
    runtime.publishingService.publish(owner, publishedRecipeId);
    const publicCollection =
      runtime.publishingService.getPublicCollection(collectionId);
    expect(publicCollection).toMatchObject({
      description: "A public-safe description",
      id: collectionId,
      recipes: [
        {
          id: publishedRecipeId,
          title: "Published soup",
          yieldText: "Serves 4 generously",
        },
      ],
      title: "Public favorites",
    });
    const serialized = JSON.stringify(publicCollection);
    expect(serialized).not.toContain("PRIVATE_RECIPE_TITLE_SENTINEL");
    expect(serialized).not.toContain(privateRecipeId);

    runtime.publishingService.unpublish(owner, publishedRecipeId);
    expect(
      runtime.publishingService.getPublicCollection(collectionId)?.recipes,
    ).toEqual([]);
    runtime.publishingService.setCollectionPublished(
      owner,
      collectionId,
      false,
    );
    expect(
      runtime.publishingService.getPublicCollection(collectionId),
    ).toBeNull();
  });

  it("serves a stable anonymous URL and returns a generic 404 for private collections", async () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://recipes.example.test");
    const { collectionId, privateCollectionId, publishedRecipeId, runtime } =
      await createFixture();
    runtime.publishingService.setPublicMode(owner, true);
    runtime.publishingService.publish(owner, publishedRecipeId);
    runtime.publishingService.setCollectionPublished(owner, collectionId, true);

    const context = new RouterContextProvider();
    context.set(appRuntimeContext, runtime);
    const loaderData = publicCollectionLoader({
      context,
      params: { collectionId },
      request: new Request(
        `https://attacker.example/public/collections/${collectionId}`,
      ),
    } as unknown as Parameters<typeof publicCollectionLoader>[0]);
    expect(loaderData.canonicalUrl).toBe(
      `https://recipes.example.test/public/collections/${collectionId}`,
    );
    const markup = renderToStaticMarkup(
      createElement(PublicCollection, {
        loaderData,
      } as Parameters<typeof PublicCollection>[0]),
    );
    expect(markup).toContain("Public favorites");
    expect(markup).toContain("Published soup");
    expect(markup).not.toContain("PRIVATE_RECIPE_TITLE_SENTINEL");
    expect(markup).not.toContain("attacker.example");

    let response: Response | undefined;
    try {
      publicCollectionLoader({
        context,
        params: { collectionId: privateCollectionId },
        request: new Request(
          `https://recipes.example.test/public/collections/${privateCollectionId}`,
        ),
      } as unknown as Parameters<typeof publicCollectionLoader>[0]);
    } catch (error) {
      response = error as Response;
    }
    expect(response?.status).toBe(404);
    const body = await response?.text();
    expect(body).toBe("Not found");
    expect(body).not.toContain("PRIVATE_COLLECTION_SENTINEL");
  });

  async function createFixture() {
    const directory = await mkdtemp(join(tmpdir(), "found-made-collections-"));
    const runtime = await createRuntime({
      dataDir: directory,
      startWorker: false,
    });
    cleanup.push({ directory, runtime });
    insertUser(runtime, owner);
    insertUser(runtime, editor);

    const publishedRecipe = runtime.recipeService.create(
      fourServingRecipe({
        id: "published-soup",
        source: { originalUrl: "https://example.test/published-soup" },
        title: "Published soup",
      }),
    );
    const privateRecipe = runtime.recipeService.create(
      fourServingRecipe({
        id: "private-soup",
        source: { originalUrl: "https://example.test/private-soup" },
        title: "PRIVATE_RECIPE_TITLE_SENTINEL",
      }),
      { allowDuplicate: true },
    );
    const collectionId = runtime.discoveryService.createCollection(owner, {
      description: "A public-safe description",
      title: "Public favorites",
    });
    runtime.discoveryService.assignCollectionRecipes(owner, collectionId, [
      publishedRecipe.id,
      privateRecipe.id,
    ]);
    const privateCollectionId = runtime.discoveryService.createCollection(
      owner,
      { title: "PRIVATE_COLLECTION_SENTINEL" },
    );
    return {
      collectionId,
      privateCollectionId,
      privateRecipeId: privateRecipe.id,
      publishedRecipeId: publishedRecipe.id,
      runtime,
    };
  }
});

function insertUser(runtime: AppRuntime, principal: Principal): void {
  if (principal.kind !== "user") return;
  const timestamp = "2026-08-11T00:00:00.000Z";
  runtime.database.sqlite
    .prepare(
      `INSERT INTO user
       (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(
      principal.userId,
      principal.userId,
      `${principal.userId}@example.test`,
      timestamp,
      timestamp,
    );
  runtime.database.sqlite
    .prepare(
      `INSERT INTO app_users (user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(principal.userId, principal.role, timestamp, timestamp);
}
