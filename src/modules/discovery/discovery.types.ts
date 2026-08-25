export type DiscoverySort = "recent" | "title" | "created";
export type DiscoveryLayout = "cards" | "list";

export interface DiscoveryFilters {
  excludeTermIds?: readonly string[];
  includeTermIds?: readonly string[];
  search?: string;
}

export type SavedViewCriteria = DiscoveryFilters;

export interface RecipeSearchResult {
  id: string;
  title: string;
  updatedAt: string;
}

export interface FacetTerm {
  aliases: string[];
  groupId: string;
  id: string;
  name: string;
  parentId?: string;
  position: number;
  slug: string;
}

export interface FacetGroup {
  id: string;
  name: string;
  position: number;
  slug: string;
}

export interface LabelSummary {
  id: string;
  name: string;
  recipeCount: number;
}

export interface CollectionSummary {
  description: string;
  id: string;
  position: number;
  recipeCount: number;
  title: string;
}

export interface CollectionDetail extends CollectionSummary {
  recipeIds: string[];
}

export interface RecipeClassification {
  labelNames: string[];
  termIds: string[];
}

export interface SavedView {
  criteria: SavedViewCriteria;
  id: string;
  isStarter: boolean;
  layout: DiscoveryLayout;
  name: string;
  pinned: boolean;
  sort: DiscoverySort;
  userId?: string;
}

export interface HomeSection {
  config: Record<string, unknown>;
  id: string;
  position: number;
  title: string;
}
