export type PrintPageSize = "a4" | "half-letter" | "letter";

export type PrintLayout =
  | "classic-single-column"
  | "classic-two-column"
  | "step-linked"
  | "landscape-merge-grid"
  | "compact-card";

export type PrintNumberingMode = "fixed" | "modular";

export type PrintColorMode = "black-and-white" | "color";

export type PrintVisualStyle = "heirloom" | "minimal" | "modern";

export interface PrintMarginsMm {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export interface PrintTypography {
  bodyFontSizePt: number;
  fontFamily: string;
  headingFontSizePt: number;
}

export interface PrintProfileConfig {
  colorMode?: PrintColorMode;
  defaultLayout: PrintLayout;
  duplex: boolean;
  includeMetadata: boolean;
  includePhotos: boolean;
  marginsMm: PrintMarginsMm;
  pageSize: PrintPageSize;
  typography: PrintTypography;
  visualStyle?: PrintVisualStyle;
}

export interface PrintProfile {
  config: PrintProfileConfig;
  createdAt: string;
  id: string;
  name: string;
  updatedAt: string;
  version: number;
}

export interface CreatePrintProfileInput {
  config: PrintProfileConfig;
  name: string;
}

export interface UpdatePrintProfileInput {
  config?: PrintProfileConfig;
  name?: string;
}

interface PrintOutlineItemBase {
  id: string;
}

export interface PrintCoverItem extends PrintOutlineItemBase {
  subtitle?: string;
  title: string;
  type: "cover";
}

export interface PrintDividerItem extends PrintOutlineItemBase {
  subtitle?: string;
  title: string;
  type: "divider";
}

export interface PrintSectionItem extends PrintOutlineItemBase {
  subtitle?: string;
  title: string;
  type: "section";
}

export interface PrintRecipeItem extends PrintOutlineItemBase {
  layoutOverride?: PrintLayout;
  recipeId: string;
  targetServings?: number;
  type: "recipe";
}

export interface PrintNotesItem extends PrintOutlineItemBase {
  heading?: string;
  lines: number;
  type: "notes";
}

export type PrintOutlineItem =
  | PrintCoverItem
  | PrintDividerItem
  | PrintNotesItem
  | PrintRecipeItem
  | PrintSectionItem;

export interface PrintCollection {
  createdAt: string;
  description: string;
  globalLayout: PrintLayout;
  id: string;
  name: string;
  numberingMode: PrintNumberingMode;
  outline: PrintOutlineItem[];
  profileId?: string;
  updatedAt: string;
  version: number;
}

export interface CreatePrintCollectionInput {
  description?: string;
  globalLayout: PrintLayout;
  name: string;
  numberingMode?: PrintNumberingMode;
  outline?: readonly PrintOutlineItem[];
  profileId?: string;
}

export interface UpdatePrintCollectionInput {
  description?: string;
  globalLayout?: PrintLayout;
  name?: string;
  numberingMode?: PrintNumberingMode;
  outline?: readonly PrintOutlineItem[];
  profileId?: string | null;
}

export interface PrintRecipeSelectionInput {
  layoutOverride?: PrintLayout;
  recipeId: string;
  targetServings?: number;
}

export interface PrintRecipeSelection {
  layout: PrintLayout;
  recipeId: string;
  recipeVersion: number;
  targetServings: number;
}

export interface CreatePrintJobInput {
  collectionId?: string;
  globalLayout?: PrintLayout;
  idempotencyKey: string;
  numberingMode?: PrintNumberingMode;
  profileId?: string;
  selections?: readonly PrintRecipeSelectionInput[];
}

export interface PrintJobRequest {
  collection?: PrintCollection;
  globalLayout: PrintLayout;
  numberingMode: PrintNumberingMode;
  profile: PrintProfile;
  selections: PrintRecipeSelection[];
}

export type PrintJobStatus = "completed" | "failed" | "queued" | "rendering";

export interface PrintArtifactMetadata {
  checksumSha256: string;
  mimeType: "application/pdf";
  pageCount: number;
  relativePath: string;
  sizeBytes: number;
}

export interface PrintJob {
  artifact?: PrintArtifactMetadata;
  collectionId?: string;
  createdAt: string;
  errorCode?: string;
  id: string;
  profileId?: string;
  request: PrintJobRequest;
  status: PrintJobStatus;
  updatedAt: string;
  version: number;
}

export class PrintVersionConflictError extends Error {
  readonly code = "print_version_conflict";

  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Print record version conflict: expected ${expectedVersion}, found ${actualVersion}`,
    );
    this.name = "PrintVersionConflictError";
  }
}

export class PrintIdempotencyConflictError extends Error {
  readonly code = "print_idempotency_conflict";

  constructor(readonly idempotencyKey: string) {
    super(
      `Print idempotency key ${idempotencyKey} was reused with different data`,
    );
    this.name = "PrintIdempotencyConflictError";
  }
}
