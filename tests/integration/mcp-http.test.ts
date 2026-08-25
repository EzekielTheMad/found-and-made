import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fourServingRecipe } from "../fixtures/four-serving-recipe";

const owner = { kind: "user", role: "owner", userId: "owner-user" } as const;

describe("MCP HTTP boundary", () => {
  let directory: string | undefined;
  let httpServer: Server | undefined;
  const originalEnv = {
    DATA_DIR: process.env.DATA_DIR,
    MCP_ALLOWED_CIDRS: process.env.MCP_ALLOWED_CIDRS,
    MCP_ALLOWED_HOSTS: process.env.MCP_ALLOWED_HOSTS,
    MCP_ALLOWED_ORIGINS: process.env.MCP_ALLOWED_ORIGINS,
    MCP_ENABLED: process.env.MCP_ENABLED,
    MCP_REQUEST_RATE_LIMIT: process.env.MCP_REQUEST_RATE_LIMIT,
  };

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((resolve, reject) =>
        httpServer?.close((error) => (error ? reject(error) : resolve())),
      );
      httpServer = undefined;
    }
    const serverModule = await import("../../server/app");
    await serverModule.shutdownRuntime();
    if (directory) await rm(directory, { force: true, recursive: true });
    directory = undefined;
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("enforces transport controls and serves Hermes-compatible legacy requests", async () => {
    directory = await mkdtemp(join(tmpdir(), "found-made-mcp-http-"));
    process.env.DATA_DIR = directory;
    process.env.MCP_ENABLED = "true";
    process.env.MCP_ALLOWED_HOSTS = "127.0.0.1";
    process.env.MCP_ALLOWED_ORIGINS = "https://hermes.example.test";
    process.env.MCP_ALLOWED_CIDRS = "127.0.0.0/8";
    process.env.MCP_REQUEST_RATE_LIMIT = "2";

    const serverModule = await import("../../server/app");
    await serverModule.initializeRuntime();
    const { getApplicationRuntime } =
      await import("#src/platform/runtime.server");
    const runtime = getApplicationRuntime();
    const timestamp = "2026-07-31T00:00:00.000Z";
    runtime.database.sqlite
      .prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run(owner.userId, "Owner", "owner@example.test", timestamp, timestamp);
    runtime.database.sqlite
      .prepare(
        `INSERT INTO app_users (user_id, role, created_at, updated_at)
         VALUES (?, 'owner', ?, ?)`,
      )
      .run(owner.userId, timestamp, timestamp);
    const recipe = runtime.recipeService.create(fourServingRecipe());
    runtime.mcpService.setRecipeApproval(owner, recipe.id, true);
    const token = runtime.mcpService.issueToken(owner, {
      name: "Hermes",
      scopes: ["recipes:read"],
    }).token;

    httpServer = createServer(serverModule.app);
    await new Promise<void>((resolve, reject) => {
      httpServer?.once("error", reject);
      httpServer?.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === "string")
      throw new Error("No test port");
    const endpoint = `http://127.0.0.1:${address.port}/mcp`;

    const body = {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "hermes", version: "1" },
        protocolVersion: "2025-06-18",
      },
    };
    expect(
      (
        await post(endpoint, body, {
          Origin: "https://hermes.example.test",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await post(endpoint, body, {
          Authorization: `Bearer ${token}`,
          Origin: "https://forbidden.example.test",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(endpoint, body, {
          Authorization: `Bearer ${token}`,
        })
      ).status,
    ).toBe(403);

    const initialized = await post(endpoint, body, {
      Authorization: `Bearer ${token}`,
      Origin: "https://hermes.example.test",
    });
    expect(initialized.status).toBe(200);
    expect(await mcpJson(initialized)).toMatchObject({
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "found-and-made" },
      },
    });

    const listed = await post(
      endpoint,
      { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
      {
        Authorization: `Bearer ${token}`,
        Origin: "https://hermes.example.test",
      },
    );
    const listedJson = await mcpJson(listed);
    const names = (
      listedJson.result as { tools: Array<{ name: string }> }
    ).tools.map((tool) => tool.name);
    expect(names).toHaveLength(6);
    expect(names).not.toContain("create_recipe");
    expect(names).not.toContain("publish_recipe");

    const limited = await post(
      endpoint,
      { id: 3, jsonrpc: "2.0", method: "tools/list", params: {} },
      {
        Authorization: `Bearer ${token}`,
        Origin: "https://hermes.example.test",
      },
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  }, 30_000);
});

function post(
  endpoint: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(endpoint, {
    body: JSON.stringify(body),
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...headers,
    },
    method: "POST",
  });
}

async function mcpJson(response: Response): Promise<{ result: unknown }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const frame = await response.text();
    const dataLine = frame
      .split("\n")
      .find((line) => line.startsWith("data: "));
    if (!dataLine) throw new Error("MCP SSE response did not contain data");
    return JSON.parse(dataLine.slice(6)) as { result: unknown };
  }
  return (await response.json()) as { result: unknown };
}
