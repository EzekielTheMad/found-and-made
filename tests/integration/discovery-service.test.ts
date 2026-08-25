import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DiscoveryService } from "#src/modules/discovery/discovery.service.server";
import { createRuntime, type AppRuntime } from "#src/platform/runtime.server";
import { fourServingRecipe } from "../fixtures/four-serving-recipe";

const owner = { kind: "user", role: "owner", userId: "owner-user" } as const;
const editor = { kind: "user", role: "editor", userId: "editor-user" } as const;
const viewer = { kind: "user", role: "viewer", userId: "viewer-user" } as const;
const secondViewer = {
  kind: "user",
  role: "viewer",
  userId: "second-viewer-user",
} as const;

describe("discovery application service", () => {
  const cleanup: Array<{ directory: string; runtime?: AppRuntime }> = [];

  afterEach(async () => {
    for (const item of cleanup.splice(0)) {
      await item.runtime?.close();
      await rm(item.directory, { force: true, recursive: true });
    }
  });

  it("searches the maintained FTS index and honors hierarchical include/exclude facets", async () => {
    const { discovery, runtime } = await fixture();
    const cuisine = discovery.createFacetGroup(owner, { name: "Cuisine" });
    const holidayGroup = discovery.createFacetGroup(owner, {
      name: "Occasion",
    });
    const italian = discovery.createFacetTerm(owner, {
      aliases: ["Italian food"],
      groupId: cuisine,
      name: "Italian",
    });
    const pasta = discovery.createFacetTerm(owner, {
      groupId: cuisine,
      name: "Pasta",
      parentId: italian.id,
    });
    const holiday = discovery.createFacetTerm(owner, {
      groupId: holidayGroup,
      name: "Holiday",
    });
    const weekday = runtime.recipeService.create(fourServingRecipe());
    const festive = runtime.recipeService.create(
      fourServingRecipe({
        id: "holiday-lasagna",
        source: { originalUrl: "https://example.com/holiday-lasagna" },
        title: "Holiday Lasagna",
      }),
      { allowDuplicate: true },
    );
    discovery.assignTerms(editor, weekday.id, [pasta.id]);
    discovery.assignTerms(editor, festive.id, [pasta.id, holiday.id]);

    expect(discovery.findTerms(viewer, "italian food")).toMatchObject([
      { id: italian.id, name: "Italian" },
    ]);
    expect(discovery.facetGroups(viewer)).toMatchObject([
      { id: cuisine, name: "Cuisine" },
      { id: holidayGroup, name: "Occasion" },
    ]);
    expect(discovery.recipeClassification(viewer, festive.id)).toEqual({
      labelNames: [],
      termIds: [holiday.id, pasta.id].sort(),
    });
    expect(
      discovery
        .search(
          viewer,
          { includeTermIds: [italian.id], search: "lasagna" },
          "title",
        )
        .map((recipe) => recipe.id),
    ).toEqual([festive.id, weekday.id]);
    expect(
      discovery
        .search(viewer, {
          includeTermIds: [italian.id],
          excludeTermIds: [holiday.id],
        })
        .map((recipe) => recipe.id),
    ).toEqual([weekday.id]);
  });

  it("stores labels, manual collection membership, personal views, and Weeknight exclusion", async () => {
    const { discovery, runtime } = await fixture();
    const occasion = discovery.createFacetGroup(owner, { name: "Occasion" });
    const holiday = discovery.createFacetTerm(owner, {
      groupId: occasion,
      name: "Holiday",
    });
    const ordinary = runtime.recipeService.create(fourServingRecipe());
    const festive = runtime.recipeService.create(
      fourServingRecipe({
        id: "festive",
        source: { originalUrl: "https://example.com/festive-lasagna" },
        title: "Festive Lasagna",
      }),
      { allowDuplicate: true },
    );
    discovery.assignTerms(editor, festive.id, [holiday.id]);
    discovery.assignLabels(editor, ordinary.id, ["Family", "Sunday dinner"]);
    const collectionId = discovery.createCollection(owner, {
      title: "Favorites",
    });
    discovery.assignCollectionRecipes(owner, collectionId, [
      ordinary.id,
      festive.id,
    ]);
    const stored = runtime.database.sqlite
      .prepare(
        `SELECT l.name FROM labels l JOIN recipe_labels rl ON rl.label_id = l.id
         WHERE rl.recipe_id = ? ORDER BY l.name`,
      )
      .all(ordinary.id) as Array<{ name: string }>;
    expect(stored.map((item) => item.name)).toEqual([
      "Family",
      "Sunday dinner",
    ]);
    const labelSummaries = discovery.labels(viewer);
    expect(
      labelSummaries.map(({ name, recipeCount }) => ({ name, recipeCount })),
    ).toEqual([
      { name: "Family", recipeCount: 1 },
      { name: "Sunday dinner", recipeCount: 1 },
    ]);
    expect(discovery.collection(viewer, collectionId)).toMatchObject({
      id: collectionId,
      recipeCount: 2,
      recipeIds: [ordinary.id, festive.id],
    });
    expect(discovery.collections(viewer)).toMatchObject([
      { id: collectionId, recipeCount: 2, title: "Favorites" },
    ]);

    const personal = discovery.createSavedView(viewer, {
      criteria: { search: "lasagna" },
      layout: "list",
      name: "My lasagna",
      pinned: true,
      sort: "title",
    });
    expect(personal).toMatchObject({
      layout: "list",
      pinned: true,
      userId: viewer.userId,
    });
    const starter = discovery
      .ensureStarterViews(owner)
      .find((view) => view.name === "Weeknight Dinner");
    expect(starter?.criteria.excludeTermIds).toEqual([holiday.id]);
    expect(
      discovery.search(viewer, starter?.criteria).map((recipe) => recipe.id),
    ).toEqual([ordinary.id]);
    expect(discovery.listSavedViews(viewer).map((view) => view.name)).toContain(
      "My lasagna",
    );
    discovery.setDefaultView(viewer, personal.id);
    expect(discovery.defaultView(viewer)).toMatchObject({ id: personal.id });
    expect(() => discovery.setDefaultView(secondViewer, personal.id)).toThrow(
      "not available",
    );
    discovery.setDefaultView(viewer, undefined);
    expect(discovery.defaultView(viewer)).toBeUndefined();
  });

  it("bulk adds and removes tags without overwriting unrelated classifications", async () => {
    const { discovery, runtime } = await fixture();
    const occasion = discovery.createFacetGroup(owner, { name: "Occasion" });
    const holiday = discovery.createFacetTerm(owner, {
      groupId: occasion,
      name: "Holiday",
    });
    const first = runtime.recipeService.create(fourServingRecipe());
    const second = runtime.recipeService.create(
      fourServingRecipe({
        source: { originalUrl: "https://example.com/bulk-second" },
        title: "Bulk second",
      }),
    );
    discovery.assignLabels(editor, first.id, ["Keep me"]);

    discovery.bulkUpdateClassification(editor, [first.id, second.id], {
      labelNames: ["Imported"],
      mode: "add",
      termIds: [holiday.id],
    });
    expect(discovery.recipeClassification(viewer, first.id)).toEqual({
      labelNames: ["Imported", "Keep me"],
      termIds: [holiday.id],
    });
    expect(discovery.recipeClassification(viewer, second.id)).toEqual({
      labelNames: ["Imported"],
      termIds: [holiday.id],
    });

    discovery.bulkUpdateClassification(editor, [first.id, second.id], {
      labelNames: ["Imported"],
      mode: "remove",
      termIds: [holiday.id],
    });
    expect(discovery.recipeClassification(viewer, first.id)).toEqual({
      labelNames: ["Keep me"],
      termIds: [],
    });
    expect(discovery.recipeClassification(viewer, second.id)).toEqual({
      labelNames: [],
      termIds: [],
    });
    expect(() =>
      discovery.bulkUpdateClassification(viewer, [first.id], {
        labelNames: ["Denied"],
        mode: "add",
        termIds: [],
      }),
    ).toThrow("authorized");
  });

  it("requires owner configuration and exposes deterministic home sections", async () => {
    const { discovery } = await fixture();
    expect(() => discovery.createFacetGroup(editor, { name: "Diet" })).toThrow(
      "authorized",
    );
    const section = discovery.configureHomeSection(owner, {
      config: { savedView: "weeknight" },
      position: 0,
      title: "Weeknight ideas",
    });
    expect(discovery.homeSections(viewer)).toEqual([section]);
  });

  it("refreshes Weeknight starter criteria after Holiday taxonomy is added", async () => {
    const { discovery, runtime } = await fixture();
    discovery.ensureStarterViews(owner);
    const occasion = discovery.createFacetGroup(owner, { name: "Occasion" });
    const holiday = discovery.createFacetTerm(owner, {
      groupId: occasion,
      name: "Holiday",
    });
    const holidayChild = discovery.createFacetTerm(owner, {
      groupId: occasion,
      name: "Thanksgiving",
      parentId: holiday.id,
    });
    const ordinary = runtime.recipeService.create(fourServingRecipe());
    const festive = runtime.recipeService.create(
      fourServingRecipe({
        id: "late-holiday",
        source: { originalUrl: "https://example.com/late-holiday" },
        title: "Late holiday lasagna",
      }),
      { allowDuplicate: true },
    );
    discovery.assignTerms(editor, festive.id, [holidayChild.id]);

    const weeknight = discovery
      .listSavedViews(owner)
      .find((view) => view.name === "Weeknight Dinner");
    expect(weeknight?.criteria.excludeTermIds).toEqual([holiday.id]);
    expect(
      discovery.search(viewer, weeknight?.criteria).map((item) => item.id),
    ).toEqual([ordinary.id]);
  });

  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "found-made-discovery-"));
    const item: { directory: string; runtime: AppRuntime } = {
      directory,
      runtime: await createRuntime({ dataDir: directory, startWorker: false }),
    };
    cleanup.push(item);
    const timestamp = "2026-07-31T00:00:00.000Z";
    const insertUser = item.runtime.database.sqlite.prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?)`,
    );
    const insertRole = item.runtime.database.sqlite.prepare(
      `INSERT INTO app_users (user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    );
    for (const principal of [owner, editor, viewer, secondViewer]) {
      insertUser.run(
        principal.userId,
        principal.userId,
        `${principal.userId}@example.test`,
        timestamp,
        timestamp,
      );
      insertRole.run(principal.userId, principal.role, timestamp, timestamp);
    }
    return {
      discovery: new DiscoveryService(
        item.runtime.database.sqlite,
        item.runtime.recipeService,
      ),
      runtime: item.runtime,
    };
  }
});
