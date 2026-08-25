import type { DuplicateMatch, RecipeDraft } from "../recipes/recipe.types";

export const MIGRATION_FORMATS = [
  "mealie",
  "tandoor",
  "nextcloud",
  "schema_org",
] as const;

export type MigrationFormat = (typeof MIGRATION_FORMATS)[number];

export const IMPORT_STAGES = [
  "acquire",
  "extract",
  "structure",
  "normalize",
  "map",
  "duplicate",
  "review",
] as const;

export type ImportStage = (typeof IMPORT_STAGES)[number];
export type ImportStatus =
  | "queued"
  | "processing"
  | "review"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

export const STANDARD_IMPORT_TAGS = [
  "Breakfast",
  "Lunch",
  "Dinner",
  "Appetizer",
  "Side Dish",
  "Dessert",
  "Snack",
  "Soup",
  "Salad",
  "Cocktails",
  "Drinks",
  "Seasonal",
] as const;

export type StandardImportTag = (typeof STANDARD_IMPORT_TAGS)[number];

interface ImportSourceDefaults {
  /** Used only when imported material does not identify a recipe creator. */
  defaultCreatorName?: string;
}

export type ImportSource = ImportSourceDefaults &
  (
    | {
        draft: RecipeDraft;
        kind: "manual";
        originalWording: string;
      }
    | { kind: "pasted_text"; text: string }
    | { kind: "website"; pastedText?: string; url: string }
    | {
        format: MigrationFormat;
        heroImage?: {
          fileName: string;
          mimeType: string;
          storageRef: string;
        };
        kind: "migration_json";
        originalWording?: string;
        payload: unknown;
      }
    | {
        fileName: string;
        kind: "image";
        mimeType: string;
        storageRef: string;
        userText?: string;
      }
    | {
        fileName: string;
        kind: "pdf";
        mimeType?: "application/pdf";
        storageRef: string;
        userText?: string;
      }
    | {
        fileName: string;
        kind: "audio_video";
        mediaType: "audio" | "video";
        mimeType?: string;
        storageRef: string;
        transcript?: string;
      }
    | {
        caption?: string;
        kind: "social_url";
        platform: "instagram" | "tiktok" | "youtube" | "other";
        url: string;
        userMediaRef?: string;
      }
  );

export interface ImportSession {
  createdAt: string;
  currentStage: ImportStage | null;
  id: string;
  jobId: string | null;
  progress: number;
  requestKey: string;
  requestedBy: string | null;
  resultingRecipeId: string | null;
  source: ImportSource;
  sourceKind: ImportSource["kind"];
  status: ImportStatus;
  updatedAt: string;
}

export interface ImportCheckpoint<T = unknown> {
  artifact: T;
  artifactHash: string;
  completedAt: string;
  id: string;
  sessionId: string;
  stage: ImportStage;
}

export interface ImportWarning {
  code:
    | "blocked_source"
    | "brand_sensitive"
    | "low_confidence"
    | "media_extraction_failed"
    | "missing_media_text"
    | "unmapped_ingredient";
  field?: string;
  message: string;
  severity: "info" | "warning";
}

export interface AcquiredImport {
  canonicalUrl?: string;
  fallback?: {
    acceptedInputs: readonly ("caption" | "media" | "pasted_text")[];
    message: string;
  };
  method:
    | "manual"
    | "user_material"
    | "official_metadata"
    | "public_page"
    | "blocked";
  heroImageUrl?: string;
  originalWording: string;
  source: ImportSource;
  text: string;
  warnings: ImportWarning[];
}

export interface ExtractedImport extends AcquiredImport {
  extractedText: string;
}

export interface StructuredIngredientCandidate {
  brand?: string;
  brandIdentitySensitive?: boolean;
  component?: string;
  confidence?: number;
  name: string;
  quantityText: string;
  sourceText: string;
}

export interface StructuredRecipeCandidate {
  baseYield: number;
  classificationHints?: string[];
  components?: string[];
  creatorName?: string;
  ingredients: StructuredIngredientCandidate[];
  sourceUrl?: string;
  steps: string[];
  title: string;
  yieldText: string;
}

export interface StructuredImport {
  acquired: AcquiredImport;
  candidate: StructuredRecipeCandidate;
  warnings: ImportWarning[];
}

export interface BrandConfirmation {
  canonicalName: string;
  ingredientId: string;
  meaningfulCharacteristics: string;
  sourceText: string;
}

export interface NormalizedImport {
  brandConfirmations: BrandConfirmation[];
  draft: RecipeDraft;
  fallback?: AcquiredImport["fallback"];
  standardizedTags: StandardImportTag[];
  warnings: ImportWarning[];
}

export interface IngredientStepMapping {
  ingredientId: string;
  stepIds: string[];
}

export interface RecipeDependencyCandidate {
  description: string;
  kind: "component" | "preparation";
  stepId: string;
}

export interface MappedImport extends NormalizedImport {
  dependencies: RecipeDependencyCandidate[];
  mappings: IngredientStepMapping[];
}

export interface DuplicateImport extends MappedImport {
  duplicateCandidates: DuplicateMatch[];
}

export interface ImportReviewPackage extends DuplicateImport {
  heroImage?: {
    fileName: string;
    mimeType: string;
    storageRef: string;
  };
  heroImageUrl?: string;
  mandatory: false;
  migrationFormat?: MigrationFormat;
  privacy: "private";
  publishRequested: false;
  sourceWording: string;
}

export interface ConfirmImportReviewInput {
  allowDuplicate?: boolean;
  confirmedBrandIngredientIds: readonly string[];
  draft: RecipeDraft;
}

export interface PublicContentAcquisitionRequest {
  preference: readonly ["official_metadata", "public_page"];
  url: string;
}

export type PublicContentAcquisitionResult =
  | {
      canonicalUrl?: string;
      heroImageUrl?: string;
      method: "official_metadata" | "public_page";
      text: string;
    }
  | { method: "blocked"; reason: string };

export type PublicImageAcquisitionResult =
  | { bytes: Uint8Array; mimeType: "image/jpeg" | "image/png" | "image/webp" }
  | { reason: string; status: "blocked" };

/**
 * This boundary intentionally has no cookie, session, or arbitrary header input.
 * An implementation must apply the shared SSRF-safe public fetch policy.
 */
export interface PublicContentAcquirer {
  acquire(
    request: PublicContentAcquisitionRequest,
  ): Promise<PublicContentAcquisitionResult>;
  acquireImage?(url: string): Promise<PublicImageAcquisitionResult>;
}

export interface ImportModelInput {
  source: ImportSource;
  sourceText: string;
}

/** A hosted or local OpenAI-compatible provider can implement this boundary. */
export interface ImportModelProvider {
  readonly id: string;
  structure(input: ImportModelInput): Promise<StructuredRecipeCandidate>;
}

export interface ImportMediaExtractionInput {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly kind: "audio_video" | "image" | "pdf";
  readonly mimeType: string;
}

export interface ImportMediaTextExtractor {
  readonly id: string;
  extract(input: ImportMediaExtractionInput): Promise<string>;
}

export class ImportNotReadyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ImportNotReadyError";
  }
}

export class ImportReviewRequiredError extends Error {
  public constructor(message = "Import review and confirmation are required") {
    super(message);
    this.name = "ImportReviewRequiredError";
  }
}
