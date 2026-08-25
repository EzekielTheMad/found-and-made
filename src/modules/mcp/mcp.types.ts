import type { DiscoverySort } from "../discovery/discovery.types";
import type { Principal } from "../identity/identity.types";
import type { UnitPreference } from "../recipes/recipe.scaling";

export type McpScope = "collections:read" | "recipes:read";

export type McpToolName =
  | "search_recipes"
  | "get_recipe"
  | "get_scaled_recipe"
  | "list_collections"
  | "list_saved_views"
  | "find_recipes";

export const MCP_TOOL_NAMES: readonly McpToolName[] = [
  "search_recipes",
  "get_recipe",
  "get_scaled_recipe",
  "list_collections",
  "list_saved_views",
  "find_recipes",
];

export interface McpTokenSummary {
  createdAt: string;
  expiresAt?: string;
  id: string;
  lastUsedAt?: string;
  name: string;
  revokedAt?: string;
  scopes: McpScope[];
}

export interface IssuedMcpToken extends McpTokenSummary {
  token: string;
}

export interface McpAuthenticatedContext {
  principal: Extract<Principal, { kind: "service" }>;
  token: McpTokenSummary;
}

export interface IssueMcpTokenInput {
  expiresAt?: Date;
  name: string;
  scopes: readonly McpScope[];
}

export interface McpRecipeSummaryDto {
  id: string;
  title: string;
  updatedAt: string;
}

export interface McpIngredientDto {
  amount: string;
  name: string;
  requirement: "alternative" | "optional" | "required";
}

export interface McpStepDto {
  instruction: string;
  position: number;
  temperature?: string;
  time?: string;
}

export interface McpRecipeDto {
  allergens: string[];
  baseYield: number;
  diets: string[];
  equipment: Array<{ name: string; required: boolean }>;
  id: string;
  ingredients: McpIngredientDto[];
  steps: McpStepDto[];
  title: string;
  version: number;
  yieldText: string;
}

export interface McpScaledRecipeDto extends McpRecipeDto {
  targetServings: number;
  unitPreference: UnitPreference;
}

export interface McpCollectionDto {
  description: string;
  id: string;
  recipeIds: string[];
  title: string;
}

export interface McpSavedViewDto {
  criteria: {
    excludeTermIds?: string[];
    includeTermIds?: string[];
    search?: string;
  };
  id: string;
  name: string;
  sort: DiscoverySort;
}

export interface SearchRecipesInput {
  equipment?: readonly string[];
  excludeTermIds?: readonly string[];
  includeTermIds?: readonly string[];
  ingredients?: readonly string[];
  maxTimeMinutes?: number;
  query?: string;
  sort?: DiscoverySort;
}

export type FindRecipesInput = SearchRecipesInput;

export type McpToolInput =
  | { arguments: SearchRecipesInput; tool: "search_recipes" }
  | { arguments: { recipeId: string }; tool: "get_recipe" }
  | {
      arguments: {
        recipeId: string;
        targetServings: number;
        unitPreference?: UnitPreference;
      };
      tool: "get_scaled_recipe";
    }
  | { arguments: Record<string, never>; tool: "list_collections" }
  | { arguments: Record<string, never>; tool: "list_saved_views" }
  | { arguments: FindRecipesInput; tool: "find_recipes" };

export type McpToolResult =
  | McpCollectionDto[]
  | McpRecipeDto
  | McpRecipeSummaryDto[]
  | McpSavedViewDto[]
  | McpScaledRecipeDto;

export class McpAuthenticationError extends Error {
  readonly code = "mcp_authentication_failed";
}

export class McpScopeError extends Error {
  readonly code = "mcp_scope_denied";
}

export class McpRateLimitError extends Error {
  readonly code = "mcp_rate_limited";
}

export class McpTokenValidationError extends Error {
  readonly code = "mcp_token_invalid";
}
