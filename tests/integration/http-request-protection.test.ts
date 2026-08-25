import { once } from "node:events";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import {
  configureTrustedProxy,
  createRequestProtection,
} from "../../server/middleware/request-protection";

const PUBLIC_ORIGIN = "https://recipes.example.test";

describe("HTTP request protection", () => {
  const servers: ReturnType<express.Express["listen"]>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  });

  it("enforces origin and Fetch Metadata on browser mutations", async () => {
    const baseURL = await startApp();

    expect(
      await status(baseURL, "/recipes/one", {
        method: "POST",
        headers: { origin: PUBLIC_ORIGIN },
      }),
    ).toBe(204);
    expect(
      await status(baseURL, "/recipes/two", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      }),
    ).toBe(204);
    expect(
      await status(baseURL, "/recipes/three", {
        method: "POST",
        headers: {
          origin: PUBLIC_ORIGIN,
          "sec-fetch-site": "cross-site",
        },
      }),
    ).toBe(403);
    expect(
      await status(baseURL, "/recipes/four", {
        method: "POST",
        headers: { origin: "https://attacker.example.test" },
      }),
    ).toBe(403);
    expect(await status(baseURL, "/recipes/five", { method: "POST" })).toBe(
      403,
    );
  });

  it("leaves MCP to bearer transport controls and Better Auth to its own CSRF middleware", async () => {
    const baseURL = await startApp();

    expect(
      await status(baseURL, "/mcp", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      }),
    ).toBe(204);
    expect(
      await status(baseURL, "/api/auth/sign-in/email", { method: "POST" }),
    ).toBe(204);
  });

  it("applies independent bounded policies and returns Retry-After", async () => {
    const baseURL = await startApp({
      auth: { max: 1, windowMs: 5_000 },
      heavy: { max: 1, windowMs: 5_000 },
      media: { max: 2, windowMs: 5_000 },
      mutation: { max: 1, windowMs: 5_000 },
    });
    const mutationHeaders = { origin: PUBLIC_ORIGIN };

    expect(
      await status(baseURL, "/sign-in", {
        method: "POST",
        headers: mutationHeaders,
      }),
    ).toBe(204);
    const authLimited = await fetch(`${baseURL}/sign-in`, {
      method: "POST",
      headers: mutationHeaders,
    });
    expect(authLimited.status).toBe(429);
    expect(authLimited.headers.get("retry-after")).toBe("5");

    expect(
      await status(baseURL, "/imports", {
        method: "POST",
        headers: mutationHeaders,
      }),
    ).toBe(204);
    expect(
      await status(baseURL, "/imports", {
        method: "POST",
        headers: mutationHeaders,
      }),
    ).toBe(429);

    expect(
      await status(baseURL, "/recipes/one", {
        method: "POST",
        headers: mutationHeaders,
      }),
    ).toBe(204);
    expect(
      await status(baseURL, "/recipes/two", {
        method: "POST",
        headers: mutationHeaders,
      }),
    ).toBe(429);

    expect(await status(baseURL, "/api/media/one/web")).toBe(204);
    expect(await status(baseURL, "/api/media/two/web")).toBe(204);
    expect(await status(baseURL, "/api/media/three/web")).toBe(429);
  });

  it("ignores forwarded client addresses unless an explicit proxy range is trusted", async () => {
    const limits = { auth: { max: 1, windowMs: 5_000 } };
    const directURL = await startApp(limits);
    const headers = { origin: PUBLIC_ORIGIN };

    expect(
      await status(directURL, "/sign-in", {
        method: "POST",
        headers: { ...headers, "x-forwarded-for": "203.0.113.10" },
      }),
    ).toBe(204);
    expect(
      await status(directURL, "/sign-in", {
        method: "POST",
        headers: { ...headers, "x-forwarded-for": "203.0.113.11" },
      }),
    ).toBe(429);

    const proxiedURL = await startApp(limits, "loopback");
    expect(
      await status(proxiedURL, "/sign-in", {
        method: "POST",
        headers: { ...headers, "x-forwarded-for": "203.0.113.10" },
      }),
    ).toBe(204);
    expect(
      await status(proxiedURL, "/sign-in", {
        method: "POST",
        headers: { ...headers, "x-forwarded-for": "203.0.113.11" },
      }),
    ).toBe(204);
  });

  async function startApp(
    limits: Parameters<typeof createRequestProtection>[0]["limits"] = {},
    trustedProxy?: string,
  ): Promise<string> {
    const app = express();
    configureTrustedProxy(app, trustedProxy);
    app.use(createRequestProtection({ limits, publicOrigin: PUBLIC_ORIGIN }));
    app.all("/*splat", (_request, response) => response.status(204).end());
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
});

async function status(
  baseURL: string,
  path: string,
  init?: RequestInit,
): Promise<number> {
  return (await fetch(`${baseURL}${path}`, init)).status;
}
