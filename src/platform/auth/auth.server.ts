import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";

import { publicOriginFromEnv } from "../http/public-origin.server";
import type { DatabaseHandle } from "../db/database.server";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
} from "../db/schema";

interface CreateAuthServerOptions {
  environment?: NodeJS.ProcessEnv;
  googleClientId?: string;
  googleClientSecret?: string;
  secret: string;
  database: DatabaseHandle["db"];
}

export function createAuthServer({
  database,
  environment = process.env,
  googleClientId = environment.GOOGLE_CLIENT_ID,
  googleClientSecret = environment.GOOGLE_CLIENT_SECRET,
  secret,
}: CreateAuthServerOptions) {
  const configuration = authConfigurationFromEnv(environment, {
    googleClientId,
    googleClientSecret,
  });

  return betterAuth({
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
        disableImplicitLinking: true,
        enabled: true,
        updateUserInfoOnLink: false,
      },
    },
    advanced: {
      cookiePrefix: "found-and-made",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: configuration.secureCookies,
      },
      disableCSRFCheck: false,
      disableOriginCheck: false,
      useSecureCookies: configuration.secureCookies,
    },
    appName: "Found & Made",
    baseURL: configuration.publicOrigin,
    database: drizzleAdapter(database, {
      provider: "sqlite",
      schema: {
        account: authAccounts,
        session: authSessions,
        user: authUsers,
        verification: authVerifications,
      },
    }),
    emailAndPassword: {
      disableSignUp: true,
      enabled: true,
      maxPasswordLength: 128,
      minPasswordLength: 12,
    },
    // Library pages can legitimately request many protected thumbnails at once.
    // Better Auth keeps its stricter three-attempt rules for sign-in and
    // password changes while allowing ordinary authenticated reads to fan out.
    rateLimit: {
      max: 500,
      window: 10,
    },
    secret,
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      freshAge: 60 * 60 * 24,
    },
    ...(configuration.google
      ? {
          socialProviders: {
            google: {
              clientId: configuration.google.clientId,
              clientSecret: configuration.google.clientSecret,
              disableSignUp: true,
              scope: ["openid", "email", "profile"],
            },
          },
        }
      : {}),
    trustedOrigins: [configuration.publicOrigin],
  });
}

export function authConfigurationFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
  google: {
    googleClientId?: string;
    googleClientSecret?: string;
  } = {},
) {
  const publicOrigin = publicOriginFromEnv(environment);
  const allowInsecure = environment.ALLOW_INSECURE_PUBLIC_ORIGIN;
  if (allowInsecure && allowInsecure !== "true" && allowInsecure !== "false") {
    throw new Error("ALLOW_INSECURE_PUBLIC_ORIGIN must be true or false");
  }
  if (
    environment.NODE_ENV === "production" &&
    publicOrigin.startsWith("http://") &&
    allowInsecure !== "true"
  ) {
    throw new Error(
      "PUBLIC_ORIGIN must use HTTPS in production unless ALLOW_INSECURE_PUBLIC_ORIGIN=true",
    );
  }

  const googleClientId = google.googleClientId ?? environment.GOOGLE_CLIENT_ID;
  const googleClientSecret =
    google.googleClientSecret ?? environment.GOOGLE_CLIENT_SECRET;
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together",
    );
  }

  return {
    ...(googleClientId && googleClientSecret
      ? {
          google: {
            clientId: googleClientId,
            clientSecret: googleClientSecret,
          },
        }
      : {}),
    publicOrigin,
    secureCookies: publicOrigin.startsWith("https://"),
  };
}

export type AuthServer = ReturnType<typeof createAuthServer>;
