export type AppRole = "owner" | "editor" | "viewer";
export type InviteRole = Exclude<AppRole, "owner">;

export type Principal =
  | { kind: "anonymous" }
  | { kind: "system" }
  | { kind: "user"; role: AppRole; userId: string }
  | { kind: "service"; scopes: readonly string[]; subject: string };

export type Permission =
  | "instance:manage"
  | "people:manage"
  | "recipe:create"
  | "recipe:delete"
  | "recipe:edit"
  | "recipe:publish"
  | "recipe:read"
  | "recipe:review"
  | "user-data:manage";

export interface AppUserSummary {
  email: string;
  emailVerified: boolean;
  id: string;
  name: string;
  role: AppRole;
}

export interface ContributorSummary {
  id: string;
  name: string;
}

export const anonymousPrincipal: Principal = { kind: "anonymous" };
export const systemPrincipal: Principal = { kind: "system" };

export class AuthorizationError extends Error {
  constructor(message = "You are not authorized to perform this action") {
    super(message);
    this.name = "AuthorizationError";
  }
}
