import { describe, expect, it } from "vitest";

import {
  arrangePrintOutline,
  type PrintOutlineRecipeMetadata,
} from "#src/modules/printing/outline-organizer";
import type { PrintOutlineItem } from "#src/modules/printing/printing.types";

const outline: PrintOutlineItem[] = [
  { id: "cover", title: "Family recipes", type: "cover" },
  { id: "old-section", title: "Recipes", type: "section" },
  { id: "zucchini", recipeId: "recipe-z", type: "recipe" },
  {
    id: "apple",
    layoutOverride: "step-linked",
    recipeId: "recipe-a",
    targetServings: 8,
    type: "recipe",
  },
  { heading: "Notes", id: "notes", lines: 12, type: "notes" },
];

const metadata: PrintOutlineRecipeMetadata[] = [
  {
    category: { id: "dinner", name: "Dinner", position: 3 },
    recipeId: "recipe-z",
    title: "Zucchini bake",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  {
    category: { id: "breakfast", name: "Breakfast", position: 1 },
    recipeId: "recipe-a",
    title: "Apple pancakes",
    updatedAt: "2026-08-10T00:00:00.000Z",
  },
];

describe("arrangePrintOutline", () => {
  it("alphabetizes recipe slots without disturbing structural pages", () => {
    const arranged = arrangePrintOutline(
      outline,
      metadata,
      "title-asc",
      () => "unused",
    );

    expect(arranged.map((item) => item.id)).toEqual([
      "cover",
      "old-section",
      "apple",
      "zucchini",
      "notes",
    ]);
    expect(arranged[2]).toMatchObject({
      layoutOverride: "step-linked",
      targetServings: 8,
    });
  });

  it("sorts recipe slots by most recently updated", () => {
    const arranged = arrangePrintOutline(
      outline,
      metadata,
      "recent",
      () => "unused",
    );

    expect(arranged.map((item) => item.id)).toEqual([
      "cover",
      "old-section",
      "apple",
      "zucchini",
      "notes",
    ]);
  });

  it("builds ordered category sections while retaining covers and extras", () => {
    let section = 0;
    const arranged = arrangePrintOutline(
      outline,
      metadata,
      "category",
      () => `section-${++section}`,
    );

    expect(arranged).toEqual([
      outline[0],
      { id: "section-1", title: "Breakfast", type: "section" },
      outline[3],
      { id: "section-2", title: "Dinner", type: "section" },
      outline[2],
      outline[4],
    ]);
  });
});
