import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PRINT_PAGE_DIMENSIONS_MM,
  PrintingService,
} from "#src/modules/printing/printing.service.server";
import {
  PrintIdempotencyConflictError,
  type PrintPageSize,
  type PrintProfileConfig,
  PrintVersionConflictError,
} from "#src/modules/printing/printing.types";
import {
  anonymousPrincipal,
  systemPrincipal,
} from "#src/modules/identity/identity.types";
import { createRuntime, type AppRuntime } from "#src/platform/runtime.server";
import { fourServingRecipe } from "../fixtures/four-serving-recipe";

const owner = { kind: "user", role: "owner", userId: "owner-user" } as const;
const editor = {
  kind: "user",
  role: "editor",
  userId: "editor-user",
} as const;
const viewer = {
  kind: "user",
  role: "viewer",
  userId: "viewer-user",
} as const;
const secondViewer = {
  kind: "user",
  role: "viewer",
  userId: "second-viewer-user",
} as const;

describe("printing persistence application service", () => {
  const cleanup: Array<{ directory: string; runtime: AppRuntime }> = [];

  afterEach(async () => {
    for (const item of cleanup.splice(0)) {
      await item.runtime.close();
      await rm(item.directory, { force: true, recursive: true });
    }
  });

  it("validates and reopens private Letter, A4, and Half-Letter profiles for every role", async () => {
    const { printing } = await fixture();
    const cases: Array<
      [typeof owner | typeof editor | typeof viewer, PrintPageSize]
    > = [
      [owner, "letter"],
      [editor, "a4"],
      [viewer, "half-letter"],
    ];

    for (const [principal, pageSize] of cases) {
      const profile = printing.createProfile(principal, {
        config: profileConfig(pageSize),
        name: `${pageSize} profile`,
      });
      expect(printing.getProfile(principal, profile.id)).toEqual(profile);
      expect(printing.listProfiles(principal)).toHaveLength(1);
      expect(typeof PRINT_PAGE_DIMENSIONS_MM[pageSize].height).toBe("number");
      expect(typeof PRINT_PAGE_DIMENSIONS_MM[pageSize].width).toBe("number");
    }

    const privateProfile = printing.listProfiles(viewer)[0];
    expect(() => printing.getProfile(secondViewer, privateProfile.id)).toThrow(
      "not found",
    );
    expect(() =>
      printing.createProfile(anonymousPrincipal, {
        config: profileConfig("letter"),
        name: "Anonymous",
      }),
    ).toThrow("authorized");
    expect(() =>
      printing.createProfile(systemPrincipal, {
        config: profileConfig("letter"),
        name: "System",
      }),
    ).toThrow("requires a user account");
    expect(() =>
      printing.createProfile(viewer, {
        config: profileConfig("tabloid" as never),
        name: "Bad paper",
      }),
    ).toThrow("Letter, A4, or Half-Letter");
    expect(() =>
      printing.createProfile(viewer, {
        config: {
          ...profileConfig("half-letter"),
          marginsMm: { bottom: 10, left: 50, right: 50, top: 10 },
        },
        name: "No usable width",
      }),
    ).toThrow("usable page area");
  });

  it("saves, reopens, updates, and reorders a modular cookbook outline with recipe overrides", async () => {
    const { printing, recipes } = await fixture();
    const profile = printing.createProfile(viewer, {
      config: profileConfig("letter"),
      name: "Family binder",
    });
    const collection = printing.createCollection(viewer, {
      globalLayout: "classic-two-column",
      name: "Family Favorites",
      outline: [
        { id: "cover", title: "Family Favorites", type: "cover" },
        { id: "dinners", title: "Dinners", type: "divider" },
        { id: "pasta", title: "Pasta", type: "section" },
        {
          id: "lasagna",
          layoutOverride: "step-linked",
          recipeId: recipes[0].id,
          targetServings: 8,
          type: "recipe",
        },
        { heading: "Kitchen notes", id: "notes", lines: 20, type: "notes" },
        { id: "quick", recipeId: recipes[1].id, type: "recipe" },
      ],
      profileId: profile.id,
    });

    expect(collection).toMatchObject({
      globalLayout: "classic-two-column",
      numberingMode: "modular",
      profileId: profile.id,
      version: 1,
    });
    expect(printing.getCollection(viewer, collection.id)).toEqual(collection);

    const reordered = printing.reorderCollection(
      viewer,
      collection.id,
      ["cover", "dinners", "pasta", "quick", "lasagna", "notes"],
      { expectedVersion: 1 },
    );
    expect(reordered.outline.map((item) => item.id)).toEqual([
      "cover",
      "dinners",
      "pasta",
      "quick",
      "lasagna",
      "notes",
    ]);
    expect(reordered.version).toBe(2);

    const fixed = printing.updateCollection(
      viewer,
      collection.id,
      { globalLayout: "compact-card", numberingMode: "fixed" },
      { expectedVersion: 2 },
    );
    expect(fixed).toMatchObject({
      globalLayout: "compact-card",
      numberingMode: "fixed",
      version: 3,
    });
    const duplicate = printing.duplicateCollection(viewer, collection.id);
    expect(duplicate).toMatchObject({
      description: fixed.description,
      globalLayout: fixed.globalLayout,
      name: "Family Favorites copy",
      numberingMode: fixed.numberingMode,
      profileId: fixed.profileId,
      version: 1,
    });
    expect(duplicate.id).not.toBe(collection.id);
    expect(duplicate.outline[0]).toMatchObject({
      title: "Family Favorites copy",
      type: "cover",
    });
    expect(duplicate.outline.map((item) => item.id)).not.toEqual(
      fixed.outline.map((item) => item.id),
    );
    const copiedRecipes = duplicate.outline.filter(
      (item) => item.type === "recipe",
    );
    expect(
      copiedRecipes.map((item) => ({
        layoutOverride: item.layoutOverride,
        recipeId: item.recipeId,
        targetServings: item.targetServings,
        type: item.type,
      })),
    ).toEqual(
      fixed.outline
        .filter((item) => item.type === "recipe")
        .map((item) => ({
          layoutOverride: item.layoutOverride,
          recipeId: item.recipeId,
          targetServings: item.targetServings,
          type: item.type,
        })),
    );
    expect(printing.getCollection(viewer, collection.id)).toEqual(fixed);
    expect(() =>
      printing.duplicateCollection(secondViewer, collection.id),
    ).toThrow("not found");
    expect(() =>
      printing.deleteCollection(secondViewer, duplicate.id, {
        expectedVersion: 1,
      }),
    ).toThrow("not found");
    expect(() =>
      printing.deleteCollection(viewer, duplicate.id, { expectedVersion: 2 }),
    ).toThrow(PrintVersionConflictError);
    const preservedJob = printing.createPrintJob(viewer, {
      collectionId: duplicate.id,
      idempotencyKey: "copied-cookbook-before-delete",
    });
    expect(
      printing.deleteCollection(viewer, duplicate.id, { expectedVersion: 1 }),
    ).toEqual(duplicate);
    expect(() => printing.getCollection(viewer, duplicate.id)).toThrow(
      "not found",
    );
    const reopenedJob = printing.getPrintJob(viewer, preservedJob.id);
    expect(reopenedJob).toMatchObject({
      id: preservedJob.id,
      request: preservedJob.request,
      status: preservedJob.status,
    });
    expect(reopenedJob.collectionId).toBeUndefined();
    expect(() =>
      printing.updateCollection(
        viewer,
        collection.id,
        { name: "Stale" },
        { expectedVersion: 2 },
      ),
    ).toThrow(PrintVersionConflictError);
    expect(() => printing.getCollection(secondViewer, collection.id)).toThrow(
      "not found",
    );
    expect(() =>
      printing.createCollection(viewer, {
        globalLayout: "classic-single-column",
        name: "Missing recipe",
        outline: [{ id: "missing", recipeId: "not-a-recipe", type: "recipe" }],
      }),
    ).toThrow("not found");
  });

  it("snapshots overrides and persists idempotent job and contained PDF artifact metadata", async () => {
    const { directory, printing, printRoot, recipes, runtime } =
      await fixture();
    const profile = printing.createProfile(viewer, {
      config: profileConfig("a4"),
      name: "A4 archive",
    });
    const collection = printing.createCollection(viewer, {
      globalLayout: "classic-single-column",
      name: "Dinner book",
      outline: [
        { id: "cover", title: "Dinner Book", type: "cover" },
        {
          id: "first",
          layoutOverride: "landscape-merge-grid",
          recipeId: recipes[0].id,
          targetServings: 12,
          type: "recipe",
        },
        { id: "second", recipeId: recipes[1].id, type: "recipe" },
      ],
      profileId: profile.id,
    });
    const jobInput = {
      collectionId: collection.id,
      idempotencyKey: "print-dinner-book-1",
    } as const;
    const queued = printing.createPrintJob(viewer, jobInput);
    const replay = printing.createPrintJob(viewer, jobInput);
    expect(replay.id).toBe(queued.id);
    expect(queued).toMatchObject({
      request: {
        numberingMode: "modular",
        selections: [
          {
            layout: "landscape-merge-grid",
            recipeId: recipes[0].id,
            recipeVersion: recipes[0].version,
            targetServings: 12,
          },
          {
            layout: "classic-single-column",
            recipeId: recipes[1].id,
            recipeVersion: recipes[1].version,
            targetServings: 4,
          },
        ],
      },
      status: "queued",
      version: 1,
    });
    expect(() =>
      printing.createPrintJob(viewer, {
        ...jobInput,
        globalLayout: "compact-card",
      }),
    ).toThrow(PrintIdempotencyConflictError);

    const rendering = printing.markPrintJobRendering(
      systemPrincipal,
      queued.id,
      {
        expectedVersion: 1,
      },
    );
    const relativePath = printing.suggestedArtifactRelativePath(queued.id);
    const artifactPath = printing.resolveArtifactPath(relativePath);
    expect(artifactPath.startsWith(printRoot)).toBe(true);
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(
      artifactPath,
      Buffer.from("%PDF-1.7\n% deterministic fake fixture\n%%EOF\n"),
    );
    const completed = printing.completePrintJob(systemPrincipal, queued.id, {
      artifactRelativePath: relativePath,
      expectedVersion: rendering.version,
      pageCount: 12,
    });
    expect(completed).toMatchObject({
      artifact: {
        mimeType: "application/pdf",
        pageCount: 12,
        relativePath,
      },
      status: "completed",
      version: 3,
    });
    expect(completed.artifact?.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(completed.artifact?.sizeBytes).toBeGreaterThan(0);
    expect(() => printing.getPrintJob(secondViewer, queued.id)).toThrow(
      "not found",
    );
    expect(() => printing.resolveArtifactPath("../escape.pdf")).toThrow(
      "relative PDF path",
    );

    const reopened = new PrintingService(
      runtime.database.sqlite,
      runtime.recipeAccessService,
      join(directory, "print"),
    );
    expect(reopened.getPrintJob(viewer, queued.id)).toEqual(completed);
    const stored = runtime.database.sqlite
      .prepare(
        `SELECT artifact_relative_path AS artifactPath
         FROM print_jobs WHERE id = ?`,
      )
      .get(queued.id) as { artifactPath: string };
    expect(stored.artifactPath).toBe(relativePath);
    expect(stored.artifactPath).not.toContain(directory);
  });

  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "found-made-printing-"));
    const runtime = await createRuntime({
      dataDir: directory,
      startWorker: false,
    });
    cleanup.push({ directory, runtime });
    const timestamp = "2026-07-31T00:00:00.000Z";
    const insertUser = runtime.database.sqlite.prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?)`,
    );
    const insertRole = runtime.database.sqlite.prepare(
      `INSERT INTO app_users (user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
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
    const recipes = [
      runtime.recipeService.create(fourServingRecipe()),
      runtime.recipeService.create(
        fourServingRecipe({
          id: "quick-lasagna",
          source: { originalUrl: "https://example.test/quick-lasagna" },
          title: "Quick Lasagna",
        }),
        { allowDuplicate: true },
      ),
    ];
    const printRoot = join(directory, "print");
    return {
      directory,
      printRoot,
      printing: new PrintingService(
        runtime.database.sqlite,
        runtime.recipeAccessService,
        printRoot,
      ),
      recipes,
      runtime,
    };
  }
});

function profileConfig(pageSize: PrintPageSize): PrintProfileConfig {
  return {
    defaultLayout: "classic-single-column",
    duplex: true,
    includeMetadata: true,
    includePhotos: true,
    marginsMm: { bottom: 12, left: 12, right: 12, top: 12 },
    pageSize,
    typography: {
      bodyFontSizePt: 10,
      fontFamily: "Source Serif 4",
      headingFontSizePt: 20,
    },
  };
}
