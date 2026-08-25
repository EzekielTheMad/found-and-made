import {
  PDFDocument,
  StandardFonts,
  cmyk,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import sharp from "sharp";

import type {
  PrintFitDiagnostic,
  PrintOutlinePageSpan,
  PrintPagePlan,
  PrintRenderDocument,
  PrintRenderHeroImage,
  PrintRenderIngredient,
  PrintRenderItem,
  PrintRenderProfile,
  PrintRenderRecipe,
  PrintRenderResult,
  PrintRecipePageBoundary,
} from "./print-renderer.types.server";

const PAGE_SIZES = {
  a4: { height: 841.89, width: 595.28 },
  "half-letter": { height: 612, width: 396 },
  letter: { height: 792, width: 612 },
} as const;

interface PrintPalette {
  readonly accent: ReturnType<typeof rgb>;
  readonly accentSoft: ReturnType<typeof rgb>;
  readonly faint: ReturnType<typeof rgb>;
  readonly muted: ReturnType<typeof rgb>;
  readonly paper: ReturnType<typeof rgb>;
  readonly text: ReturnType<typeof cmyk> | ReturnType<typeof rgb>;
}

function paletteFor(profile: PrintRenderProfile): PrintPalette {
  if (profile.colorMode === "black-and-white") {
    return {
      accent: rgb(0.08, 0.08, 0.08),
      accentSoft: rgb(0.94, 0.94, 0.94),
      faint: rgb(0.76, 0.76, 0.76),
      muted: rgb(0.34, 0.34, 0.34),
      paper: rgb(1, 1, 1),
      text: rgb(0.08, 0.08, 0.08),
    };
  }
  if (profile.visualStyle === "modern") {
    return {
      accent: rgb(0.09, 0.29, 0.2),
      accentSoft: rgb(0.89, 0.93, 0.88),
      faint: rgb(0.74, 0.79, 0.7),
      muted: rgb(0.3, 0.38, 0.32),
      paper: rgb(1, 0.995, 0.975),
      text: cmyk(0.08, 0, 0.08, 0.84),
    };
  }
  if (profile.visualStyle === "minimal") {
    return {
      accent: rgb(0.14, 0.27, 0.2),
      accentSoft: rgb(0.97, 0.97, 0.95),
      faint: rgb(0.83, 0.83, 0.79),
      muted: rgb(0.4, 0.42, 0.4),
      paper: rgb(1, 1, 1),
      text: cmyk(0, 0, 0, 0.9),
    };
  }
  return {
    accent: rgb(0.13, 0.31, 0.21),
    accentSoft: rgb(0.93, 0.89, 0.78),
    faint: rgb(0.76, 0.7, 0.58),
    muted: rgb(0.35, 0.34, 0.29),
    paper: rgb(0.995, 0.98, 0.94),
    text: cmyk(0, 0.03, 0.08, 0.86),
  };
}

interface RenderContext {
  readonly bold: PDFFont;
  readonly boundaries: PrintRecipePageBoundary[];
  readonly document: PrintRenderDocument;
  readonly heading: PDFFont;
  readonly pdf: PDFDocument;
  readonly palette: PrintPalette;
  readonly planOnly: boolean;
  readonly regular: PDFFont;
}

interface TextFlow {
  readonly bottom: number;
  readonly context: RenderContext;
  fontSize: number;
  readonly landscape: boolean;
  page: PDFPage;
  readonly recipeTitle: string;
  readonly width: number;
  readonly x: number;
  y: number;
}

export async function renderPrintDocument(
  document: PrintRenderDocument,
): Promise<PrintRenderResult> {
  const { context, outlinePageSpans } = await layOutPrintDocument(
    document,
    false,
  );
  addPageNumbers(context);
  const bytes = await context.pdf.save({
    addDefaultPage: false,
    useObjectStreams: false,
  });
  return {
    bytes,
    diagnostics: diagnosePrintFit(document),
    outlinePageSpans,
    pageCount: context.pdf.getPageCount(),
    recipePageBoundaries: context.boundaries,
  };
}

export async function planPrintDocument(
  document: PrintRenderDocument,
): Promise<PrintPagePlan> {
  const { context, outlinePageSpans } = await layOutPrintDocument(
    document,
    true,
  );
  return {
    diagnostics: diagnosePrintFit(document),
    outlinePageSpans,
    pageCount: context.pdf.getPageCount(),
    recipePageBoundaries: context.boundaries,
  };
}

async function layOutPrintDocument(
  document: PrintRenderDocument,
  planOnly: boolean,
): Promise<{
  context: RenderContext;
  outlinePageSpans: PrintOutlinePageSpan[];
}> {
  validateDocument(document);
  const pdf = await PDFDocument.create();
  pdf.setTitle(cleanText(document.title));
  pdf.setAuthor("Found & Made");
  pdf.setCreator("Found & Made deterministic PDF renderer");
  pdf.setProducer("Found & Made / pdf-lib 1.17.1");
  pdf.setSubject(`${document.edition} cookbook edition`);
  pdf.setCreationDate(new Date(0));
  pdf.setModificationDate(new Date(0));

  const [regular, bold, serifBold] = await Promise.all([
    pdf.embedFont(StandardFonts.Helvetica),
    pdf.embedFont(StandardFonts.HelveticaBold),
    pdf.embedFont(StandardFonts.TimesRomanBold),
  ]);
  const context: RenderContext = {
    bold,
    boundaries: [],
    document,
    heading: document.profile.visualStyle === "heirloom" ? serifBold : bold,
    palette: paletteFor(document.profile),
    pdf,
    planOnly,
    regular,
  };
  const outlinePageSpans: PrintOutlinePageSpan[] = [];

  for (const [itemIndex, item] of document.outline.entries()) {
    const pageCountBeforeItem = pdf.getPageCount();
    if (item.kind === "recipe") {
      prepareRecipeBoundary(context, itemIndex, item.recipe);
      const startPageIndex = pdf.getPageCount();
      await renderRecipe(context, item.recipe);
      outlinePageSpans.push({
        endPageIndex: pdf.getPageCount() - 1,
        itemIndex,
        kind: item.kind,
        leadingBlankPages: startPageIndex - pageCountBeforeItem,
        pageCount: pdf.getPageCount() - startPageIndex,
        recipeId: item.recipe.id,
        startPageIndex,
      });
    } else {
      renderFrontMatter(context, item);
      outlinePageSpans.push({
        endPageIndex: pdf.getPageCount() - 1,
        itemIndex,
        kind: item.kind,
        leadingBlankPages: 0,
        pageCount: pdf.getPageCount() - pageCountBeforeItem,
        startPageIndex: pageCountBeforeItem,
      });
    }
  }

  if (pdf.getPageCount() === 0)
    renderFrontMatter(context, { kind: "cover", title: document.title });
  return { context, outlinePageSpans };
}

export function diagnosePrintFit(
  document: PrintRenderDocument,
): PrintFitDiagnostic[] {
  validateDocument(document);
  const diagnostics: PrintFitDiagnostic[] = [];
  const size = PAGE_SIZES[document.profile.pageSize];
  const contentWidth =
    size.width - document.profile.marginLeftPt - document.profile.marginRightPt;
  const contentHeight =
    size.height -
    document.profile.marginTopPt -
    document.profile.marginBottomPt;

  if (contentWidth < 216 || contentHeight < 288) {
    diagnostics.push({
      code: "narrow-content-area",
      itemIndex: -1,
      message: `The configured content area is ${Math.round(contentWidth)} by ${Math.round(contentHeight)} points.`,
      remediation:
        "Reduce margins or select a larger paper size before printing.",
      severity: "warning",
    });
  }

  for (const [itemIndex, item] of document.outline.entries()) {
    if (item.kind !== "recipe") continue;
    const recipe = item.recipe;
    if (
      recipe.layout === "merge-table" &&
      document.profile.pageSize === "half-letter"
    ) {
      diagnostics.push({
        code: "merge-table-half-letter",
        itemIndex,
        message:
          "The landscape merge table is too dense for dependable portrait Half-Letter binding and may paginate across multiple sheets.",
        recipeId: recipe.id,
        remediation:
          "Use Letter or A4 landscape, reduce the base font size, or switch this recipe to the step-linked layout.",
        severity: "warning",
      });
    }
    const estimatedLines =
      recipe.ingredients.length + recipe.steps.length * 2 + 7;
    const lineCapacity = Math.max(
      1,
      Math.floor(contentHeight / (document.profile.baseFontSizePt * 1.35)),
    );
    if (
      estimatedLines >
      lineCapacity * (recipe.layout === "two-column" ? 2 : 1)
    ) {
      diagnostics.push({
        code: "content-paginates",
        itemIndex,
        message: `${recipe.title} is estimated to require continuation pages in the ${recipe.layout} layout.`,
        recipeId: recipe.id,
        remediation:
          "Use a smaller base font, larger paper, shorter metadata, or a more compact layout.",
        severity: "info",
      });
    }
    if (document.profile.includePhotos && recipe.heroImage) {
      const imageWidthInches = Math.min(contentWidth, 360) / 72;
      const effectiveDpi = recipe.heroImage.width / imageWidthInches;
      if (effectiveDpi < 150) {
        diagnostics.push({
          code: "image-resolution-low",
          itemIndex,
          message: `${recipe.title}'s hero image is approximately ${Math.round(effectiveDpi)} DPI at print size.`,
          recipeId: recipe.id,
          remediation:
            "Supply the print-resolution original or disable photos for this profile.",
          severity: "warning",
        });
      }
    }
  }
  return diagnostics;
}

function validateDocument(document: PrintRenderDocument): void {
  const profile = document.profile;
  const margins = [
    profile.marginTopPt,
    profile.marginRightPt,
    profile.marginBottomPt,
    profile.marginLeftPt,
  ];
  if (!document.title.trim())
    throw new Error("Print documents require a title.");
  if (
    !Number.isFinite(profile.baseFontSizePt) ||
    profile.baseFontSizePt < 6 ||
    profile.baseFontSizePt > 24
  )
    throw new Error("Base font size must be between 6 and 24 points.");
  if (
    margins.some(
      (margin) => !Number.isFinite(margin) || margin < 0 || margin > 180,
    )
  )
    throw new Error("Print margins must be between 0 and 180 points.");
  const size = PAGE_SIZES[profile.pageSize];
  if (
    profile.marginLeftPt + profile.marginRightPt >= size.width - 72 ||
    profile.marginTopPt + profile.marginBottomPt >= size.height - 72
  )
    throw new Error("Print margins leave no readable content area.");
}

function prepareRecipeBoundary(
  context: RenderContext,
  itemIndex: number,
  recipe: PrintRenderRecipe,
): void {
  const profile = context.document.profile;
  if (
    profile.duplex &&
    context.document.edition === "fixed" &&
    context.pdf.getPageCount() % 2 === 1
  )
    context.pdf.addPage(pageDimensions(profile, false));
  context.boundaries.push({
    itemIndex,
    pageIndex: context.pdf.getPageCount(),
    recipeId: recipe.id,
  });
}

function renderFrontMatter(
  context: RenderContext,
  item: Exclude<PrintRenderItem, { kind: "recipe" }>,
): void {
  const page = context.pdf.addPage(
    pageDimensions(context.document.profile, false),
  );
  const { width, height } = page.getSize();
  const profile = context.document.profile;
  const palette = context.palette;
  page.drawRectangle({
    color: palette.paper,
    height,
    width,
    x: 0,
    y: 0,
  });
  if (item.kind === "cover") {
    const bandHeight = profile.visualStyle === "minimal" ? 7 : 22;
    page.drawRectangle({
      color: palette.accent,
      height: bandHeight,
      width,
      x: 0,
      y: height - bandHeight,
    });
    page.drawText("FOUND & MADE COOKBOOK", {
      color: palette.muted,
      font: context.bold,
      size: 8,
      x: profile.marginLeftPt,
      y: height * 0.72,
    });
    const titleSize = Math.max(28, profile.baseFontSizePt * 3.3);
    const titleHeight = drawWrappedWithOptions(
      page,
      context.heading,
      item.title,
      profile.marginLeftPt,
      height * 0.65,
      width - profile.marginLeftPt - profile.marginRightPt,
      titleSize,
      1.08,
      palette.accent,
    );
    const subtitleY = height * 0.65 - titleHeight - 14;
    if (item.subtitle) {
      drawWrappedWithOptions(
        page,
        context.regular,
        item.subtitle,
        profile.marginLeftPt,
        subtitleY,
        width - profile.marginLeftPt - profile.marginRightPt,
        profile.baseFontSizePt * 1.15,
        1.4,
        palette.muted,
      );
    }
    page.drawLine({
      color: palette.accent,
      end: { x: width - profile.marginRightPt, y: profile.marginBottomPt + 42 },
      start: { x: profile.marginLeftPt, y: profile.marginBottomPt + 42 },
      thickness: 1.5,
    });
    page.drawText(
      context.document.edition === "fixed"
        ? "FIXED EDITION"
        : "MODULAR RECIPE COLLECTION",
      {
        color: palette.muted,
        font: context.bold,
        size: 7,
        x: profile.marginLeftPt,
        y: profile.marginBottomPt + 24,
      },
    );
    return;
  }
  page.drawText(item.kind === "notes" ? "KITCHEN NOTES" : "COOKBOOK SECTION", {
    color: palette.muted,
    font: context.bold,
    size: 8,
    x: profile.marginLeftPt,
    y: height - profile.marginTopPt - 8,
  });
  drawWrappedWithOptions(
    page,
    context.heading,
    item.title,
    profile.marginLeftPt,
    height - profile.marginTopPt - 42,
    width - profile.marginLeftPt - profile.marginRightPt,
    profile.baseFontSizePt * 2.4,
    1.1,
    palette.accent,
  );
  page.drawLine({
    color: palette.accent,
    end: {
      x: width - profile.marginRightPt,
      y: height - profile.marginTopPt - 82,
    },
    start: { x: profile.marginLeftPt, y: height - profile.marginTopPt - 82 },
    thickness: 1.5,
  });
  if (
    (item.kind === "divider" || item.kind === "section") &&
    item.description
  ) {
    const descriptionHeight = drawWrappedWithOptions(
      page,
      context.regular,
      item.description,
      profile.marginLeftPt,
      height - profile.marginTopPt - 108,
      width - profile.marginLeftPt - profile.marginRightPt,
      profile.baseFontSizePt,
      1.4,
      palette.text,
    );
    if (item.kind === "section" && item.entries?.length) {
      drawSectionContents(
        context,
        page,
        item,
        height - profile.marginTopPt - 108 - descriptionHeight - 22,
      );
    }
  } else if (item.kind === "section" && item.entries?.length) {
    drawSectionContents(
      context,
      page,
      item,
      height - profile.marginTopPt - 108,
    );
  }
  if (item.kind === "notes") {
    const start = height - profile.marginTopPt - 110;
    const spacing = Math.min(
      28,
      (start - profile.marginBottomPt) / Math.max(1, item.lineCount),
    );
    for (let line = 0; line < item.lineCount; line += 1) {
      const y = start - line * spacing;
      if (y < profile.marginBottomPt) break;
      page.drawLine({
        start: { x: profile.marginLeftPt, y },
        end: { x: width - profile.marginRightPt, y },
        thickness: 0.5,
        color: palette.faint,
      });
    }
  }
}

function drawSectionContents(
  context: RenderContext,
  firstPage: PDFPage,
  section: Extract<PrintRenderItem, { kind: "section" }>,
  firstY: number,
): void {
  const profile = context.document.profile;
  const fontSize = Math.max(9, profile.baseFontSizePt * 1.05);
  let page = firstPage;
  let y = firstY;

  function drawHeading(label: string): void {
    page.drawText(label, {
      color: context.palette.muted,
      font: context.bold,
      size: 7.5,
      x: profile.marginLeftPt,
      y,
    });
    y -= 22;
  }

  function continueSection(): void {
    page = context.pdf.addPage(pageDimensions(profile, false));
    const { width, height } = page.getSize();
    page.drawRectangle({
      color: context.palette.paper,
      height,
      width,
      x: 0,
      y: 0,
    });
    y = height - profile.marginTopPt;
    page.drawText("SECTION CONTINUED", {
      color: context.palette.muted,
      font: context.bold,
      size: 7.5,
      x: profile.marginLeftPt,
      y,
    });
    y -= 22;
    y -= drawWrappedWithOptions(
      page,
      context.heading,
      section.title,
      profile.marginLeftPt,
      y,
      width - profile.marginLeftPt - profile.marginRightPt,
      profile.baseFontSizePt * 1.7,
      1.08,
      context.palette.accent,
    );
    y -= 18;
    drawHeading("RECIPES IN THIS SECTION");
  }

  drawHeading("RECIPES IN THIS SECTION");
  for (const [index, title] of (section.entries ?? []).entries()) {
    const number = String(index + 1).padStart(2, "0");
    const textX = profile.marginLeftPt + 34;
    const textWidth = page.getWidth() - profile.marginRightPt - textX;
    const lines = wrapText(
      cleanText(title),
      context.regular,
      fontSize,
      textWidth,
    );
    const lineHeight = fontSize * 1.3;
    const rowHeight = Math.max(24, lines.length * lineHeight + 10);
    if (y - rowHeight < profile.marginBottomPt + 24) continueSection();
    page.drawText(number, {
      color: context.palette.accent,
      font: context.bold,
      size: fontSize * 0.82,
      x: profile.marginLeftPt,
      y,
    });
    for (const line of lines) {
      page.drawText(line, {
        color: context.palette.text,
        font: context.regular,
        size: fontSize,
        x: textX,
        y,
      });
      y -= lineHeight;
    }
    y -= 8;
    page.drawLine({
      color: context.palette.faint,
      end: { x: page.getWidth() - profile.marginRightPt, y: y + 3 },
      start: { x: profile.marginLeftPt, y: y + 3 },
      thickness: 0.35,
    });
    y -= 8;
  }
}

async function renderRecipe(
  context: RenderContext,
  recipe: PrintRenderRecipe,
): Promise<void> {
  const landscape = recipe.layout === "merge-table";
  const page = context.pdf.addPage(
    pageDimensions(context.document.profile, landscape),
  );
  const profile = context.document.profile;
  const { width, height } = page.getSize();
  const palette = context.palette;
  page.drawRectangle({ color: palette.paper, height, width, x: 0, y: 0 });
  let y = height - profile.marginTopPt;
  page.drawText("RECIPE", {
    color: palette.muted,
    font: context.bold,
    size: 7.5,
    x: profile.marginLeftPt,
    y: y - 7.5,
  });
  y -= 24;
  y -= drawWrappedWithOptions(
    page,
    context.heading,
    recipe.title,
    profile.marginLeftPt,
    y,
    width - profile.marginLeftPt - profile.marginRightPt,
    Math.max(19, profile.baseFontSizePt * 2.15),
    1.08,
    palette.accent,
  );
  y -= 9;
  const yieldLabel = cleanText(
    `${recipe.yieldText}  |  Scaled for ${recipe.targetServings}`,
  );
  const yieldWidth = context.bold.widthOfTextAtSize(yieldLabel, 8.5) + 18;
  page.drawRectangle({
    borderColor: palette.faint,
    borderWidth: 0.5,
    color: palette.accentSoft,
    height: 22,
    width: Math.min(
      yieldWidth,
      width - profile.marginLeftPt - profile.marginRightPt,
    ),
    x: profile.marginLeftPt,
    y: y - 16,
  });
  page.drawText(yieldLabel, {
    color: palette.text,
    font: context.bold,
    size: 8.5,
    x: profile.marginLeftPt + 9,
    y: y - 9,
  });
  y -= 34;

  if (profile.includePhotos && recipe.heroImage) {
    y = await drawHero(
      context,
      page,
      recipe,
      y,
      width - profile.marginLeftPt - profile.marginRightPt,
    );
  }
  if (profile.includeMetadata && recipe.metadata) {
    const metadata = Object.entries(recipe.metadata).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    const metadataText = metadata
      .map(([key, value]) => `${key}: ${value}`)
      .join("   |   ");
    y -= drawWrappedWithOptions(
      page,
      context.regular,
      metadataText,
      profile.marginLeftPt,
      y,
      width - profile.marginLeftPt - profile.marginRightPt,
      profile.baseFontSizePt * 0.78,
      1.25,
      palette.muted,
    );
    y -= 7;
  }
  page.drawLine({
    color: palette.faint,
    end: { x: width - profile.marginRightPt, y },
    start: { x: profile.marginLeftPt, y },
    thickness: 0.8,
  });
  y -= 16;

  const flow: TextFlow = {
    bottom: profile.marginBottomPt + 18,
    context,
    fontSize: profile.baseFontSizePt,
    landscape,
    page,
    recipeTitle: recipe.title,
    width: width - profile.marginLeftPt - profile.marginRightPt,
    x: profile.marginLeftPt,
    y,
  };
  switch (recipe.layout) {
    case "compact-card":
      renderCompact(flow, recipe);
      break;
    case "classic":
      renderClassic(flow, recipe);
      break;
    case "two-column":
      renderTwoColumn(flow, recipe);
      break;
    case "step-linked":
      renderStepLinked(flow, recipe);
      break;
    case "merge-table":
      renderMergeTable(flow, recipe);
      break;
  }
}

async function drawHero(
  context: RenderContext,
  page: PDFPage,
  recipe: PrintRenderRecipe,
  y: number,
  maxWidth: number,
): Promise<number> {
  const source = recipe.heroImage;
  if (!source) return y;
  const fitted = fitImageDimensions(source, maxWidth, 205);
  if (context.planOnly) return y - fitted.height - 16;
  const imageBytes =
    context.document.profile.colorMode === "black-and-white"
      ? await sharp(source.bytes).grayscale().jpeg({ quality: 88 }).toBuffer()
      : source.bytes;
  const image =
    context.document.profile.colorMode !== "black-and-white" &&
    source.mimeType === "image/png"
      ? await context.pdf.embedPng(imageBytes)
      : await context.pdf.embedJpg(imageBytes);
  page.drawImage(image, {
    height: fitted.height,
    width: fitted.width,
    x:
      context.document.profile.marginLeftPt +
      Math.max(0, (maxWidth - fitted.width) / 2),
    y: y - fitted.height,
  });
  return y - fitted.height - 16;
}

function fitImageDimensions(
  image: Pick<PrintRenderHeroImage, "height" | "width">,
  maxWidth: number,
  maxHeight: number,
): { height: number; width: number } {
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
  return { height: image.height * scale, width: image.width * scale };
}

function renderClassic(flow: TextFlow, recipe: PrintRenderRecipe): void {
  heading(flow, "Ingredients");
  for (const ingredient of recipe.ingredients) ingredientLine(flow, ingredient);
  heading(flow, "Method");
  recipe.steps.forEach((step, index) =>
    numberedStep(flow, index + 1, step.instruction),
  );
}

function renderCompact(flow: TextFlow, recipe: PrintRenderRecipe): void {
  flow.fontSize *= 0.88;
  heading(flow, "Ingredients / Method");
  for (const ingredient of recipe.ingredients) ingredientLine(flow, ingredient);
  recipe.steps.forEach((step, index) =>
    numberedStep(flow, index + 1, step.instruction, 1.16),
  );
}

function renderTwoColumn(flow: TextFlow, recipe: PrintRenderRecipe): void {
  const gutter = 18;
  const columnWidth = (flow.width - gutter) / 2;
  const top = flow.y;
  const left: TextFlow = { ...flow, width: columnWidth };
  heading(left, "Ingredients");
  for (const ingredient of recipe.ingredients) ingredientLine(left, ingredient);
  const right: TextFlow = {
    ...flow,
    width: columnWidth,
    x: flow.x + columnWidth + gutter,
    y: top,
  };
  heading(right, "Method");
  recipe.steps.forEach((step, index) =>
    numberedStep(right, index + 1, step.instruction),
  );
  flow.page.drawLine({
    start: { x: flow.x + columnWidth + gutter / 2, y: flow.bottom },
    end: { x: flow.x + columnWidth + gutter / 2, y: top },
    thickness: 0.5,
    color: flow.context.palette.faint,
  });
}

function renderStepLinked(flow: TextFlow, recipe: PrintRenderRecipe): void {
  const ingredientById = new Map(
    recipe.ingredients.map((ingredient) => [ingredient.id, ingredient]),
  );
  heading(flow, "Step-linked method");
  recipe.steps.forEach((step, index) => {
    numberedStep(flow, index + 1, step.instruction);
    const linked = step.linkedIngredientIds.flatMap((id) => {
      const ingredient = ingredientById.get(id);
      return ingredient
        ? [`${ingredient.displayQuantity} ${ingredient.name}`]
        : [];
    });
    if (linked.length > 0)
      paragraph(flow, `Uses: ${linked.join("; ")}`, 1.15, true);
  });
}

function renderMergeTable(flow: TextFlow, recipe: PrintRenderRecipe): void {
  heading(flow, "Ingredient flow");
  const steps = recipe.steps;
  const ingredientWidth = Math.max(110, flow.width * 0.34);
  const stepWidth = Math.max(
    42,
    (flow.width - ingredientWidth) / Math.max(1, steps.length),
  );
  ensureSpace(flow, flow.fontSize * 3);
  flow.page.drawText("Ingredient", {
    font: flow.context.bold,
    size: flow.fontSize * 0.82,
    x: flow.x,
    y: flow.y,
  });
  steps.forEach((_, index) =>
    flow.page.drawText(`Step ${index + 1}`, {
      font: flow.context.bold,
      size: flow.fontSize * 0.72,
      x: flow.x + ingredientWidth + index * stepWidth,
      y: flow.y,
    }),
  );
  flow.y -= flow.fontSize * 1.5;
  for (const ingredient of recipe.ingredients) {
    ensureSpace(flow, flow.fontSize * 1.6);
    const label = `${ingredient.displayQuantity} ${ingredient.name}`;
    flow.page.drawText(
      truncate(
        label,
        flow.context.regular,
        flow.fontSize * 0.78,
        ingredientWidth - 5,
      ),
      {
        font: flow.context.regular,
        size: flow.fontSize * 0.78,
        x: flow.x,
        y: flow.y,
      },
    );
    steps.forEach((step, index) => {
      if (
        ingredient.stepIds.includes(step.id) ||
        step.linkedIngredientIds.includes(ingredient.id)
      )
        flow.page.drawText("X", {
          font: flow.context.bold,
          size: flow.fontSize * 0.8,
          x: flow.x + ingredientWidth + index * stepWidth + 6,
          y: flow.y,
        });
    });
    flow.page.drawLine({
      start: { x: flow.x, y: flow.y - 3 },
      end: { x: flow.x + flow.width, y: flow.y - 3 },
      thickness: 0.35,
      color: flow.context.palette.faint,
    });
    flow.y -= flow.fontSize * 1.45;
  }
  heading(flow, "Step key");
  steps.forEach((step, index) =>
    numberedStep(flow, index + 1, step.instruction, 1.2),
  );
}

function ingredientLine(
  flow: TextFlow,
  ingredient: PrintRenderIngredient,
): void {
  const marker = ingredient.requirement === "optional" ? " (optional)" : "";
  ensureSpace(flow, flow.fontSize * 1.4);
  flow.page.drawCircle({
    color: flow.context.palette.accent,
    size: 2,
    x: flow.x + 3,
    y: flow.y + flow.fontSize * 0.3,
  });
  const indented = { ...flow, width: flow.width - 12, x: flow.x + 12 };
  paragraph(
    indented,
    `${ingredient.displayQuantity} ${ingredient.name}${marker}`,
    1.3,
  );
  flow.page = indented.page;
  flow.y = indented.y;
  if (ingredient.guidance) paragraph(indented, ingredient.guidance, 1.12, true);
  flow.page = indented.page;
  flow.y = indented.y;
}

function numberedStep(
  flow: TextFlow,
  number: number,
  text: string,
  lineHeight = 1.38,
): void {
  ensureSpace(flow, flow.fontSize * 1.6);
  const markerSize = flow.fontSize * 1.45;
  flow.page.drawCircle({
    borderColor: flow.context.palette.accent,
    borderWidth: 0.8,
    color: flow.context.palette.accentSoft,
    size: markerSize / 2,
    x: flow.x + markerSize / 2,
    y: flow.y + flow.fontSize * 0.2,
  });
  const numberLabel = String(number);
  const numberWidth = flow.context.bold.widthOfTextAtSize(
    numberLabel,
    flow.fontSize * 0.74,
  );
  flow.page.drawText(numberLabel, {
    color: flow.context.palette.accent,
    font: flow.context.bold,
    size: flow.fontSize * 0.74,
    x: flow.x + markerSize / 2 - numberWidth / 2,
    y: flow.y - flow.fontSize * 0.06,
  });
  const indented = {
    ...flow,
    width: flow.width - markerSize - 9,
    x: flow.x + markerSize + 9,
  };
  paragraph(indented, text, lineHeight);
  flow.page = indented.page;
  flow.y = indented.y - flow.fontSize * 0.22;
}

function heading(flow: TextFlow, text: string): void {
  ensureSpace(flow, flow.fontSize * 2.1);
  flow.page.drawText(cleanText(text), {
    color: flow.context.palette.accent,
    font: flow.context.heading,
    size: flow.fontSize * 1.28,
    x: flow.x,
    y: flow.y,
  });
  flow.y -= flow.fontSize * 1.7;
}

function paragraph(
  flow: TextFlow,
  text: string,
  lineHeight = 1.35,
  muted = false,
): void {
  const lines = wrapText(
    cleanText(text),
    flow.context.regular,
    flow.fontSize,
    flow.width,
  );
  for (const line of lines) {
    ensureSpace(flow, flow.fontSize * lineHeight);
    flow.page.drawText(line, {
      color: muted ? flow.context.palette.muted : flow.context.palette.text,
      font: flow.context.regular,
      size: flow.fontSize,
      x: flow.x,
      y: flow.y,
    });
    flow.y -= flow.fontSize * lineHeight;
  }
}

function ensureSpace(flow: TextFlow, required: number): void {
  if (flow.y - required >= flow.bottom) return;
  flow.page = flow.context.pdf.addPage(
    pageDimensions(flow.context.document.profile, flow.landscape),
  );
  const { height } = flow.page.getSize();
  flow.y = height - flow.context.document.profile.marginTopPt;
  flow.page.drawText("Recipe continued", {
    color: flow.context.palette.muted,
    font: flow.context.bold,
    size: flow.fontSize * 0.75,
    x: flow.x,
    y: flow.y,
  });
  flow.y -= flow.fontSize * 1.4;
  flow.y -= drawWrappedWithOptions(
    flow.page,
    flow.context.heading,
    flow.recipeTitle,
    flow.x,
    flow.y,
    flow.width,
    flow.fontSize * 1.35,
    1.1,
    flow.context.palette.accent,
  );
  flow.y -= flow.fontSize;
}

function addPageNumbers(context: RenderContext): void {
  const pages = context.pdf.getPages();
  for (const [index, page] of pages.entries()) {
    const profile = context.document.profile;
    page.drawLine({
      color: context.palette.faint,
      end: { x: page.getWidth() - profile.marginRightPt, y: 25 },
      start: { x: profile.marginLeftPt, y: 25 },
      thickness: 0.45,
    });
    page.drawText(
      truncate(cleanText(context.document.title), context.regular, 7, 180),
      {
        color: context.palette.muted,
        font: context.regular,
        size: 7,
        x: profile.marginLeftPt,
        y: 12,
      },
    );
    if (
      context.document.edition !== "fixed" ||
      !context.document.profile.numbering
    )
      continue;
    const label = String(index + 1);
    const width = context.regular.widthOfTextAtSize(label, 8);
    page.drawText(label, {
      color: context.palette.muted,
      font: context.regular,
      size: 8,
      x: page.getWidth() - profile.marginRightPt - width,
      y: 12,
    });
  }
}

function pageDimensions(
  profile: PrintRenderProfile,
  landscape: boolean,
): [number, number] {
  const size = PAGE_SIZES[profile.pageSize];
  return landscape ? [size.height, size.width] : [size.width, size.height];
}

function drawWrappedWithOptions(
  page: PDFPage,
  font: PDFFont,
  text: string,
  x: number,
  y: number,
  width: number,
  size: number,
  lineHeight: number,
  color: PrintPalette["text"],
): number {
  const lines = wrapText(cleanText(text), font, size, width);
  lines.forEach((line, index) =>
    page.drawText(line, {
      color,
      font,
      size,
      x,
      y: y - index * size * lineHeight,
    }),
  );
  return lines.length * size * lineHeight;
}

function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = truncate(word, font, size, maxWidth);
  }
  if (line) lines.push(line);
  return lines;
}

function truncate(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let result = text;
  while (
    result.length > 1 &&
    font.widthOfTextAtSize(`${result}...`, size) > maxWidth
  )
    result = result.slice(0, -1);
  return `${result}...`;
}

function cleanText(value: string): string {
  return value
    .replace(/\u00bc/g, "1/4")
    .replace(/\u2153/g, "1/3")
    .replace(/\u215b/g, "1/8")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(
      /[\u00bc\u2153\u215b]/g,
      (value) => ({ "¼": "1/4", "⅓": "1/3", "⅛": "1/8" })[value] ?? value,
    )
    .replace(/[^\x20-\x7e]/g, "?");
}
