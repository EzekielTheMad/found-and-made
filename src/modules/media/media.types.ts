export type MediaRole = "hero" | "gallery" | "component" | "step";
export type MediaVariant = "original" | "social" | "web";

export interface MediaAsset {
  altText: string;
  caption: string;
  checksum: string;
  componentId?: string;
  createdAt: string;
  focalX: number;
  focalY: number;
  height: number;
  id: string;
  position: number;
  recipeId: string;
  role: MediaRole;
  stepId?: string;
  updatedAt: string;
  width: number;
}

export interface MediaUpload {
  altText: string;
  bytes: Uint8Array;
  caption?: string;
  componentId?: string;
  focalX?: number;
  focalY?: number;
  position?: number;
  recipeId: string;
  role: MediaRole;
  stepId?: string;
}

export interface MediaUpdate {
  altText: string;
  caption?: string;
  focalX: number;
  focalY: number;
  position: number;
}
