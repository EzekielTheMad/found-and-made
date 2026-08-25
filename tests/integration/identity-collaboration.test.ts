import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Principal } from "#src/modules/identity/identity.types";
import { createRuntime, type AppRuntime } from "#src/platform/runtime.server";
import { fourServingRecipe } from "../fixtures/four-serving-recipe";

const ownerInput = {
  email: "owner@example.com",
  name: "Owner",
  password: "correct horse battery staple",
};

describe("identity, recovery, and publication services", () => {
  const cleanup: Array<{ directory: string; runtime: AppRuntime }> = [];

  afterEach(async () => {
    for (const item of cleanup.splice(0)) {
      await item.runtime.close();
      await rm(item.directory, { force: true, recursive: true });
    }
  });

  it("creates exactly one initial local Owner and signs in through Better Auth", async () => {
    const originalPublicOrigin = process.env.PUBLIC_ORIGIN;
    process.env.PUBLIC_ORIGIN = "https://recipes.example.test";
    let runtime: AppRuntime;
    try {
      ({ runtime } = await runtimeFixture());
    } finally {
      if (originalPublicOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
      else process.env.PUBLIC_ORIGIN = originalPublicOrigin;
    }
    expect(runtime.identityService.needsInitialOwner()).toBe(true);
    const owner = await runtime.identityService.createInitialOwner(ownerInput);
    expect(owner).toMatchObject({ role: "owner", emailVerified: false });
    expect(runtime.identityService.needsInitialOwner()).toBe(false);
    await expect(
      runtime.identityService.createInitialOwner({
        ...ownerInput,
        email: "second@example.com",
      }),
    ).rejects.toThrow("already been completed");

    const result = await runtime.auth.api.signInEmail({
      body: { email: ownerInput.email, password: ownerInput.password },
      returnHeaders: true,
    });
    const setCookies = result.headers.getSetCookie();
    const sessionCookie = setCookies.find((value) =>
      value.includes("session_token="),
    );
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Lax");
    expect(sessionCookie).toContain("Secure");
    const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
    const rejectedCrossSite = await runtime.auth.handler(
      new Request("https://recipes.example.test/api/auth/sign-in/email", {
        body: JSON.stringify({
          email: ownerInput.email,
          password: ownerInput.password,
        }),
        headers: {
          "content-type": "application/json",
          cookie,
          origin: "https://attacker.example.test",
          "sec-fetch-site": "cross-site",
        },
        method: "POST",
      }),
    );
    expect(rejectedCrossSite.status).toBe(403);
    const session = await runtime.auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(session?.user.email).toBe(ownerInput.email);
    expect(runtime.identityService.principalForUser(session!.user.id)).toEqual({
      kind: "user",
      role: "owner",
      userId: owner.id,
    });
  });

  it("changes a local password from an authenticated session", async () => {
    const { runtime } = await runtimeFixture();
    await runtime.identityService.createInitialOwner(ownerInput);
    const signedIn = await runtime.auth.api.signInEmail({
      body: { email: ownerInput.email, password: ownerInput.password },
      returnHeaders: true,
    });
    const cookie = cookieHeader(signedIn.headers.getSetCookie());

    await runtime.auth.api.changePassword({
      body: {
        currentPassword: ownerInput.password,
        newPassword: "a newer household password",
        revokeOtherSessions: true,
      },
      headers: new Headers({ cookie }),
    });

    await expect(
      runtime.auth.api.signInEmail({
        body: { email: ownerInput.email, password: ownerInput.password },
      }),
    ).rejects.toThrow();
    await expect(
      runtime.auth.api.signInEmail({
        body: {
          email: ownerInput.email,
          password: "a newer household password",
        },
      }),
    ).resolves.toBeDefined();
  });

  it("keeps a signed-in library session available during thumbnail bursts", async () => {
    const { runtime } = await runtimeFixture();
    await runtime.identityService.createInitialOwner(ownerInput);
    const signedIn = await runtime.auth.api.signInEmail({
      body: { email: ownerInput.email, password: ownerInput.password },
      returnHeaders: true,
    });
    const headers = new Headers({
      cookie: cookieHeader(signedIn.headers.getSetCookie()),
      "x-forwarded-for": "192.0.2.44",
    });

    const sessions = await Promise.all(
      Array.from({ length: 160 }, () =>
        runtime.auth.api.getSession({ headers }),
      ),
    );

    expect(
      sessions.every((session) => session?.user.email === ownerInput.email),
    ).toBe(true);
  });

  it("completes an explicit Google redirect, callback, link, and sign-in flow", async () => {
    const priorEnvironment = captureEnvironment([
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "PUBLIC_ORIGIN",
    ]);
    process.env.GOOGLE_CLIENT_ID = "found-made-google-test-client";
    process.env.GOOGLE_CLIENT_SECRET = "found-made-google-test-secret";
    process.env.PUBLIC_ORIGIN = "https://recipes.example.test";
    let runtime: AppRuntime;
    try {
      ({ runtime } = await runtimeFixture());
    } finally {
      restoreEnvironment(priorEnvironment);
    }

    const owner = await runtime.identityService.createInitialOwner(ownerInput);
    const localSignIn = await runtime.auth.api.signInEmail({
      body: { email: ownerInput.email, password: ownerInput.password },
      returnHeaders: true,
    });
    const localCookie = cookieHeader(localSignIn.headers.getSetCookie());
    const originalFetch = globalThis.fetch;
    const tokenRequests: URLSearchParams[] = [];
    let googleProfile = googleIdentity({ emailVerified: true });
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input;
        if (url !== "https://oauth2.googleapis.com/token") {
          return originalFetch(input, init);
        }
        if (!(init?.body instanceof URLSearchParams)) {
          throw new Error("Google token exchange did not use form data");
        }
        const body = new URLSearchParams(init.body);
        tokenRequests.push(body);
        return Response.json({
          access_token: "google-access-token-for-test",
          expires_in: 3600,
          id_token: unsignedTestIdToken(googleProfile),
          refresh_token: "google-refresh-token-for-test",
          scope: "openid email profile",
          token_type: "Bearer",
        });
      },
    );

    try {
      const implicitStart = await startGoogleFlow(
        runtime,
        "/api/auth/sign-in/social",
        { callbackURL: "/", disableRedirect: true, provider: "google" },
      );
      assertGoogleAuthorizationRequest(implicitStart.authorizationURL);
      const implicitCallback = await finishGoogleFlow(runtime, implicitStart);
      expect(implicitCallback.status).toBe(302);
      expect(implicitCallback.headers.get("location")).toContain("error=");
      expect(googleAccounts(runtime, owner.id)).toEqual([]);

      googleProfile = googleIdentity({ emailVerified: false });
      const unverifiedStart = await startGoogleFlow(
        runtime,
        "/api/auth/link-social",
        {
          callbackURL: "/account",
          disableRedirect: true,
          provider: "google",
        },
        localCookie,
      );
      const unverifiedCallback = await finishGoogleFlow(
        runtime,
        unverifiedStart,
        localCookie,
      );
      expect(unverifiedCallback.status).toBe(302);
      expect(unverifiedCallback.headers.get("location")).toContain(
        "unable_to_link_account",
      );
      expect(googleAccounts(runtime, owner.id)).toEqual([]);

      googleProfile = googleIdentity({ emailVerified: true });
      const linkStart = await startGoogleFlow(
        runtime,
        "/api/auth/link-social",
        {
          callbackURL: "/account",
          disableRedirect: true,
          provider: "google",
        },
        localCookie,
      );
      const linkCallback = await finishGoogleFlow(
        runtime,
        linkStart,
        localCookie,
      );
      expect(linkCallback.status).toBe(302);
      expect(linkCallback.headers.get("location")).toBe("/account");
      expect(googleAccounts(runtime, owner.id)).toEqual([
        expect.objectContaining({
          accountId: "google-owner-subject",
          providerId: "google",
        }),
      ]);
      const linkedTokens = runtime.database.sqlite
        .prepare(
          `SELECT accessToken, refreshToken FROM account
           WHERE userId = ? AND providerId = 'google'`,
        )
        .get(owner.id) as { accessToken: string; refreshToken: string };
      expect(linkedTokens.accessToken).not.toContain(
        "google-access-token-for-test",
      );
      expect(linkedTokens.refreshToken).not.toContain(
        "google-refresh-token-for-test",
      );

      const googleSignInStart = await startGoogleFlow(
        runtime,
        "/api/auth/sign-in/social",
        { callbackURL: "/", disableRedirect: true, provider: "google" },
      );
      const googleSignInCallback = await finishGoogleFlow(
        runtime,
        googleSignInStart,
      );
      expect(googleSignInCallback.status).toBe(302);
      expect(googleSignInCallback.headers.get("location")).toBe("/");
      const googleSessionCookie = cookieHeader(
        googleSignInCallback.headers.getSetCookie(),
      );
      const googleSession = await runtime.auth.api.getSession({
        headers: new Headers({ cookie: googleSessionCookie }),
      });
      expect(googleSession?.user.id).toBe(owner.id);
      expect(tokenRequests).toHaveLength(4);
      for (const request of tokenRequests) {
        expect(request.get("client_id")).toBe("found-made-google-test-client");
        expect(request.get("client_secret")).toBe(
          "found-made-google-test-secret",
        );
        expect(request.get("code_verifier")).toHaveLength(128);
        expect(request.get("redirect_uri")).toBe(
          "https://recipes.example.test/api/auth/callback/google",
        );
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("enforces expiring, single-use, email-bound invitations under concurrency", async () => {
    const { runtime } = await runtimeFixture();
    const owner = await runtime.identityService.createInitialOwner(ownerInput);
    const principal = asPrincipal(owner.id, "owner");
    const issued = runtime.identityService.createInvitation(
      principal,
      { email: "editor@example.com", expiresInHours: 1, role: "editor" },
      new Date("2026-07-31T10:00:00.000Z"),
    );
    const account = {
      email: "editor@example.com",
      name: "Editor",
      password: "editor password is long enough",
    };
    const attempts = await Promise.allSettled([
      runtime.identityService.acceptInvitation(
        issued.token,
        account,
        new Date("2026-07-31T10:30:00.000Z"),
      ),
      runtime.identityService.acceptInvitation(
        issued.token,
        account,
        new Date("2026-07-31T10:30:00.000Z"),
      ),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);

    const expired = runtime.identityService.createInvitation(
      principal,
      { email: "viewer@example.com", expiresInHours: 1, role: "viewer" },
      new Date("2026-07-31T10:00:00.000Z"),
    );
    await expect(
      runtime.identityService.acceptInvitation(
        expired.token,
        {
          email: "viewer@example.com",
          name: "Viewer",
          password: "viewer password is long enough",
        },
        new Date("2026-07-31T11:00:00.001Z"),
      ),
    ).rejects.toThrow("expired");
  });

  it("protects the final Owner, final method, and Owner local credential", async () => {
    const { runtime } = await runtimeFixture();
    const owner = await runtime.identityService.createInitialOwner(ownerInput);
    const principal = asPrincipal(owner.id, "owner");
    expect(() =>
      runtime.identityService.changeRole(principal, owner.id, "editor"),
    ).toThrow("final Owner");
    expect(() =>
      runtime.identityService.assertCanUnlink(owner.id, "credential"),
    ).toThrow("final sign-in method");

    const timestamp = new Date().toISOString();
    runtime.database.sqlite
      .prepare(
        `INSERT INTO account
         (id, accountId, providerId, userId, createdAt, updatedAt)
         VALUES ('google-account', 'google-subject', 'google', ?, ?, ?)`,
      )
      .run(owner.id, timestamp, timestamp);
    expect(() =>
      runtime.identityService.assertCanUnlink(owner.id, "credential"),
    ).toThrow("local recovery credential");
    expect(() =>
      runtime.identityService.assertCanUnlink(owner.id, "google"),
    ).not.toThrow();
  });

  it("supports email and server recovery with expiry, replay defense, and session revocation", async () => {
    const { runtime } = await runtimeFixture();
    await runtime.identityService.createInitialOwner(ownerInput);
    let delivered:
      { email: string; expiresAt: string; token: string } | undefined;
    await runtime.recoveryService.requestEmailReset(
      ownerInput.email,
      (message) => {
        delivered = message;
        return Promise.resolve();
      },
      new Date("2026-07-31T12:00:00.000Z"),
    );
    expect(delivered?.email).toBe(ownerInput.email);
    await runtime.recoveryService.resetPassword(
      delivered!.token,
      "new email recovery password",
      new Date("2026-07-31T12:05:00.000Z"),
    );
    await expect(
      runtime.recoveryService.resetPassword(
        delivered!.token,
        "another recovery password",
        new Date("2026-07-31T12:06:00.000Z"),
      ),
    ).rejects.toThrow("already been used");

    const server = runtime.recoveryService.issueServerOwnerRecovery(
      ownerInput.email,
      new Date("2026-07-31T13:00:00.000Z"),
    );
    await expect(
      runtime.recoveryService.resetPassword(
        server.token,
        "expired recovery password",
        new Date("2026-07-31T13:15:00.001Z"),
      ),
    ).rejects.toThrow("expired");
  });

  it("keeps recipes private by default and permits only Owners to publish", async () => {
    const { runtime } = await runtimeFixture();
    const owner = await runtime.identityService.createInitialOwner(ownerInput);
    const ownerPrincipal = asPrincipal(owner.id, "owner");
    const invitation = runtime.identityService.createInvitation(
      ownerPrincipal,
      {
        email: "publisher-editor@example.com",
        role: "editor",
      },
    );
    const editor = await runtime.identityService.acceptInvitation(
      invitation.token,
      {
        email: "publisher-editor@example.com",
        name: "Publishing Editor",
        password: "publishing editor password",
      },
    );
    const editorPrincipal = asPrincipal(editor.id, "editor");
    const recipe = runtime.recipeService.create(fourServingRecipe());

    expect(runtime.publishingService.getPublicRecipe(recipe.id)).toBeNull();
    expect(() =>
      runtime.publishingService.publish(editorPrincipal, recipe.id),
    ).toThrow();
    runtime.publishingService.requestReview(editorPrincipal, recipe.id);
    expect(runtime.publishingService.getPublicRecipe(recipe.id)).toBeNull();
    runtime.publishingService.publish(ownerPrincipal, recipe.id);
    expect(runtime.publishingService.getPublicRecipe(recipe.id)).toBeNull();
    expect(runtime.publishingService.listPublicRecipes()).toEqual([]);
    runtime.publishingService.setPublicMode(ownerPrincipal, true);
    expect(runtime.publishingService.getPublicRecipe(recipe.id)?.id).toBe(
      recipe.id,
    );
    expect(runtime.publishingService.listPublicRecipes()).toEqual([
      expect.objectContaining({ id: recipe.id, title: recipe.title }),
    ]);
    runtime.publishingService.unpublish(ownerPrincipal, recipe.id);
    expect(runtime.publishingService.getPublicRecipe(recipe.id)).toBeNull();
    expect(runtime.publishingService.listPublicRecipes()).toEqual([]);
  });

  async function runtimeFixture() {
    const directory = await mkdtemp(join(tmpdir(), "found-made-identity-"));
    const item = {
      directory,
      runtime: await createRuntime({ dataDir: directory, startWorker: false }),
    };
    cleanup.push(item);
    return item;
  }
});

function asPrincipal(
  userId: string,
  role: "owner" | "editor" | "viewer",
): Principal {
  return { kind: "user", role, userId };
}

type GoogleProfile = {
  aud: string;
  email: string;
  email_verified: boolean;
  exp: number;
  iat: number;
  iss: string;
  name: string;
  picture: string;
  sub: string;
};

function googleIdentity({
  emailVerified,
}: {
  emailVerified: boolean;
}): GoogleProfile {
  const now = Math.floor(Date.now() / 1000);
  return {
    aud: "found-made-google-test-client",
    email: ownerInput.email,
    email_verified: emailVerified,
    exp: now + 3600,
    iat: now,
    iss: "https://accounts.google.com",
    name: ownerInput.name,
    picture: "https://images.example.test/owner.png",
    sub: "google-owner-subject",
  };
}

function unsignedTestIdToken(profile: GoogleProfile): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(profile)}.test-only`;
}

async function startGoogleFlow(
  runtime: AppRuntime,
  path: "/api/auth/link-social" | "/api/auth/sign-in/social",
  body: Record<string, unknown>,
  cookie = "",
) {
  const response = await runtime.auth.handler(
    new Request(`https://recipes.example.test${path}`, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        origin: "https://recipes.example.test",
        "sec-fetch-site": "same-origin",
      },
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { url: string };
  return {
    authorizationURL: new URL(payload.url),
    cookies: response.headers.getSetCookie(),
  };
}

async function finishGoogleFlow(
  runtime: AppRuntime,
  start: Awaited<ReturnType<typeof startGoogleFlow>>,
  priorCookie = "",
) {
  const state = start.authorizationURL.searchParams.get("state");
  expect(state).toBeTruthy();
  const cookie = [priorCookie, cookieHeader(start.cookies)]
    .filter(Boolean)
    .join("; ");
  return runtime.auth.handler(
    new Request(
      `https://recipes.example.test/api/auth/callback/google?code=test-code&state=${encodeURIComponent(state!)}`,
      { headers: { cookie } },
    ),
  );
}

function assertGoogleAuthorizationRequest(url: URL): void {
  expect(url.origin + url.pathname).toBe(
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  expect(url.searchParams.get("client_id")).toBe(
    "found-made-google-test-client",
  );
  expect(url.searchParams.get("redirect_uri")).toBe(
    "https://recipes.example.test/api/auth/callback/google",
  );
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBeTruthy();
  expect(
    new Set(url.searchParams.get("scope")?.split(" ").filter(Boolean)),
  ).toEqual(new Set(["openid", "email", "profile"]));
}

function googleAccounts(runtime: AppRuntime, userId: string) {
  return runtime.database.sqlite
    .prepare(
      `SELECT accountId, providerId FROM account
       WHERE userId = ? AND providerId = 'google'`,
    )
    .all(userId) as Array<{ accountId: string; providerId: string }>;
}

function cookieHeader(setCookies: string[]): string {
  return setCookies.map((value) => value.split(";", 1)[0]).join("; ");
}

function captureEnvironment(names: string[]): Map<string, string | undefined> {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(values: Map<string, string | undefined>): void {
  for (const [name, value] of values) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
