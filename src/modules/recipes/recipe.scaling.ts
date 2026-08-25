import type {
  IngredientQuantity,
  ProjectedIngredient,
  QuantityRange,
  Rational,
  RecipeIngredient,
} from "./recipe.types";

export type UnitPreference = "as-written" | "metric";

const fractionGlyphs = new Map<string, string>([
  ["1/8", "⅛"],
  ["1/4", "¼"],
  ["1/3", "⅓"],
  ["3/8", "⅜"],
  ["1/2", "½"],
  ["5/8", "⅝"],
  ["2/3", "⅔"],
  ["3/4", "¾"],
  ["7/8", "⅞"],
]);

export function rational(numerator: number, denominator = 1): Rational {
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    denominator === 0
  ) {
    throw new Error("Rational values require safe integer parts");
  }

  const sign = denominator < 0 ? -1 : 1;
  const divisor = greatestCommonDivisor(
    Math.abs(numerator),
    Math.abs(denominator),
  );
  return {
    denominator: Math.abs(denominator) / divisor,
    numerator: (numerator * sign) / divisor,
  };
}

export function rationalFromNumber(value: number): Rational {
  if (!Number.isFinite(value)) throw new Error("Quantity must be finite");
  if (Number.isSafeInteger(value)) return rational(value);

  const text = value.toString();
  if (text.includes("e")) {
    const fixed = value.toFixed(8).replace(/0+$/, "");
    return rationalFromDecimalText(fixed);
  }
  return rationalFromDecimalText(text);
}

export function multiplyRational(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.numerator,
    left.denominator * right.denominator,
  );
}

export function divideRational(left: Rational, right: Rational): Rational {
  if (right.numerator === 0) throw new Error("Cannot divide by zero");
  return rational(
    left.numerator * right.denominator,
    left.denominator * right.numerator,
  );
}

export function rationalToNumber(value: Rational): number {
  return value.numerator / value.denominator;
}

export function scaleQuantityRange(
  quantity: QuantityRange,
  factor: Rational,
): QuantityRange {
  return {
    from: multiplyRational(quantity.from, factor),
    ...(quantity.to ? { to: multiplyRational(quantity.to, factor) } : {}),
  };
}

export function projectIngredient(
  ingredient: RecipeIngredient,
  factor: Rational,
  unitPreference: UnitPreference,
): ProjectedIngredient {
  if (!ingredient.quantity.asWritten) {
    const text = ingredient.quantity.text?.trim() || "as needed";
    return {
      ...(ingredient.alternativeGroupId
        ? { alternativeGroupId: ingredient.alternativeGroupId }
        : {}),
      componentId: ingredient.componentId,
      displayQuantity: text,
      id: ingredient.id,
      name: ingredient.name,
      originalDisplayQuantity: text,
      requirement: ingredient.requirement,
      sourceText: ingredient.sourceText,
      stepIds: [...ingredient.stepIds],
      substitutions: ingredient.substitutions.map((substitution) => ({
        ...substitution,
      })),
      unit: ingredient.quantity.unit,
    };
  }
  const selected = selectQuantity(ingredient.quantity, unitPreference);
  const shouldScale = ingredient.quantity.scaling === "proportional";
  const projected = shouldScale
    ? scaleQuantityRange(selected.quantity, factor)
    : selected.quantity;
  const originalDisplayQuantity = formatQuantityRange(
    selected.quantity,
    selected.unit,
    unitPreference,
  );
  const displayQuantity = formatQuantityRange(
    projected,
    selected.unit,
    unitPreference,
  );
  const guidance = getQuantityGuidance(ingredient.quantity, projected, factor);

  return {
    ...(ingredient.alternativeGroupId
      ? { alternativeGroupId: ingredient.alternativeGroupId }
      : {}),
    componentId: ingredient.componentId,
    displayQuantity,
    ...(guidance ? { guidance } : {}),
    id: ingredient.id,
    name: ingredient.name,
    originalDisplayQuantity,
    quantity: projected,
    requirement: ingredient.requirement,
    sourceText: ingredient.sourceText,
    stepIds: [...ingredient.stepIds],
    substitutions: ingredient.substitutions.map((substitution) => ({
      ...substitution,
    })),
    unit: selected.unit,
  };
}

export function formatQuantityRange(
  quantity: QuantityRange,
  unit: string,
  unitPreference: UnitPreference,
): string {
  const formatter =
    unitPreference === "metric" ? formatMetricQuantity : formatKitchenQuantity;
  const from = formatter(quantity.from);
  const value = quantity.to ? `${from}–${formatter(quantity.to)}` : from;
  return unit ? `${value} ${unit}` : value;
}

export function formatKitchenQuantity(value: Rational): string {
  const numeric = rationalToNumber(value);
  const sign = numeric < 0 ? "−" : "";
  const absolute = Math.abs(numeric);
  const whole = Math.floor(absolute);
  const fraction = absolute - whole;

  if (fraction < 1 / 48) return `${sign}${whole}`;

  const candidates = [
    rational(1, 8),
    rational(1, 4),
    rational(1, 3),
    rational(3, 8),
    rational(1, 2),
    rational(5, 8),
    rational(2, 3),
    rational(3, 4),
    rational(7, 8),
    rational(1),
  ];
  const closest = candidates.reduce((best, candidate) =>
    Math.abs(rationalToNumber(candidate) - fraction) <
    Math.abs(rationalToNumber(best) - fraction)
      ? candidate
      : best,
  );

  if (closest.numerator === closest.denominator) return `${sign}${whole + 1}`;

  const key = `${closest.numerator}/${closest.denominator}`;
  const rendered =
    fractionGlyphs.get(key) ?? `${closest.numerator}/${closest.denominator}`;
  return `${sign}${whole > 0 ? whole : ""}${rendered}`;
}

export function formatMetricQuantity(value: Rational): string {
  const numeric = rationalToNumber(value);
  const absolute = Math.abs(numeric);
  const rounded =
    absolute > 100
      ? Math.round(numeric / 10) * 10
      : absolute > 20
        ? Math.round(numeric / 5) * 5
        : Math.round(numeric * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1);
}

function selectQuantity(
  quantity: IngredientQuantity,
  unitPreference: UnitPreference,
): { quantity: QuantityRange; unit: string } {
  if (unitPreference === "metric" && quantity.metricEquivalent) {
    return {
      quantity: quantity.metricEquivalent.quantity,
      unit: quantity.metricEquivalent.unit,
    };
  }
  if (!quantity.asWritten)
    throw new Error("Numeric quantity is unavailable for this ingredient");
  return { quantity: quantity.asWritten, unit: quantity.unit };
}

function getQuantityGuidance(
  quantity: IngredientQuantity,
  projected: QuantityRange,
  factor: Rational,
): string | undefined {
  if (quantity.kind === "package" || quantity.scaling === "invariant") {
    if (factor.numerator !== factor.denominator)
      return "Package counts do not scale automatically; adjust using the author's guidance.";
    return undefined;
  }

  if (
    quantity.kind === "count" &&
    (!isWhole(projected.from) || (projected.to && !isWhole(projected.to)))
  ) {
    return "Use a practical whole count and adjust to taste; Found & Made never rounds silently.";
  }
  return undefined;
}

function isWhole(value: Rational): boolean {
  return value.numerator % value.denominator === 0;
}

function rationalFromDecimalText(text: string): Rational {
  const [whole = "0", decimal = ""] = text.split(".");
  const denominator = 10 ** decimal.length;
  const sign = whole.startsWith("-") ? -1 : 1;
  const absoluteWhole = Math.abs(Number(whole));
  return rational(
    sign * (absoluteWhole * denominator + Number(decimal || "0")),
    denominator,
  );
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a || 1;
}
