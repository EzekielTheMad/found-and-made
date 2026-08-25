import {
  PDFArray,
  PDFDocument,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  diagnosePrintFit,
  planPrintDocument,
  renderPrintDocument,
} from "#src/modules/printing/pdf-renderer.server";
import type {
  PrintLayout,
  PrintPageSize,
  PrintRenderDocument,
  PrintRenderRecipe,
} from "#src/modules/printing/print-renderer.types.server";

const pageSizes = {
  a4: { height: 841.89, width: 595.28 },
  "half-letter": { height: 612, width: 396 },
  letter: { height: 792, width: 612 },
} as const;

const layouts: readonly PrintLayout[] = [
  "compact-card",
  "classic",
  "two-column",
  "step-linked",
  "merge-table",
];
const layoutPageMatrix = layouts.flatMap((layout) =>
  (["letter", "a4", "half-letter"] as const).map((pageSize) => ({
    layout,
    pageSize,
  })),
);

function recipe(
  layout: PrintLayout,
  id = `recipe-${layout}-12345678`,
): PrintRenderRecipe {
  return {
    id,
    ingredients: [
      {
        displayQuantity: "3 cups",
        id: "ingredient-flour-12345678",
        name: "bread flour",
        requirement: "required",
        stepIds: ["step-mix-12345678"],
      },
      {
        displayQuantity: "1 tsp",
        guidance: "Adjust after tasting.",
        id: "ingredient-salt-12345678",
        name: "sea salt",
        requirement: "optional",
        stepIds: ["step-mix-12345678"],
      },
    ],
    layout,
    metadata: { Source: "Family notebook", Updated: "2026-07-31" },
    steps: [
      {
        id: "step-mix-12345678",
        instruction: "Mix until the dough is smooth and elastic.",
        linkedIngredientIds: [
          "ingredient-flour-12345678",
          "ingredient-salt-12345678",
        ],
      },
      {
        id: "step-bake-12345678",
        instruction: "Bake until deeply golden.",
        linkedIngredientIds: [],
      },
    ],
    targetServings: 8,
    title: `Scaled Bread ${layout}`,
    yieldText: "Makes 8 servings",
  };
}

function printDocument(
  layout: PrintLayout,
  pageSize: PrintPageSize = "letter",
  overrides: Partial<PrintRenderDocument> = {},
): PrintRenderDocument {
  return {
    edition: "modular",
    outline: [{ kind: "recipe", recipe: recipe(layout) }],
    profile: {
      baseFontSizePt: 10,
      colorMode: "color",
      duplex: false,
      includeMetadata: true,
      includePhotos: true,
      marginBottomPt: 36,
      marginLeftPt: 36,
      marginRightPt: 36,
      marginTopPt: 36,
      numbering: false,
      pageSize,
      visualStyle: "heirloom",
    },
    title: "Test cookbook",
    ...overrides,
  };
}

async function extractedText(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes);
  const text: string[] = [];
  for (const page of pdf.getPages()) {
    const contents = page.node.Contents();
    const objects =
      contents instanceof PDFArray ? contents.asArray() : [contents];
    for (const object of objects) {
      if (!object) continue;
      const stream = pdf.context.lookup(object);
      if (!(stream instanceof PDFRawStream)) continue;
      const decoded = new TextDecoder("latin1").decode(
        decodePDFRawStream(stream).decode(),
      );
      for (const match of decoded.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
        text.push(Buffer.from(match[1] ?? "", "hex").toString("latin1"));
      }
    }
  }
  return text;
}

describe("deterministic PDF renderer", () => {
  it.each(layoutPageMatrix)(
    "renders $layout on $pageSize with caller-projected quantities",
    async ({ layout, pageSize }) => {
      const result = await renderPrintDocument(printDocument(layout, pageSize));
      const parsed = await PDFDocument.load(result.bytes);
      const text = (await extractedText(result.bytes)).join(" ");

      expect(parsed.getPageCount()).toBeGreaterThan(0);
      expect(text).toContain("Scaled Bread");
      expect(text).toContain("3 cups");
      expect(text).toContain("Mix until the dough is smooth");
    },
  );

  it.each(["letter", "a4", "half-letter"] as const)(
    "uses exact %s dimensions and landscape orientation only for merge tables",
    async (pageSize) => {
      const classic = await renderPrintDocument(
        printDocument("classic", pageSize),
      );
      const merge = await renderPrintDocument(
        printDocument("merge-table", pageSize),
      );
      const classicPage = (await PDFDocument.load(classic.bytes)).getPage(0);
      const mergePage = (await PDFDocument.load(merge.bytes)).getPage(0);
      const expected = pageSizes[pageSize];

      expect(classicPage.getWidth()).toBeCloseTo(expected.width, 1);
      expect(classicPage.getHeight()).toBeCloseTo(expected.height, 1);
      expect(mergePage.getWidth()).toBeCloseTo(expected.height, 1);
      expect(mergePage.getHeight()).toBeCloseTo(expected.width, 1);
    },
  );

  it("starts recipes on dependable recto boundaries for fixed duplex editions", async () => {
    const document = printDocument("classic", "letter", {
      edition: "fixed",
      outline: [
        { kind: "recipe", recipe: recipe("classic", "recipe-first-12345678") },
        {
          kind: "recipe",
          recipe: recipe("step-linked", "recipe-second-12345678"),
        },
      ],
      profile: {
        ...printDocument("classic").profile,
        duplex: true,
        numbering: true,
      },
    });
    const result = await renderPrintDocument(document);

    expect(result.recipePageBoundaries).toEqual([
      { itemIndex: 0, pageIndex: 0, recipeId: "recipe-first-12345678" },
      { itemIndex: 1, pageIndex: 2, recipeId: "recipe-second-12345678" },
    ]);
    expect(result.pageCount).toBe(3);
  });

  it("plans every continuation and duplex spacer before generating the PDF", async () => {
    const longRecipe = {
      ...recipe("classic", "recipe-long-12345678"),
      steps: Array.from({ length: 70 }, (_, index) => ({
        id: `step-long-${String(index).padStart(3, "0")}`,
        instruction:
          `Step ${index + 1}: fold the mixture carefully, rest it until ready, ` +
          "then check the texture before continuing with the next instruction.",
        linkedIngredientIds: [],
      })),
      title: "A deliberately long family recipe",
    };
    const document = printDocument("classic", "letter", {
      edition: "fixed",
      outline: [
        { kind: "cover", title: "Long recipe test" },
        { kind: "recipe", recipe: longRecipe },
        { kind: "notes", lineCount: 20, title: "Kitchen notes" },
      ],
      profile: {
        ...printDocument("classic").profile,
        duplex: true,
        numbering: true,
      },
    });

    const plan = await planPrintDocument(document);
    const result = await renderPrintDocument(document);
    const recipeSpan = plan.outlinePageSpans.find(
      (span) => span.recipeId === longRecipe.id,
    );
    const accountedPages = plan.outlinePageSpans.reduce(
      (total, span) => total + span.leadingBlankPages + span.pageCount,
      0,
    );

    expect(recipeSpan?.pageCount).toBeGreaterThan(1);
    expect(recipeSpan?.leadingBlankPages).toBe(1);
    expect(accountedPages).toBe(plan.pageCount);
    expect(plan.pageCount).toBe(result.pageCount);
    expect(plan.outlinePageSpans).toEqual(result.outlinePageSpans);
    expect(plan.recipePageBoundaries).toEqual(result.recipePageBoundaries);
  });

  it("lists every recipe on section contents pages in outline order", async () => {
    const entries = Array.from(
      { length: 64 },
      (_, index) =>
        `${String(index + 1).padStart(2, "0")} Family recipe with a descriptive title`,
    );
    const document = printDocument("classic", "half-letter", {
      outline: [
        {
          description: "A collection of recipes worth returning to.",
          entries,
          kind: "section",
          title: "Family favorites",
        },
      ],
    });

    const plan = await planPrintDocument(document);
    const result = await renderPrintDocument(document);
    const text = (await extractedText(result.bytes)).join(" ");
    const sectionSpan = plan.outlinePageSpans[0];

    expect(sectionSpan?.pageCount).toBeGreaterThan(1);
    expect(plan.pageCount).toBe(result.pageCount);
    expect(text).toContain(entries[0]);
    expect(text).toContain(entries.at(-1));
    expect(text).toContain("SECTION CONTINUED");
  });

  it("numbers fixed editions while leaving modular sheets unnumbered", async () => {
    const cover = { kind: "cover" as const, title: "Kitchen Archive" };
    const modular = await renderPrintDocument({
      ...printDocument("classic"),
      outline: [cover],
      profile: { ...printDocument("classic").profile, numbering: true },
    });
    const fixed = await renderPrintDocument({
      ...printDocument("classic"),
      edition: "fixed",
      outline: [cover],
      profile: { ...printDocument("classic").profile, numbering: true },
    });

    expect(await extractedText(modular.bytes)).not.toContain("1");
    expect(await extractedText(fixed.bytes)).toContain("1");
  });

  it("embeds caller-provided print-resolution image bytes and document metadata", async () => {
    const bytes = await sharp({
      create: {
        background: { alpha: 1, b: 70, g: 120, r: 190 },
        channels: 4,
        height: 1200,
        width: 1800,
      },
    })
      .jpeg({ quality: 85 })
      .toBuffer();
    const imageRecipe = {
      ...recipe("classic"),
      heroImage: {
        bytes,
        height: 1200,
        mimeType: "image/jpeg" as const,
        width: 1800,
      },
    };
    const result = await renderPrintDocument({
      ...printDocument("classic"),
      outline: [{ kind: "recipe", recipe: imageRecipe }],
    });
    const blackAndWhite = await renderPrintDocument({
      ...printDocument("classic"),
      outline: [{ kind: "recipe", recipe: imageRecipe }],
      profile: {
        ...printDocument("classic").profile,
        colorMode: "black-and-white",
      },
    });
    const parsed = await PDFDocument.load(result.bytes);

    expect(Buffer.from(result.bytes).toString("latin1")).toContain(
      "/Subtype /Image",
    );
    expect(parsed.getTitle()).toBe("Test cookbook");
    expect(Buffer.from(blackAndWhite.bytes)).not.toEqual(
      Buffer.from(result.bytes),
    );
    expect(Buffer.from(blackAndWhite.bytes).toString("latin1")).toContain(
      "/Subtype /Image",
    );
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === "image-resolution-low",
      ),
    ).toBe(false);
  });

  it("returns specific Half-Letter merge-table remediation", () => {
    const diagnostic = diagnosePrintFit(
      printDocument("merge-table", "half-letter"),
    ).find((item) => item.code === "merge-table-half-letter");
    expect(diagnostic?.severity).toBe("warning");
    expect(diagnostic?.remediation).toContain("Letter or A4 landscape");
  });
});
