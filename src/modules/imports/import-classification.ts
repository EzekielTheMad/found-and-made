import type {
  StandardImportTag,
  StructuredRecipeCandidate,
} from "./import.types";

const patterns: ReadonlyArray<{
  pattern: RegExp;
  tag: StandardImportTag;
}> = [
  {
    pattern:
      /\b(?:breakfast|brunch|pancakes?|waffles?|omelettes?|omelets?|french toast|granola|cereal)\b/,
    tag: "Breakfast",
  },
  { pattern: /\b(?:lunch|luncheon)\b/, tag: "Lunch" },
  {
    pattern:
      /\b(?:dinner|supper|main courses?|main dish(?:es)?|entrees?|entr[eé]es?)\b/,
    tag: "Dinner",
  },
  {
    pattern:
      /\b(?:appetizers?|appetisers?|hors d['’]?oeuvres?|starters?|canap[eé]s?)\b/,
    tag: "Appetizer",
  },
  { pattern: /\b(?:side dishes?|sides)\b/, tag: "Side Dish" },
  {
    pattern:
      /\b(?:desserts?|cakes?|cookies?|brownies?|pies?|ice cream|puddings?|tarts?|cupcakes?|cheesecakes?|sorbets?)\b/,
    tag: "Dessert",
  },
  { pattern: /\b(?:snacks?|trail mix)\b/, tag: "Snack" },
  { pattern: /\b(?:soups?|bisques?|chowders?)\b/, tag: "Soup" },
  { pattern: /\b(?:salads?)\b/, tag: "Salad" },
  {
    pattern:
      /\b(?:cocktails?|martinis?|margaritas?|mojitos?|sangrias?|daiquiris?|old fashioned|negronis?)\b/,
    tag: "Cocktails",
  },
  {
    pattern:
      /\b(?:drinks?|beverages?|mocktails?|smoothies?|lemonades?|coffee|tea|juice)\b/,
    tag: "Drinks",
  },
  {
    pattern:
      /\b(?:seasonal|holiday|christmas|thanksgiving|halloween|easter|valentine(?:'s)?|summer|winter|spring|fall|autumn)\b/,
    tag: "Seasonal",
  },
];

const MAX_STANDARD_TAGS_PER_RECIPE = 3;

export function inferStandardImportTags(
  candidate: StructuredRecipeCandidate,
): StandardImportTag[] {
  const searchable = [candidate.title, ...(candidate.classificationHints ?? [])]
    .join(" ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const tags = patterns
    .filter(({ pattern }) => pattern.test(searchable))
    .map(({ tag }) => tag);
  const unique = [...new Set(tags)];
  if (unique.includes("Cocktails")) {
    const drinks = unique.indexOf("Drinks");
    if (drinks >= 0) unique.splice(drinks, 1);
  }
  return unique.slice(0, MAX_STANDARD_TAGS_PER_RECIPE);
}
