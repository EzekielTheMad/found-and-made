import { describe, expect, it } from "vitest";

import { authConfigurationFromEnv } from "#src/platform/auth/auth.server";

describe("auth configuration", () => {
  it("requires HTTPS in production unless the insecure deployment override is explicit", () => {
    expect(() =>
      authConfigurationFromEnv({
        NODE_ENV: "production",
        PUBLIC_ORIGIN: "http://recipes.example.test",
      }),
    ).toThrow("PUBLIC_ORIGIN must use HTTPS in production");

    expect(
      authConfigurationFromEnv({
        ALLOW_INSECURE_PUBLIC_ORIGIN: "true",
        NODE_ENV: "production",
        PUBLIC_ORIGIN: "http://recipes.example.test",
      }),
    ).toMatchObject({
      publicOrigin: "http://recipes.example.test",
      secureCookies: false,
    });
    expect(() =>
      authConfigurationFromEnv({
        ALLOW_INSECURE_PUBLIC_ORIGIN: "yes",
        NODE_ENV: "production",
        PUBLIC_ORIGIN: "http://recipes.example.test",
      }),
    ).toThrow("ALLOW_INSECURE_PUBLIC_ORIGIN must be true or false");
  });

  it("enables secure cookies for HTTPS and rejects partial Google configuration", () => {
    expect(
      authConfigurationFromEnv({
        NODE_ENV: "production",
        PUBLIC_ORIGIN: "https://recipes.example.test",
      }),
    ).toMatchObject({
      publicOrigin: "https://recipes.example.test",
      secureCookies: true,
    });
    expect(() =>
      authConfigurationFromEnv({
        GOOGLE_CLIENT_ID: "client-id",
        PUBLIC_ORIGIN: "https://recipes.example.test",
      }),
    ).toThrow(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together",
    );
    expect(() =>
      authConfigurationFromEnv({
        GOOGLE_CLIENT_SECRET: "client-secret",
        PUBLIC_ORIGIN: "https://recipes.example.test",
      }),
    ).toThrow(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together",
    );
  });
});
