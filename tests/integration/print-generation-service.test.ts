import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import type { PrintLayout } from "#src/modules/printing/printing.types";
import { createRuntime, type AppRuntime } from "#src/platform/runtime.server";
import { fourServingRecipe } from "../fixtures/four-serving-recipe";

const owner = {
  kind: "user",
  role: "owner",
  userId: "print-owner-user",
} as const;
const secondViewer = {
  kind: "user",
  role: "viewer",
  userId: "other-print-viewer-user",
} as const;

describe("authorized print generation", () => {
  const cleanup: Array<{ directory: string; runtime: AppRuntime }> = [];

  afterEach(async () => {
    for (const item of cleanup.splice(0)) {
      await item.runtime.close();
      await rm(item.directory, { force: true, recursive: true });
    }
  });

  it("renders scaled recipes and original media into a private durable PDF", async () => {
    const directory = await mkdtemp(join(tmpdir(), "found-made-printing-"));
    const runtime = await createRuntime({
      dataDir: directory,
      startWorker: false,
    });
    cleanup.push({ directory, runtime });
    insertUsers(runtime);
    const recipe = runtime.recipeService.create(fourServingRecipe());
    const hero = await sharp({
      create: {
        background: "#a1520c",
        channels: 3,
        height: 1200,
        width: 1800,
      },
    })
      .jpeg({ quality: 95 })
      .toBuffer();
    await runtime.mediaService.upload(owner, {
      altText: "Finished printed dish",
      bytes: hero,
      recipeId: recipe.id,
      role: "hero",
    });

    const profile = runtime.printingService.createProfile(owner, {
      config: {
        defaultLayout: "classic-single-column",
        duplex: true,
        includeMetadata: true,
        includePhotos: true,
        marginsMm: { bottom: 12.7, left: 12.7, right: 12.7, top: 12.7 },
        pageSize: "half-letter",
        typography: {
          bodyFontSizePt: 10,
          fontFamily: "Helvetica",
          headingFontSizePt: 18,
        },
      },
      name: "Half-Letter binder",
    });
    const layouts: PrintLayout[] = [
      "compact-card",
      "classic-single-column",
      "classic-two-column",
      "step-linked",
      "landscape-merge-grid",
    ];
    const collection = runtime.printingService.createCollection(owner, {
      globalLayout: "classic-single-column",
      name: "Five layouts",
      outline: [
        { id: "cover", title: "Five layouts", type: "cover" },
        { id: "section", title: "Scaled recipes", type: "section" },
        ...layouts.map((layout, index) => ({
          id: `recipe-${index}`,
          layoutOverride: layout,
          recipeId: recipe.id,
          targetServings: index === 1 ? 6 : 4,
          type: "recipe" as const,
        })),
        { heading: "Kitchen notes", id: "notes", lines: 20, type: "notes" },
      ],
      profileId: profile.id,
    });
    const job = runtime.printingService.createPrintJob(owner, {
      collectionId: collection.id,
      idempotencyKey: "generation-five-layouts-1",
    });

    const printRequest = runtime.printGenerationService.collectionRequest(
      owner,
      collection.id,
    );
    const prepared = await runtime.printGenerationService.prepareDocument(
      owner,
      printRequest,
      { includeImageBytes: false },
    );
    const section = prepared.outline.find((item) => item.kind === "section");
    expect(section?.entries).toEqual(
      Array.from({ length: layouts.length }, () => recipe.title),
    );

    const pagePlan = await runtime.printGenerationService.pagePlan(
      owner,
      printRequest,
    );

    const result = await runtime.printGenerationService.generate(owner, job.id);
    expect(result.job).toMatchObject({
      artifact: { mimeType: "application/pdf" },
      status: "completed",
    });
    expect(result.recipePageBoundaries).toHaveLength(5);
    const fitWarning = result.diagnostics.find(
      (diagnostic) => diagnostic.code === "merge-table-half-letter",
    );
    expect(fitWarning).toBeDefined();
    expect(fitWarning?.remediation).toContain("landscape");

    const artifact = result.job.artifact;
    expect(artifact).toBeDefined();
    const bytes = await readFile(
      runtime.printingService.resolveArtifactPath(artifact!.relativePath),
    );
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(artifact!.pageCount);
    expect(pagePlan.pageCount).toBe(artifact!.pageCount);
    expect(
      pagePlan.outlinePageSpans.filter((span) => span.kind === "recipe"),
    ).toHaveLength(5);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(7);
    expect(() =>
      runtime.printingService.getPrintJob(secondViewer, job.id),
    ).toThrow("not found");
  });
});

function insertUsers(runtime: AppRuntime): void {
  const timestamp = "2026-07-31T00:00:00.000Z";
  const insertUser = runtime.database.sqlite.prepare(
    `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
     VALUES (?, ?, ?, 1, ?, ?)`,
  );
  const insertRole = runtime.database.sqlite.prepare(
    `INSERT INTO app_users (user_id, role, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  );
  for (const principal of [owner, secondViewer]) {
    insertUser.run(
      principal.userId,
      principal.userId,
      `${principal.userId}@example.test`,
      timestamp,
      timestamp,
    );
    insertRole.run(principal.userId, principal.role, timestamp, timestamp);
  }
}
