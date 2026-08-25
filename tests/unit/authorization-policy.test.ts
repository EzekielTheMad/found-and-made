import { describe, expect, it } from "vitest";

import { AuthorizationPolicy } from "#src/modules/identity/authorization.policy";
import type {
  Permission,
  Principal,
} from "#src/modules/identity/identity.types";

describe("authorization policy", () => {
  const policy = new AuthorizationPolicy();
  const permissions: Permission[] = [
    "instance:manage",
    "people:manage",
    "recipe:create",
    "recipe:delete",
    "recipe:edit",
    "recipe:publish",
    "recipe:read",
    "recipe:review",
    "user-data:manage",
  ];

  it("enforces the complete Owner Editor Viewer anonymous matrix", () => {
    const principals: Record<string, Principal> = {
      anonymous: { kind: "anonymous" },
      editor: { kind: "user", role: "editor", userId: "editor" },
      owner: { kind: "user", role: "owner", userId: "owner" },
      viewer: { kind: "user", role: "viewer", userId: "viewer" },
    };
    const allowed: Record<string, Permission[]> = {
      anonymous: [],
      editor: [
        "recipe:create",
        "recipe:edit",
        "recipe:read",
        "recipe:review",
        "user-data:manage",
      ],
      owner: permissions,
      viewer: ["recipe:read", "user-data:manage"],
    };

    for (const [name, principal] of Object.entries(principals)) {
      for (const permission of permissions) {
        expect(
          policy.can(principal, permission),
          `${name}: ${permission}`,
        ).toBe(allowed[name]?.includes(permission));
      }
    }
  });

  it("limits service tokens to their explicit read scope", () => {
    const service: Principal = {
      kind: "service",
      scopes: ["recipes:read"],
      subject: "hermes",
    };
    expect(policy.can(service, "recipe:read")).toBe(true);
    expect(policy.can(service, "recipe:edit")).toBe(false);
  });
});
