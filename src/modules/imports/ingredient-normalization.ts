import type {
  BrandConfirmation,
  ImportWarning,
  StructuredIngredientCandidate,
} from "./import.types";

interface NormalizedIngredientName {
  confirmation?: Omit<BrandConfirmation, "ingredientId" | "sourceText">;
  name: string;
  warnings: ImportWarning[];
}

const sensitiveBrands: ReadonlyArray<{
  canonical: string;
  characteristics: string;
  pattern: RegExp;
}> = [
  {
    canonical: "complete baking mix",
    characteristics: "complete baking mix with its included fat and leavening",
    pattern: /\bbisquick\b/i,
  },
  {
    canonical: "processed cheese loaf",
    characteristics: "melt-stable processed cheese loaf",
    pattern: /\bvelveeta\b/i,
  },
  {
    canonical: "gelatin dessert mix",
    characteristics: "sweetened flavored gelatin dessert mix",
    pattern: /\bjell-?o\b/i,
  },
  {
    canonical: "diced tomatoes with green chiles",
    characteristics: "canned diced tomatoes with green chiles",
    pattern: /\bro[ -]?tel\b/i,
  },
  {
    canonical: "vegetable shortening",
    characteristics: "solid vegetable shortening",
    pattern: /\bcrisco\b/i,
  },
  {
    canonical: "frozen whipped topping",
    characteristics: "stabilized frozen whipped topping",
    pattern: /\bcool whip\b/i,
  },
  {
    canonical: "Chesapeake-style seasoning blend",
    characteristics: "celery-salt-forward Chesapeake-style seasoning blend",
    pattern: /\bold bay\b/i,
  },
];

const removableBrands = [
  "kraft",
  "heinz",
  "mccormick",
  "del monte",
  "goya",
  "nestle",
];

export function normalizeIngredientName(
  ingredient: StructuredIngredientCandidate,
): NormalizedIngredientName {
  const combined = `${ingredient.name} ${ingredient.sourceText}`;
  const knownSensitive = sensitiveBrands.find(({ pattern }) =>
    pattern.test(combined),
  );
  if (knownSensitive) {
    return {
      confirmation: {
        canonicalName: knownSensitive.canonical,
        meaningfulCharacteristics: knownSensitive.characteristics,
      },
      name: knownSensitive.canonical,
      warnings: [brandWarning(ingredient.sourceText)],
    };
  }

  if (ingredient.brand?.trim()) {
    const name = removeBrand(ingredient.name, ingredient.brand);
    if (ingredient.brandIdentitySensitive) {
      return {
        confirmation: {
          canonicalName: name,
          meaningfulCharacteristics: name,
        },
        name,
        warnings: [brandWarning(ingredient.sourceText)],
      };
    }
    return { name, warnings: [] };
  }

  let name = ingredient.name.trim();
  for (const brand of removableBrands) name = removeBrand(name, brand);
  return { name: name || ingredient.name.trim(), warnings: [] };
}

function removeBrand(name: string, brand: string): string {
  const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = name
    .replace(new RegExp(`\\b${escaped}(?:['’]s)?\\b`, "ig"), "")
    .replace(/\s+/g, " ")
    .replace(/^[,\s-]+|[,\s-]+$/g, "")
    .trim();
  return stripped || name.trim();
}

function brandWarning(sourceText: string): ImportWarning {
  return {
    code: "brand_sensitive",
    field: sourceText,
    message:
      "Removing this brand may change ingredient identity or cooking behavior. Confirm the generic name and meaningful characteristics.",
    severity: "warning",
  };
}
