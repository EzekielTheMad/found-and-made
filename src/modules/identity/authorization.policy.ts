import {
  AuthorizationError,
  type Permission,
  type Principal,
} from "./identity.types";

const permissionsByRole: Record<
  "owner" | "editor" | "viewer",
  ReadonlySet<Permission>
> = {
  owner: new Set([
    "instance:manage",
    "people:manage",
    "recipe:create",
    "recipe:delete",
    "recipe:edit",
    "recipe:publish",
    "recipe:read",
    "recipe:review",
    "user-data:manage",
  ]),
  editor: new Set([
    "recipe:create",
    "recipe:edit",
    "recipe:read",
    "recipe:review",
    "user-data:manage",
  ]),
  viewer: new Set(["recipe:read", "user-data:manage"]),
};

export class AuthorizationPolicy {
  can(principal: Principal, permission: Permission): boolean {
    if (principal.kind === "system") return true;
    if (principal.kind === "anonymous") return false;
    if (principal.kind === "service") {
      return (
        permission === "recipe:read" &&
        principal.scopes.includes("recipes:read")
      );
    }
    return permissionsByRole[principal.role].has(permission);
  }

  require(principal: Principal, permission: Permission): void {
    if (!this.can(principal, permission)) throw new AuthorizationError();
  }
}
