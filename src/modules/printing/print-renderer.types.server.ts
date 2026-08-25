export type PrintLayout =
  "classic" | "compact-card" | "merge-table" | "step-linked" | "two-column";

export type PrintPageSize = "a4" | "half-letter" | "letter";

export interface PrintRenderProfile {
  readonly baseFontSizePt: number;
  readonly colorMode: "black-and-white" | "color";
  readonly duplex: boolean;
  readonly includeMetadata: boolean;
  readonly includePhotos: boolean;
  readonly marginBottomPt: number;
  readonly marginLeftPt: number;
  readonly marginRightPt: number;
  readonly marginTopPt: number;
  readonly numbering: boolean;
  readonly pageSize: PrintPageSize;
  readonly visualStyle: "heirloom" | "minimal" | "modern";
}

export interface PrintRenderHeroImage {
  readonly bytes: Uint8Array;
  readonly height: number;
  readonly mimeType: "image/jpeg" | "image/png";
  readonly width: number;
}

export interface PrintRenderIngredient {
  readonly displayQuantity: string;
  readonly guidance?: string;
  readonly id: string;
  readonly name: string;
  readonly requirement: string;
  readonly stepIds: readonly string[];
}

export interface PrintRenderStep {
  readonly id: string;
  readonly instruction: string;
  readonly linkedIngredientIds: readonly string[];
}

export interface PrintRenderRecipe {
  readonly heroImage?: PrintRenderHeroImage;
  readonly id: string;
  readonly ingredients: readonly PrintRenderIngredient[];
  readonly layout: PrintLayout;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly steps: readonly PrintRenderStep[];
  readonly targetServings: number;
  readonly title: string;
  readonly yieldText: string;
}

export type PrintRenderItem =
  | {
      readonly kind: "cover";
      readonly subtitle?: string;
      readonly title: string;
    }
  | {
      readonly description?: string;
      readonly kind: "divider";
      readonly title: string;
    }
  | {
      readonly description?: string;
      readonly entries?: readonly string[];
      readonly kind: "section";
      readonly title: string;
    }
  | {
      readonly kind: "notes";
      readonly lineCount: number;
      readonly title: string;
    }
  | {
      readonly kind: "recipe";
      readonly recipe: PrintRenderRecipe;
    };

export interface PrintRenderDocument {
  readonly edition: "fixed" | "modular";
  readonly outline: readonly PrintRenderItem[];
  readonly profile: PrintRenderProfile;
  readonly title: string;
}

export interface PrintFitDiagnostic {
  readonly code:
    | "content-paginates"
    | "image-resolution-low"
    | "merge-table-half-letter"
    | "narrow-content-area";
  readonly itemIndex: number;
  readonly message: string;
  readonly recipeId?: string;
  readonly remediation: string;
  readonly severity: "info" | "warning";
}

export interface PrintRecipePageBoundary {
  readonly itemIndex: number;
  readonly pageIndex: number;
  readonly recipeId: string;
}

export interface PrintOutlinePageSpan {
  readonly endPageIndex: number;
  readonly itemIndex: number;
  readonly kind: PrintRenderItem["kind"];
  readonly leadingBlankPages: number;
  readonly pageCount: number;
  readonly recipeId?: string;
  readonly startPageIndex: number;
}

export interface PrintPagePlan {
  readonly diagnostics: readonly PrintFitDiagnostic[];
  readonly outlinePageSpans: readonly PrintOutlinePageSpan[];
  readonly pageCount: number;
  readonly recipePageBoundaries: readonly PrintRecipePageBoundary[];
}

export interface PrintRenderResult extends PrintPagePlan {
  readonly bytes: Uint8Array;
}
