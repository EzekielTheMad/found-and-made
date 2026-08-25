import type { Principal } from "../identity/identity.types";
import type { DiscoveryService } from "../discovery/discovery.service.server";
import type {
  DiscoveryFilters,
  DiscoverySort,
} from "../discovery/discovery.types";
import type { RecipeAccessService } from "../recipes/recipe-access.service.server";

export type PrintSelectionSource =
  | { kind: "recipe"; recipeId: string }
  | { filters: DiscoveryFilters; kind: "search"; sort?: DiscoverySort }
  | { kind: "facet"; sort?: DiscoverySort; termId: string }
  | { kind: "label"; label: string }
  | { collectionId: string; kind: "collection" }
  | { kind: "saved_view"; savedViewId: string };

/** Resolves print sources through the same access and discovery services as UI. */
export class PrintSelectionService {
  public constructor(
    private readonly discovery: DiscoveryService,
    private readonly recipes: RecipeAccessService,
  ) {}

  public resolve(principal: Principal, source: PrintSelectionSource): string[] {
    switch (source.kind) {
      case "recipe":
        this.recipes.get(principal, source.recipeId);
        return [source.recipeId];
      case "search":
        return this.fromSearch(principal, source.filters, source.sort);
      case "facet":
        if (
          !this.discovery
            .terms(principal)
            .some((term) => term.id === source.termId)
        ) {
          throw new Error("Facet term not found");
        }
        return this.fromSearch(
          principal,
          { includeTermIds: [source.termId] },
          source.sort,
        );
      case "label":
        return this.fromLabel(principal, source.label);
      case "collection":
        return this.authorizedIds(
          principal,
          this.discovery.collection(principal, source.collectionId).recipeIds,
        );
      case "saved_view": {
        const view = this.discovery
          .listSavedViews(principal)
          .find((item) => item.id === source.savedViewId);
        if (!view) throw new Error("Saved view not found");
        return this.fromSearch(principal, view.criteria, view.sort);
      }
    }
  }

  private fromSearch(
    principal: Principal,
    filters: DiscoveryFilters,
    sort: DiscoverySort | undefined,
  ): string[] {
    return this.authorizedIds(
      principal,
      this.discovery
        .search(principal, filters, sort)
        .map((recipe) => recipe.id),
    );
  }

  private fromLabel(principal: Principal, label: string): string[] {
    const normalized = label.trim().toLowerCase();
    if (!normalized) throw new Error("Label is required");
    if (
      !this.discovery
        .labels(principal)
        .some((item) => item.name.toLowerCase() === normalized)
    ) {
      throw new Error("Label not found");
    }
    const ids = this.recipes
      .list(principal)
      .filter((recipe) =>
        this.discovery
          .recipeClassification(principal, recipe.id)
          .labelNames.some((name) => name.toLowerCase() === normalized),
      )
      .map((recipe) => recipe.id);
    return this.authorizedIds(principal, ids);
  }

  private authorizedIds(
    principal: Principal,
    ids: readonly string[],
  ): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      try {
        this.recipes.get(principal, id);
        result.push(id);
        seen.add(id);
      } catch {
        // A stale collection or an inaccessible/deleted recipe is not printable.
      }
    }
    return result;
  }
}
