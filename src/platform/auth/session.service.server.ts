import { redirect } from "react-router";

import type { IdentityService } from "../../modules/identity/identity.service.server";
import {
  anonymousPrincipal,
  type Principal,
} from "../../modules/identity/identity.types";
import type { AuthServer } from "./auth.server";

export class SessionService {
  constructor(
    private readonly auth: AuthServer,
    private readonly identities: IdentityService,
  ) {}

  async principal(request: Request): Promise<Principal> {
    const session = await this.auth.api.getSession({
      headers: request.headers,
    });
    if (!session) return anonymousPrincipal;
    return this.identities.principalForUser(session.user.id);
  }

  async requireUser(
    request: Request,
  ): Promise<Extract<Principal, { kind: "user" }>> {
    const principal = await this.principal(request);
    // React Router uses thrown redirect Responses to short-circuit nested loaders.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (principal.kind !== "user") throw redirect("/sign-in");
    return principal;
  }
}
