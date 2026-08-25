import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DiscoveryService } from "#src/modules/discovery/discovery.service.server";
import type { Principal } from "#src/modules/identity/identity.types";
import { PrintSelectionService } from "#src/modules/printing/print-selection.service.server";
import { RecipeAccessService } from "#src/modules/recipes/recipe-access.service.server";
import { RecipeService } from "#src/modules/recipes/recipe.service.server";
import {
  openDatabase,
  type DatabaseHandle,
} from "#src/platform/db/database.server";
import { fourServingRecipe } from "../fixtures/four-serving-recipe";

type UserPrincipal = Extract<Principal, { kind: "user" }>;

const owner: UserPrincipal = { kind: "user", role: "owner", userId: "owner" };
const editor: UserPrincipal = {
  kind: "user",
  role: "editor",
  userId: "editor",
};
const viewer: UserPrincipal = {
  kind: "user",
  role: "viewer",
  userId: "viewer",
};

describe("print selection resolution", () => {
  const cleanup: Array<{ database: DatabaseHandle; directory: string }> = [];

  afterEach(async () => {
    for (const item of cleanup.splice(0)) {
      item.database.close();
      await rm(item.directory, { force: true, recursive: true });
    }
  });

  it("resolves authorized individual, search, facet, label, collection, and saved-view sources", async () => {
    const fixture = await createFixture();
    const { ids, selection } = fixture;

    expect(
      selection.resolve(viewer, { kind: "recipe", recipeId: ids.alpha }),
    ).toEqual([ids.alpha]);
    expect(
      selection.resolve(viewer, {
        filters: { search: "lasagna" },
        kind: "search",
        sort: "title",
      }),
    ).toEqual([ids.alpha, ids.holiday, ids.zeta]);
    expect(
      selection.resolve(viewer, { kind: "facet", termId: ids.holidayTerm }),
    ).toEqual([ids.holiday]);
    expect(
      selection.resolve(viewer, { kind: "label", label: "family" }),
    ).toEqual([ids.zeta, ids.alpha]);
    expect(
      selection.resolve(viewer, {
        collectionId: ids.collection,
        kind: "collection",
      }),
    ).toEqual([ids.zeta, ids.holiday]);
    expect(
      selection.resolve(viewer, {
        kind: "saved_view",
        savedViewId: ids.savedView,
      }),
    ).toEqual([ids.holiday]);
  });

  it("rejects missing sources and excludes trashed collection recipes", async () => {
    const fixture = await createFixture();
    const { ids, recipes, selection } = fixture;
    recipes.trash(ids.zeta, 1);

    expect(
      selection.resolve(viewer, {
        collectionId: ids.collection,
        kind: "collection",
      }),
    ).toEqual([ids.holiday]);
    expect(() =>
      selection.resolve(viewer, { kind: "recipe", recipeId: "missing" }),
    ).toThrow("not found");
    expect(() =>
      selection.resolve(viewer, { kind: "facet", termId: "missing" }),
    ).toThrow("Facet term not found");
    expect(() =>
      selection.resolve(viewer, { kind: "label", label: "missing" }),
    ).toThrow("Label not found");
    expect(() =>
      selection.resolve(viewer, { kind: "saved_view", savedViewId: "missing" }),
    ).toThrow("Saved view not found");
  });

  async function createFixture() {
    const directory = await mkdtemp(
      join(tmpdir(), "found-made-print-selection-"),
    );
    const database = openDatabase({ filePath: join(directory, "app.db") });
    cleanup.push({ database, directory });
    const recipes = new RecipeService(database.sqlite);
    const access = new RecipeAccessService(recipes);
    const discovery = new DiscoveryService(database.sqlite, recipes);
    const selection = new PrintSelectionService(discovery, access);
    seedUser(database, owner);
    seedUser(database, editor);
    seedUser(database, viewer);

    const alpha = recipes.create(
      fourServingRecipe({ id: "alpha", title: "Alpha Lasagna" }),
    );
    const holiday = recipes.create(
      fourServingRecipe({ id: "holiday", title: "Holiday Lasagna" }),
      { allowDuplicate: true },
    );
    const zeta = recipes.create(
      fourServingRecipe({ id: "zeta", title: "Zeta Lasagna" }),
      { allowDuplicate: true },
    );
    const group = discovery.createFacetGroup(owner, { name: "Occasion" });
    const holidayTerm = discovery.createFacetTerm(owner, {
      groupId: group,
      name: "Holiday",
    });
    discovery.assignTerms(editor, holiday.id, [holidayTerm.id]);
    discovery.assignLabels(editor, alpha.id, ["Family"]);
    discovery.assignLabels(editor, zeta.id, ["Family"]);
    const collection = discovery.createCollection(owner, {
      title: "Print order",
    });
    discovery.assignCollectionRecipes(owner, collection, [zeta.id, holiday.id]);
    const saved = discovery.createSavedView(viewer, {
      criteria: { includeTermIds: [holidayTerm.id] },
      name: "Holiday print",
      sort: "title",
    });
    return {
      ids: {
        alpha: alpha.id,
        collection,
        holiday: holiday.id,
        holidayTerm: holidayTerm.id,
        savedView: saved.id,
        zeta: zeta.id,
      },
      recipes,
      selection,
    };
  }
});

function seedUser(database: DatabaseHandle, principal: UserPrincipal): void {
  const timestamp = "2026-07-31T00:00:00.000Z";
  database.sqlite
    .prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(
      principal.userId,
      principal.userId,
      `${principal.userId}@example.test`,
      timestamp,
      timestamp,
    );
  database.sqlite
    .prepare(
      `INSERT INTO app_users (user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(principal.userId, principal.role, timestamp, timestamp);
}
