import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appRuntimeContext } from "~/context";
import PublicRecipe, {
  loader as publicRecipeLoader,
  meta as publicRecipeMeta,
} from "~/routes/public-recipe";
import { action as peopleAction } from "~/routes/people";
import {
  publicOriginFromEnv,
  publicUrl,
} from "#src/platform/http/public-origin.server";
import { createRuntime, type AppRuntime } from "#src/platform/runtime.server";
import { fourServingRecipe } from "../fixtures/four-serving-recipe";

const ownerInput = {
  email: "privacy-owner@example.com",
  name: "Privacy Owner",
  password: "privacy owner password",
};

describe("publishing privacy boundaries", () => {
  const cleanup: Array<{ directory: string; runtime: AppRuntime }> = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const item of cleanup.splice(0)) {
      await item.runtime.close();
      await rm(item.directory, { force: true, recursive: true });
    }
  });

  it("records Owner publication and projects a privacy-safe public DTO", async () => {
    const { ownerId, recipeId, runtime } = await publishedFixture(false);
    const owner = { kind: "user", role: "owner", userId: ownerId } as const;

    const publishedAt = new Date("2026-07-31T18:00:00.000Z");
    runtime.publishingService.publish(owner, recipeId, publishedAt);

    const publication = runtime.database.sqlite
      .prepare(
        `SELECT published_by AS actorId, published_at AS publishedAt,
                rights_attested_by AS attestedBy,
                rights_attested_at AS attestedAt
         FROM recipe_publications WHERE recipe_id = ?`,
      )
      .get(recipeId);
    expect(publication).toEqual({
      actorId: ownerId,
      publishedAt: publishedAt.toISOString(),
      attestedBy: null,
      attestedAt: null,
    });

    const publicRecipe = runtime.publishingService.getPublicRecipe(recipeId);
    expect(publicRecipe).not.toBeNull();
    expect(publicRecipe).not.toHaveProperty("source");
    expect(publicRecipe).not.toHaveProperty("fingerprint");
    expect(publicRecipe).not.toHaveProperty("version");
    expect(publicRecipe).not.toHaveProperty("allergens");
    expect(publicRecipe).not.toHaveProperty("diets");
    expect(publicRecipe).not.toHaveProperty("sharedNotes");
    expect(publicRecipe).toMatchObject({ creatorName: "Aunt June" });
    const projection = JSON.stringify(publicRecipe);
    expect(projection).not.toContain("PRIVATE_SOURCE_URL_SENTINEL");
    expect(projection).not.toContain("PRIVATE_ORIGINAL_WORDING_SENTINEL");
    expect(projection).not.toContain("PRIVATE_CLASSIFICATION_SENTINEL");
    expect(projection).not.toContain("PRIVATE_SHARED_NOTES_SENTINEL");
  });

  it("bulk publishes and unpublishes only for an Owner", async () => {
    const { ownerId, recipeId, runtime } = await publishedFixture(false);
    const owner = { kind: "user", role: "owner", userId: ownerId } as const;
    const editor = { kind: "user", role: "editor", userId: ownerId } as const;
    const second = runtime.recipeService.create(
      fourServingRecipe({
        source: { originalUrl: "https://example.com/second-recipe" },
        title: "Second private recipe",
      }),
    );

    expect(() =>
      runtime.publishingService.setPublishedMany(editor, [recipeId], true),
    ).toThrow("authorized");
    expect(
      runtime.publishingService.setPublishedMany(
        owner,
        [recipeId, second.id],
        true,
      ),
    ).toBe(2);
    expect(runtime.publishingService.statuses([recipeId, second.id])).toEqual({
      [recipeId]: "published",
      [second.id]: "published",
    });

    runtime.publishingService.setPublishedMany(owner, [recipeId], false);
    expect(runtime.publishingService.status(recipeId)).toBe("private");
    expect(runtime.publishingService.status(second.id)).toBe("published");
  });

  it("keeps SSR hydration, metadata, and invitation URLs pinned to PUBLIC_ORIGIN", async () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://recipes.example.test");
    const { recipeId, runtime, sessionCookie } = await publishedFixture(true);
    const context = new RouterContextProvider();
    context.set(appRuntimeContext, runtime);
    const attackerRequest = new Request(
      `https://attacker.example/public/recipes/${recipeId}`,
      {
        headers: {
          Host: "attacker.example",
          "X-Forwarded-Host": "forwarded-attacker.example",
        },
      },
    );
    const loaderData = publicRecipeLoader({
      context,
      params: { recipeId },
      request: attackerRequest,
    } as unknown as Parameters<typeof publicRecipeLoader>[0]);

    expect(loaderData.canonicalUrl).toBe(
      `https://recipes.example.test/public/recipes/${recipeId}`,
    );
    expect(loaderData.heroUrl).toBe(
      "https://recipes.example.test/public/assets/social-card.webp",
    );
    const hydration = JSON.stringify(loaderData);
    expect(hydration).not.toContain("attacker.example");
    expect(hydration).not.toContain("PRIVATE_SOURCE_URL_SENTINEL");
    expect(hydration).not.toContain("PRIVATE_ORIGINAL_WORDING_SENTINEL");
    expect(hydration).not.toContain("PRIVATE_CLASSIFICATION_SENTINEL");

    const markup = renderToStaticMarkup(
      createElement(PublicRecipe, {
        loaderData,
      } as Parameters<typeof PublicRecipe>[0]),
    );
    expect(markup).toContain("Sunday Lasagna");
    expect(markup).not.toContain("PRIVATE_SOURCE_URL_SENTINEL");
    expect(markup).not.toContain("PRIVATE_ORIGINAL_WORDING_SENTINEL");

    const inviteRequest = new Request("https://attacker.example/people", {
      body: new URLSearchParams({
        email: "invitee@example.com",
        intent: "invite",
        role: "viewer",
      }),
      headers: {
        Cookie: sessionCookie,
        Host: "attacker.example",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Forwarded-Host": "forwarded-attacker.example",
      },
      method: "POST",
    });
    const inviteResult = await peopleAction({
      context,
      params: {},
      request: inviteRequest,
    } as unknown as Parameters<typeof peopleAction>[0]);
    const serializedInvite = JSON.stringify(inviteResult);
    expect(serializedInvite).toContain("https://recipes.example.test/invite/");
    expect(serializedInvite).not.toContain("attacker.example");
  });

  it("returns the same privacy-safe sign-in preview for private and unknown recipe IDs", async () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://recipes.example.test");
    const { recipeId, runtime } = await publishedFixture(false);
    const context = new RouterContextProvider();
    context.set(appRuntimeContext, runtime);

    const privateData = publicRecipeLoader({
      context,
      params: { recipeId },
      request: new Request(
        `https://attacker.example/public/recipes/${recipeId}`,
      ),
    } as unknown as Parameters<typeof publicRecipeLoader>[0]);
    const unknownData = publicRecipeLoader({
      context,
      params: { recipeId: "unknown-recipe" },
      request: new Request(
        "https://attacker.example/public/recipes/unknown-recipe",
      ),
    } as unknown as Parameters<typeof publicRecipeLoader>[0]);

    expect(privateData).toMatchObject({ kind: "private" });
    expect(unknownData).toMatchObject({ kind: "private" });
    expect(privateData.socialCardUrl).toBe(
      "https://recipes.example.test/public/assets/social-card.webp",
    );
    const privateProjection = JSON.stringify(privateData);
    expect(privateProjection).not.toContain("Sunday Lasagna");
    expect(privateProjection).not.toContain("PRIVATE_SOURCE_URL_SENTINEL");
    expect(privateProjection).not.toContain(
      "PRIVATE_ORIGINAL_WORDING_SENTINEL",
    );
    expect(privateProjection).not.toContain("PRIVATE_CLASSIFICATION_SENTINEL");

    const markup = renderToStaticMarkup(
      createElement(PublicRecipe, {
        loaderData: privateData,
      } as Parameters<typeof PublicRecipe>[0]),
    );
    expect(markup).toContain("This recipe is private");
    expect(markup).toContain("Sign in");
    expect(markup).not.toContain("Sunday Lasagna");

    const metadata = publicRecipeMeta({
      loaderData: privateData,
    } as Parameters<typeof publicRecipeMeta>[0]);
    const serializedMetadata = JSON.stringify(metadata);
    expect(serializedMetadata).toContain("Found & Made");
    expect(serializedMetadata).toContain("Sign in");
    expect(serializedMetadata).not.toContain("Sunday Lasagna");
    expect(serializedMetadata).not.toContain("PRIVATE_SOURCE_URL_SENTINEL");
  });

  it("validates configured origins and root-relative public paths", () => {
    expect(
      publicOriginFromEnv({ PUBLIC_ORIGIN: "https://recipes.example.test/" }),
    ).toBe("https://recipes.example.test");
    expect(
      publicUrl("/invite/token", {
        PUBLIC_ORIGIN: "http://192.168.1.10:3000",
      }),
    ).toBe("http://192.168.1.10:3000/invite/token");
    expect(() =>
      publicOriginFromEnv({ PUBLIC_ORIGIN: "javascript:alert(1)" }),
    ).toThrow("HTTP or HTTPS");
    expect(() =>
      publicOriginFromEnv({ PUBLIC_ORIGIN: "https://user:pass@example.test" }),
    ).toThrow("credentials");
    expect(() =>
      publicOriginFromEnv({ PUBLIC_ORIGIN: "https://example.test/path" }),
    ).toThrow("path, query, or fragment");
    expect(() =>
      publicUrl("//attacker.example/path", {
        PUBLIC_ORIGIN: "https://recipes.example.test",
      }),
    ).toThrow("root-relative");
  });

  async function publishedFixture(publish: boolean) {
    const directory = await mkdtemp(join(tmpdir(), "found-made-publishing-"));
    const runtime = await createRuntime({
      dataDir: directory,
      startWorker: false,
    });
    cleanup.push({ directory, runtime });
    const owner = await runtime.identityService.createInitialOwner(ownerInput);
    const principal = {
      kind: "user",
      role: "owner",
      userId: owner.id,
    } as const;
    const recipe = runtime.recipeService.create(
      fourServingRecipe({
        allergens: [
          { confirmed: true, name: "PRIVATE_CLASSIFICATION_SENTINEL" },
        ],
        creatorName: "Aunt June",
        sharedNotes: "PRIVATE_SHARED_NOTES_SENTINEL",
        source: {
          canonicalUrl: "https://private.example/PRIVATE_SOURCE_URL_SENTINEL",
          originalUrl:
            "https://private.example/PRIVATE_SOURCE_URL_SENTINEL?original=1",
          originalWording: "PRIVATE_ORIGINAL_WORDING_SENTINEL",
        },
      }),
    );
    runtime.publishingService.setPublicMode(principal, true);
    if (publish) {
      runtime.publishingService.publish(principal, recipe.id);
    }
    const signIn = await runtime.auth.api.signInEmail({
      body: { email: ownerInput.email, password: ownerInput.password },
      returnHeaders: true,
    });
    return {
      ownerId: owner.id,
      recipeId: recipe.id,
      runtime,
      sessionCookie: signIn.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; "),
    };
  }
});
