import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, type AppRuntime } from "#src/platform/runtime.server";
import { fourServingRecipe } from "../fixtures/four-serving-recipe";

const owner = { kind: "user", role: "owner", userId: "owner-user" } as const;

describe("MCP protocol adapter", () => {
  const cleanup: Array<{ directory: string; runtime: AppRuntime }> = [];

  afterEach(async () => {
    for (const item of cleanup.splice(0)) {
      await item.runtime.close();
      await rm(item.directory, { force: true, recursive: true });
    }
  });

  it("initializes, discovers six tools, and serves search/get/scaled calls", async () => {
    const { recipeId, runtime, token } = await fixture();

    const initialized = await rpc(runtime, token, {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "hermes-compatibility-test", version: "1.0.0" },
        protocolVersion: "2025-06-18",
      },
    });
    expect(initialized.result).toMatchObject({
      capabilities: { tools: {} },
      protocolVersion: "2025-06-18",
      serverInfo: { name: "found-and-made" },
    });

    const listed = await rpc(runtime, token, {
      id: 2,
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
    });
    expect(
      (listed.result as { tools: Array<{ name: string }> }).tools.map(
        (tool) => tool.name,
      ),
    ).toEqual([
      "search_recipes",
      "get_recipe",
      "get_scaled_recipe",
      "list_collections",
      "list_saved_views",
      "find_recipes",
    ]);

    const searched = await callTool(runtime, token, "search_recipes", {
      query: "lasagna",
    });
    expect(searched).toMatchObject([{ id: recipeId, title: "Sunday Lasagna" }]);

    const recipe = await callTool(runtime, token, "get_recipe", { recipeId });
    expect(recipe).toMatchObject({ baseYield: 4, id: recipeId });

    const scaled = await callTool(runtime, token, "get_scaled_recipe", {
      recipeId,
      targetServings: 8,
      unitPreference: "metric",
    });
    expect(scaled).toMatchObject({
      id: recipeId,
      targetServings: 8,
      unitPreference: "metric",
    });
    expect(JSON.stringify(scaled)).toContain("910 g");
  });

  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "found-made-mcp-protocol-"));
    const runtime = await createRuntime({
      dataDir: directory,
      startWorker: false,
    });
    cleanup.push({ directory, runtime });
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
    const issued = runtime.mcpService.issueToken(owner, {
      name: "Hermes",
      scopes: ["collections:read", "recipes:read"],
    });
    return { recipeId: recipe.id, runtime, token: issued.token };
  }
});

async function callTool(
  runtime: AppRuntime,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await rpc(runtime, token, {
    id: 3,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: args, name },
  });
  const result = response.result as {
    isError?: boolean;
    structuredContent: { result: unknown };
  };
  expect(result.isError).not.toBe(true);
  return result.structuredContent.result;
}

async function rpc(
  runtime: AppRuntime,
  token: string,
  body: Record<string, unknown>,
): Promise<{ result: unknown }> {
  const response = await runtime.mcpHttpHandler.fetch(
    new Request("http://recipes.example.test/mcp", {
      body: JSON.stringify(body),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Origin: "https://hermes.example.test",
      },
      method: "POST",
    }),
    { parsedBody: body },
  );
  expect(response.status).toBe(200);
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const frame = await response.text();
    const dataLine = frame
      .split("\n")
      .find((line) => line.startsWith("data: "));
    if (!dataLine) throw new Error("MCP SSE response did not contain data");
    return JSON.parse(dataLine.slice(6)) as { result: unknown };
  }
  return (await response.json()) as { result: unknown };
}
