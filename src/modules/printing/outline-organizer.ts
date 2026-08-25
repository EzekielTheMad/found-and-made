import type { PrintOutlineItem } from "./printing.types";

export type PrintOutlineArrangement =
  "category" | "recent" | "title-asc" | "title-desc";

export interface PrintOutlineRecipeMetadata {
  category?: {
    id: string;
    name: string;
    position: number;
  };
  recipeId: string;
  title: string;
  updatedAt: string;
}

export function arrangePrintOutline(
  outline: readonly PrintOutlineItem[],
  metadata: readonly PrintOutlineRecipeMetadata[],
  arrangement: PrintOutlineArrangement,
  createSectionId: () => string,
): PrintOutlineItem[] {
  const details = new Map(metadata.map((item) => [item.recipeId, item]));
  const recipes = outline.filter(
    (item): item is Extract<PrintOutlineItem, { type: "recipe" }> =>
      item.type === "recipe",
  );

  if (arrangement === "category") {
    const covers = outline.filter((item) => item.type === "cover");
    const extras = outline.filter(
      (item) => item.type === "divider" || item.type === "notes",
    );
    const groups = new Map<
      string,
      {
        name: string;
        position: number;
        recipes: typeof recipes;
      }
    >();

    for (const recipe of recipes) {
      const category = details.get(recipe.recipeId)?.category;
      const key = category?.id ?? "uncategorized";
      const group = groups.get(key) ?? {
        name: category?.name ?? "Other recipes",
        position: category?.position ?? Number.MAX_SAFE_INTEGER,
        recipes: [],
      };
      group.recipes.push(recipe);
      groups.set(key, group);
    }

    const groupedRecipes = [...groups.values()]
      .sort(
        (left, right) =>
          left.position - right.position ||
          left.name.localeCompare(right.name, undefined, {
            sensitivity: "base",
          }),
      )
      .flatMap((group) => [
        {
          id: createSectionId(),
          title: group.name,
          type: "section" as const,
        },
        ...sortRecipes(group.recipes, details, "title-asc"),
      ]);

    return [...covers, ...groupedRecipes, ...extras];
  }

  const sortedRecipes = sortRecipes(recipes, details, arrangement);
  let recipeIndex = 0;
  return outline.map((item) =>
    item.type === "recipe" ? sortedRecipes[recipeIndex++] : item,
  );
}

function sortRecipes(
  recipes: ReadonlyArray<Extract<PrintOutlineItem, { type: "recipe" }>>,
  details: ReadonlyMap<string, PrintOutlineRecipeMetadata>,
  arrangement: Exclude<PrintOutlineArrangement, "category">,
): Array<Extract<PrintOutlineItem, { type: "recipe" }>> {
  return [...recipes].sort((left, right) => {
    const leftDetails = details.get(left.recipeId);
    const rightDetails = details.get(right.recipeId);
    if (arrangement === "recent") {
      const dateOrder =
        Date.parse(rightDetails?.updatedAt ?? "") -
        Date.parse(leftDetails?.updatedAt ?? "");
      if (Number.isFinite(dateOrder) && dateOrder !== 0) return dateOrder;
    }
    const titleOrder = (leftDetails?.title ?? "").localeCompare(
      rightDetails?.title ?? "",
      undefined,
      { sensitivity: "base" },
    );
    return arrangement === "title-desc" ? -titleOrder : titleOrder;
  });
}
