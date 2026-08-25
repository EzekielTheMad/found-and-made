import { AuthorizationPolicy } from "../identity/authorization.policy";
import type { Principal } from "../identity/identity.types";
import type { RecipeService } from "./recipe.service.server";
import type { RecipeDraft } from "./recipe.types";

export class RecipeAccessService {
  private readonly policy = new AuthorizationPolicy();

  constructor(private readonly recipes: RecipeService) {}

  create(
    principal: Principal,
    draft: RecipeDraft,
    options?: Parameters<RecipeService["create"]>[1],
  ) {
    this.policy.require(principal, "recipe:create");
    return this.recipes.create(draft, {
      ...options,
      createdByUserId:
        principal.kind === "user" ? principal.userId : options?.createdByUserId,
    });
  }

  get(principal: Principal, id: string, includeDeleted = false) {
    this.policy.require(principal, "recipe:read");
    return this.recipes.get(id, includeDeleted);
  }

  list(principal: Principal, includeDeleted = false) {
    this.policy.require(
      principal,
      includeDeleted ? "recipe:delete" : "recipe:read",
    );
    return this.recipes.list(includeDeleted);
  }

  project(principal: Principal, id: string, targetYield: number) {
    this.policy.require(principal, "recipe:read");
    return this.recipes.project(id, targetYield);
  }

  update(
    principal: Principal,
    id: string,
    draft: RecipeDraft,
    options: Parameters<RecipeService["update"]>[2],
  ) {
    this.policy.require(principal, "recipe:edit");
    return this.recipes.update(id, draft, options);
  }

  saveVariant(
    principal: Principal,
    sourceRecipeId: string,
    targetYield: number,
    title: string,
  ) {
    this.policy.require(principal, "recipe:create");
    return this.recipes.saveVariant(
      sourceRecipeId,
      targetYield,
      title,
      new Date(),
      principal.kind === "user" ? principal.userId : undefined,
    );
  }

  trash(
    principal: Principal,
    ...parameters: Parameters<RecipeService["trash"]>
  ) {
    this.policy.require(principal, "recipe:delete");
    return this.recipes.trash(...parameters);
  }

  trashMany(
    principal: Principal,
    ...parameters: Parameters<RecipeService["trashMany"]>
  ) {
    this.policy.require(principal, "recipe:delete");
    return this.recipes.trashMany(...parameters);
  }

  restore(
    principal: Principal,
    ...parameters: Parameters<RecipeService["restore"]>
  ) {
    this.policy.require(principal, "recipe:delete");
    return this.recipes.restore(...parameters);
  }

  revisions(principal: Principal, id: string) {
    this.policy.require(principal, "recipe:read");
    return this.recipes.revisions(id);
  }

  restoreRevision(
    principal: Principal,
    ...parameters: Parameters<RecipeService["restoreRevision"]>
  ) {
    this.policy.require(principal, "recipe:edit");
    return this.recipes.restoreRevision(...parameters);
  }

  duplicates(principal: Principal, draft: RecipeDraft, excludeId?: string) {
    this.policy.require(principal, "recipe:read");
    return this.recipes.duplicates(draft, excludeId);
  }
}
