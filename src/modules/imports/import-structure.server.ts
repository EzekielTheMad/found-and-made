import type { RecipeDraft } from "../recipes/recipe.types";
import { sanitizeRecipeCreator } from "../recipes/recipe-metadata";
import { canonicalizeSourceUrl } from "../recipes/recipe.validation";
import type {
  ExtractedImport,
  ImportModelProvider,
  MigrationFormat,
  StructuredIngredientCandidate,
  StructuredRecipeCandidate,
} from "./import.types";

export class ImportStructureService {
  public constructor(private readonly provider?: ImportModelProvider) {}

  public async structure(
    extracted: ExtractedImport,
  ): Promise<StructuredRecipeCandidate> {
    let candidate: StructuredRecipeCandidate;
    if (extracted.source.kind === "manual") {
      candidate = fromDraft(extracted.source.draft);
    } else if (extracted.source.kind === "migration_json") {
      candidate = fromMigration(
        extracted.source.format,
        extracted.source.payload,
      );
    } else if (this.provider && extracted.extractedText.trim()) {
      const providerCandidate = await this.provider.structure({
        source: extracted.source,
        sourceText: extracted.extractedText,
      });
      candidate = supplementMetadata(
        providerCandidate,
        extracted.extractedText,
      );
    } else {
      candidate =
        fromPublicRecipeMetadata(extracted.extractedText) ??
        supplementMetadata(
          structureText(extracted.extractedText),
          extracted.extractedText,
        );
    }
    return applyDefaultCreator(candidate, extracted.source.defaultCreatorName);
  }
}

/** Deterministic local fallback used when no external model is configured. */
export class DeterministicImportModelProvider implements ImportModelProvider {
  public readonly id = "deterministic-local";

  public structure(input: {
    sourceText: string;
  }): Promise<StructuredRecipeCandidate> {
    return Promise.resolve(structureText(input.sourceText));
  }
}

function fromDraft(draft: RecipeDraft): StructuredRecipeCandidate {
  const componentById = new Map(
    draft.components.map((component) => [component.id, component.name]),
  );
  const sourceUrl = recipeDraftSourceUrl(draft);
  return {
    baseYield: draft.baseYield,
    classificationHints: [draft.title],
    components: draft.components.map((component) => component.name),
    ...(draft.creatorName ? { creatorName: draft.creatorName } : {}),
    ingredients: draft.ingredients.map((ingredient) => ({
      component: componentById.get(ingredient.componentId),
      name: ingredient.name,
      quantityText: ingredient.quantity.text ?? ingredient.sourceText,
      sourceText: ingredient.sourceText,
    })),
    ...(sourceUrl ? { sourceUrl } : {}),
    steps: draft.steps.map((step) => step.instruction),
    title: draft.title,
    yieldText: draft.yieldText,
  };
}

function fromMigration(
  format: MigrationFormat,
  payload: unknown,
): StructuredRecipeCandidate {
  const record = asRecord(payload);
  if (format !== "tandoor") {
    const creatorName = recipeCreator(record);
    const sourceUrl = recipeSourceUrl(record);
    const ingredients = asList(
      firstDefined(
        record.recipeIngredient,
        record.recipeIngredients,
        record.recipe_ingredient,
        record.ingredients,
      ),
    ).map(toIngredientCandidate);
    const servings = positiveNumber(
      firstDefined(
        record.recipeServings,
        record.recipe_servings,
        record.recipe_yield_quantity,
        record.servings,
      ),
    );
    const yieldText =
      firstString(firstDefined(record.recipeYield, record.recipe_yield)) ||
      `${servings ?? 1} servings`;
    return {
      baseYield:
        servings ?? positiveNumber(yieldText.match(/\d+(?:\.\d+)?/)?.[0]) ?? 1,
      classificationHints: classificationHints(record),
      ...(creatorName ? { creatorName } : {}),
      ingredients,
      ...(sourceUrl ? { sourceUrl } : {}),
      steps: asList(
        firstDefined(
          record.recipeInstructions,
          record.recipe_instructions,
          record.instructions,
        ),
      ).flatMap(instructionText),
      title: stringValue(record.name ?? record.title) || "Imported recipe",
      yieldText,
    };
  }

  const recipeSteps = asArray(record.steps);
  const creatorName = recipeCreator(record);
  const sourceUrl = recipeSourceUrl(record);
  return {
    baseYield: positiveNumber(record.servings ?? record.working_time) ?? 1,
    classificationHints: classificationHints(record),
    ...(creatorName ? { creatorName } : {}),
    ingredients: [
      ...asArray(record.ingredients),
      ...recipeSteps.flatMap((step) => asArray(asRecord(step).ingredients)),
    ].map(toIngredientCandidate),
    ...(sourceUrl ? { sourceUrl } : {}),
    steps: recipeSteps.flatMap(instructionText),
    title: stringValue(record.name ?? record.title) || "Imported recipe",
    yieldText: `${positiveNumber(record.servings) ?? 1} servings`,
  };
}

function fromPublicRecipeMetadata(
  text: string,
): StructuredRecipeCandidate | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const recipe = findRecipeNode(parsed);
  if (!recipe) return null;
  const title = stringValue(recipe.name);
  if (!title) return null;
  const yieldText = firstString(recipe.recipeYield) || "1 serving";
  const baseYield = positiveNumber(yieldText.match(/\d+(?:\.\d+)?/)?.[0]) ?? 1;
  const creatorName = recipeCreator(recipe);
  const sourceUrl = recipeSourceUrl(recipe);
  return {
    baseYield,
    classificationHints: classificationHints(recipe),
    ...(creatorName ? { creatorName } : {}),
    ingredients: asArray(recipe.recipeIngredient).map(toIngredientCandidate),
    ...(sourceUrl ? { sourceUrl } : {}),
    steps: asArray(recipe.recipeInstructions).flatMap(instructionText),
    title,
    yieldText,
  };
}

function findRecipeNode(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecipeNode(item);
      if (found) return found;
    }
    return null;
  }
  const record = asRecord(value);
  const types = Array.isArray(record["@type"])
    ? record["@type"]
    : [record["@type"]];
  if (types.some((type) => type === "Recipe")) return record;
  return findRecipeNode(record["@graph"]);
}

function structureText(text: string): StructuredRecipeCandidate {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return {
      baseYield: 1,
      classificationHints: [],
      ingredients: [],
      steps: [],
      title: "Imported recipe",
      yieldText: "1 serving",
    };
  }

  const title = lines[0] ?? "Imported recipe";
  const yieldLine = lines.find((line) =>
    /\b(serves?|servings?|yield)\b/i.test(line),
  );
  const baseYield = Number(yieldLine?.match(/\d+(?:\.\d+)?/)?.[0] ?? 1);
  const ingredients: StructuredIngredientCandidate[] = [];
  const steps: string[] = [];
  let section: "ingredients" | "steps" | null = null;

  for (const line of lines.slice(1)) {
    if (/^ingredients?\s*:?$/i.test(line)) {
      section = "ingredients";
      continue;
    }
    if (/^(instructions?|directions?|method|steps?)\s*:?$/i.test(line)) {
      section = "steps";
      continue;
    }
    if (line === yieldLine) continue;
    const cleaned = line
      .replace(/^[-*]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .trim();
    if (!cleaned) continue;
    if (
      section === "ingredients" ||
      (!section && looksLikeIngredient(cleaned))
    ) {
      ingredients.push(toIngredientCandidate(cleaned));
    } else if (section === "steps") {
      steps.push(cleaned);
    }
  }

  return {
    baseYield: Number.isFinite(baseYield) && baseYield > 0 ? baseYield : 1,
    classificationHints: [title],
    ingredients,
    steps,
    title,
    yieldText: yieldLine ?? `${baseYield || 1} servings`,
  };
}

function toIngredientCandidate(value: unknown): StructuredIngredientCandidate {
  if (typeof value === "string") {
    const { name, quantityText } = splitIngredient(value);
    return { name, quantityText, sourceText: value };
  }
  const item = asRecord(value);
  const food = asRecord(item.food);
  const name =
    stringValue(item.name ?? food.name ?? item.ingredient ?? item.note) ||
    "Ingredient to review";
  const quantityText = [
    firstDefined(item.amount, item.quantity),
    asRecord(item.unit).name ?? item.unit,
  ]
    .map(stringValue)
    .filter(Boolean)
    .join(" ");
  const sourceText =
    stringValue(item.original_text ?? item.display ?? item.note) ||
    [quantityText, name].filter(Boolean).join(" ");
  return { name, quantityText, sourceText };
}

function splitIngredient(sourceText: string): {
  name: string;
  quantityText: string;
} {
  const match = sourceText.match(
    /^((?:\d+\s+)?(?:\d+\/\d+|\d+(?:\.\d+)?)?(?:\s*(?:cups?|tbsp|tsp|teaspoons?|tablespoons?|g|kg|oz|lb|ml|l|packages?|cans?))?)\s+(.+)$/i,
  );
  if (!match) return { name: sourceText, quantityText: "as needed" };
  return {
    name: match[2]?.replace(/^of\s+/i, "") ?? sourceText,
    quantityText: match[1]?.trim() || "as needed",
  };
}

function looksLikeIngredient(value: string): boolean {
  return /^(?:\d|\d+\/\d+|one\b|two\b|a\s)/i.test(value);
}

function instructionText(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  const record = asRecord(value);
  const nested = asList(
    firstDefined(record.itemListElement, record.steps),
  ).flatMap(instructionText);
  if (nested.length > 0) return nested;
  const text = stringValue(
    record.text ?? record.instruction ?? record.note ?? record.name,
  );
  return text ? [text] : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function positiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function firstString(value: unknown): string {
  if (Array.isArray(value)) {
    const first = value.find(
      (item): item is string => typeof item === "string",
    );
    return first?.trim() ?? "";
  }
  return stringValue(value);
}

function classificationHints(record: Record<string, unknown>): string[] {
  const raw = [
    record.recipeCategory,
    record.recipe_category,
    record.category,
    record.categories,
    record.keywords,
    record.tags,
  ];
  const hints = raw.flatMap(hintStrings);
  return [...new Set(hints.map((hint) => hint.trim()).filter(Boolean))].slice(
    0,
    40,
  );
}

function recipeCreator(record: Record<string, unknown>): string {
  const values = [
    record.author,
    record.recipeAuthor,
    record.recipe_author,
    record.creator,
  ];
  for (const value of values) {
    const creator = Array.isArray(value)
      ? value.map(personName).filter(Boolean).join(", ")
      : typeof value === "string"
        ? value
        : personName(value);
    const sanitized = sanitizeRecipeCreator(creator);
    if (sanitized) return sanitized;
  }
  return "";
}

function recipeSourceUrl(record: Record<string, unknown>): string {
  const mainEntity = asRecord(record.mainEntityOfPage);
  for (const value of [
    record.url,
    record.sourceUrl,
    record.source_url,
    record.orgURL,
    record.org_url,
    record.originalUrl,
    record.original_url,
    record.canonicalUrl,
    record.canonical_url,
    mainEntity["@id"],
    mainEntity.url,
  ]) {
    const url = safeHttpUrl(value);
    if (url) return url;
  }
  return "";
}

function recipeDraftSourceUrl(draft: RecipeDraft): string {
  return safeHttpUrl(draft.source.canonicalUrl ?? draft.source.originalUrl);
}

function supplementMetadata(
  candidate: StructuredRecipeCandidate,
  sourceText: string,
): StructuredRecipeCandidate {
  const embedded = fromPublicRecipeMetadata(sourceText);
  const creatorName =
    sanitizeRecipeCreator(candidate.creatorName) ||
    sanitizeRecipeCreator(embedded?.creatorName) ||
    creatorFromText(sourceText);
  const sourceUrl =
    safeHttpUrl(candidate.sourceUrl) ||
    safeHttpUrl(embedded?.sourceUrl) ||
    sourceUrlFromText(sourceText);
  const classificationHints = [
    ...(candidate.classificationHints ?? []),
    ...(embedded?.classificationHints ?? []),
  ];
  return {
    ...candidate,
    ...(creatorName ? { creatorName } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(classificationHints.length > 0
      ? { classificationHints: [...new Set(classificationHints)].slice(0, 40) }
      : {}),
  };
}

function applyDefaultCreator(
  candidate: StructuredRecipeCandidate,
  defaultCreatorName?: string,
): StructuredRecipeCandidate {
  const creatorName =
    sanitizeRecipeCreator(candidate.creatorName) ||
    sanitizeRecipeCreator(defaultCreatorName);
  return {
    ...candidate,
    ...(creatorName ? { creatorName } : {}),
  };
}

function creatorFromText(text: string): string {
  for (const line of metadataHeaderLines(text).slice(1)) {
    const labeled = line.match(
      /^(?:recipe\s+)?(?:author|creator)\s*[:-]\s*(.+)$/i,
    );
    if (labeled?.[1]) return sanitizeRecipeCreator(labeled[1]);
    const recipeBy = line.match(/^recipe\s+by\s+(.+)$/i);
    if (recipeBy?.[1] && plausibleCreator(recipeBy[1])) {
      return sanitizeRecipeCreator(recipeBy[1]);
    }
    const byline = line.match(/^by\s+(.+)$/i);
    if (byline?.[1] && plausibleCreator(byline[1])) {
      return sanitizeRecipeCreator(byline[1]);
    }
  }
  return "";
}

function sourceUrlFromText(text: string): string {
  for (const line of metadataHeaderLines(text)) {
    const match = line
      .trim()
      .match(
        /^(?:source|original(?:\s+recipe)?|recipe\s+url)\s*:\s*(https?:\/\/\S+)/i,
      );
    const url = safeHttpUrl(match?.[1]);
    if (url) return url;
  }
  return "";
}

function safeHttpUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    return canonicalizeSourceUrl(value) ?? "";
  } catch {
    return "";
  }
}

function metadataHeaderLines(text: string): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split(/\r?\n/).slice(0, 20)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (
      /^(?:ingredients?|instructions?|directions?|method|steps?)\s*:?$/i.test(
        line,
      )
    ) {
      break;
    }
    lines.push(line);
  }
  return lines;
}

function plausibleCreator(value: string): boolean {
  const creator = sanitizeRecipeCreator(value);
  if (!creator || creator.split(/\s+/).length > 10) return false;
  if (/[.!?;:]/.test(creator)) return false;
  return !/^(?:hand|mix|stir|cook|bake|whisk|combine)\b/i.test(creator);
}

function personName(value: unknown): string {
  const record = asRecord(value);
  return stringValue(
    record.name ??
      [record.givenName, record.familyName]
        .map(stringValue)
        .filter(Boolean)
        .join(" "),
  );
}

function hintStrings(value: unknown): string[] {
  if (typeof value === "string")
    return value.split(/[,;|]/).map((item) => item.trim());
  if (Array.isArray(value)) return value.flatMap(hintStrings);
  const record = asRecord(value);
  const hint = stringValue(record.name ?? record.label ?? record.title);
  return hint ? [hint] : [];
}
