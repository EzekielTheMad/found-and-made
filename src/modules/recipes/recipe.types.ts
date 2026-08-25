export interface Rational {
  denominator: number;
  numerator: number;
}

export interface QuantityRange {
  from: Rational;
  to?: Rational;
}

export type IngredientRequirement = "alternative" | "optional" | "required";
export type QuantityKind = "count" | "measure" | "package";

export interface IngredientQuantity {
  asWritten?: QuantityRange;
  kind: QuantityKind;
  metricEquivalent?: {
    quantity: QuantityRange;
    unit: string;
  };
  scaling: "invariant" | "proportional";
  text?: string;
  unit: string;
}

export interface IngredientSubstitution {
  name: string;
  note: string;
}

export interface RecipeIngredient {
  alternativeGroupId?: string;
  componentId: string;
  id: string;
  name: string;
  quantity: IngredientQuantity;
  requirement: IngredientRequirement;
  sourceText: string;
  stepIds: string[];
  substitutions: IngredientSubstitution[];
}

export interface RecipeComponent {
  id: string;
  name: string;
  position: number;
}

export interface RecipeStep {
  action: string;
  componentId: string;
  equipmentIds: string[];
  id: string;
  instruction: string;
  packageGuidance?: string;
  panGuidance?: string;
  position: number;
  temperature?: string;
  time?: string;
}

export interface RecipeEquipment {
  id: string;
  name: string;
  required: boolean;
}

export interface ConfirmedClassification {
  confirmed: boolean;
  name: string;
}

export interface RecipeSource {
  canonicalUrl?: string;
  originalUrl?: string;
  originalWording?: string;
}

export interface RecipeSubRecipe {
  authoredYield: number;
  componentId: string;
  id: string;
  recipeId: string;
  requiredYield: number;
  stepIds: string[];
  title: string;
}

export interface RecipeAggregate {
  allergens: ConfirmedClassification[];
  baseYield: number;
  components: RecipeComponent[];
  createdAt: string;
  createdByUserId?: string;
  creatorName?: string;
  deletedAt?: string;
  diets: ConfirmedClassification[];
  equipment: RecipeEquipment[];
  fingerprint: string;
  id: string;
  ingredients: RecipeIngredient[];
  sharedNotes?: string;
  source: RecipeSource;
  steps: RecipeStep[];
  subRecipes: RecipeSubRecipe[];
  title: string;
  updatedAt: string;
  variantOfId?: string;
  version: number;
  yieldText: string;
}

export type RecipeDraft = Omit<
  RecipeAggregate,
  | "createdAt"
  | "createdByUserId"
  | "deletedAt"
  | "fingerprint"
  | "id"
  | "updatedAt"
  | "version"
> & {
  id?: string;
};

export interface RecipeSummary {
  baseYield: number;
  createdByUserId?: string;
  deletedAt?: string;
  id: string;
  title: string;
  updatedAt: string;
  variantOfId?: string;
  version: number;
  yieldText: string;
}

export interface ProjectedIngredient {
  alternativeGroupId?: string;
  componentId: string;
  displayQuantity: string;
  guidance?: string;
  id: string;
  name: string;
  originalDisplayQuantity: string;
  quantity?: QuantityRange;
  requirement: IngredientRequirement;
  sourceText: string;
  stepIds: string[];
  substitutions: IngredientSubstitution[];
  unit: string;
}

export interface ProjectedSubRecipe extends RecipeSubRecipe {
  displayRequiredYield: string;
  projectedRequiredYield: Rational;
}

export interface ClassicComponentProjection {
  id: string;
  ingredients: ProjectedIngredient[];
  name: string;
  steps: RecipeStep[];
}

export interface GuidedStepProjection extends RecipeStep {
  ingredients: ProjectedIngredient[];
}

export interface MergeGridCell {
  action: string;
  stepId: string;
}

export interface MergeGridRow {
  cells: MergeGridCell[];
  componentId: string;
  ingredient: ProjectedIngredient;
}

export interface RecipeProjection {
  baseYield: number;
  classic: ClassicComponentProjection[];
  equipment: RecipeEquipment[];
  factor: Rational;
  guided: GuidedStepProjection[];
  id: string;
  mergeGrid: {
    actions: string[];
    rows: MergeGridRow[];
  };
  subRecipes: ProjectedSubRecipe[];
  targetYield: number;
  title: string;
  version: number;
  yieldText: string;
}

export interface RecipeRevision {
  createdAt: string;
  id: string;
  reason: string;
  recipeId: string;
  snapshot: RecipeAggregate;
  version: number;
}

export interface DuplicateMatch {
  id: string;
  match: "fingerprint" | "source";
  title: string;
}

export class RecipeValidationError extends Error {
  readonly code = "recipe_validation";
}

export class RecipeConflictError extends Error {
  readonly code = "recipe_conflict";

  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Recipe version conflict: expected ${expectedVersion}, found ${actualVersion}`,
    );
  }
}

export class RecipeDuplicateError extends Error {
  readonly code = "recipe_duplicate";

  constructor(readonly matches: DuplicateMatch[]) {
    super("A recipe with the same source or fingerprint already exists");
  }
}

export class RecipeNotFoundError extends Error {
  readonly code = "recipe_not_found";

  constructor(readonly recipeId: string) {
    super(`Recipe ${recipeId} was not found`);
  }
}
