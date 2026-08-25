import type { UnitPreference } from "../recipes/recipe.scaling";
import type {
  RecipeAggregate,
  RecipeProjection,
} from "../recipes/recipe.types";
import type { MediaAsset, MediaVariant } from "../media/media.types";

export const RECIPE_EXPORT_SCHEMA = "found-made.recipe-export";
export const LIBRARY_EXPORT_SCHEMA = "found-made.library-export-manifest";
export const LIBRARY_STATE_SCHEMA = "found-made.library-state";
export const EXPORT_FORMAT_VERSION = 1 as const;

export interface ExportMediaVariantReference {
  readonly contentType: string;
  readonly path: string;
  readonly variant: MediaVariant;
}

export interface ExportMediaReference extends Omit<MediaAsset, "checksum"> {
  readonly originalChecksum: string;
  readonly variants: readonly ExportMediaVariantReference[];
}

export interface RecipeExportV1 {
  readonly exportedAt: string;
  readonly media: readonly ExportMediaReference[];
  readonly projection: RecipeProjection;
  readonly recipe: RecipeAggregate;
  readonly schema: typeof RECIPE_EXPORT_SCHEMA;
  readonly targetYield: number;
  readonly unitPreference: UnitPreference;
  readonly version: typeof EXPORT_FORMAT_VERSION;
}

export interface ExportFileDescriptor {
  readonly kind: "library" | "media" | "recipe";
  readonly path: string;
  readonly recipeId?: string;
  readonly sha256: string;
  readonly size: number;
}

export interface ExportRecipeManifestEntry {
  readonly mediaIds: readonly string[];
  readonly path: string;
  readonly recipeId: string;
}

export interface LibraryExportManifestV1 {
  readonly exportedAt: string;
  readonly files: readonly ExportFileDescriptor[];
  readonly libraryState: {
    readonly path: string;
    readonly recordCount: number;
  };
  readonly recipeCount: number;
  readonly recipes: readonly ExportRecipeManifestEntry[];
  readonly schema: typeof LIBRARY_EXPORT_SCHEMA;
  readonly version: typeof EXPORT_FORMAT_VERSION;
}

export interface LibraryStateV1 {
  readonly contributors: readonly {
    readonly id: string;
    readonly name: string;
    readonly role: string;
  }[];
  readonly exportedAt: string;
  readonly records: Readonly<
    Record<string, readonly Record<string, unknown>[]>
  >;
  readonly schema: typeof LIBRARY_STATE_SCHEMA;
  readonly settings: {
    readonly publicMode: boolean;
  };
  readonly version: typeof EXPORT_FORMAT_VERSION;
}

export interface RecipeJsonExportResult {
  readonly artifactName: string;
  readonly dto: RecipeExportV1;
  readonly sha256: string;
  readonly size: number;
}

export interface LibraryExportResult {
  readonly artifactName: string;
  readonly fileCount: number;
  readonly manifest: {
    readonly path: "manifest.json";
    readonly sha256: string;
    readonly size: number;
  };
}

export interface LibraryExportVerification {
  readonly errors: readonly string[];
  readonly filesVerified: number;
  readonly valid: boolean;
}
