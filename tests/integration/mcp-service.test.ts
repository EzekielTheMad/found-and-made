import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { McpService } from "#src/modules/mcp/mcp.service.server";
import {
  MCP_TOOL_NAMES,
  McpAuthenticationError,
  McpRateLimitError,
  McpScopeError,
} from "#src/modules/mcp/mcp.types";
import { createRuntime, type AppRuntime } from "#src/platform/runtime.server";
import { fourServingRecipe } from "../fixtures/four-serving-recipe";

const owner = { kind: "user", role: "owner", userId: "owner-user" } as const;
const editor = {
  kind: "user",
  role: "editor",
  userId: "editor-user",
} as const;
const viewer = {
  kind: "user",
  role: "viewer",
  userId: "viewer-user",
} as const;

describe("MCP domain and security service", () => {
  const cleanup: Array<{ directory: string; runtime: AppRuntime }> = [];

  afterEach(async () => {
    for (const item of cleanup.splice(0)) {
      await item.runtime.close();
      await rm(item.directory, { force: true, recursive: true });
    }
  });

  it("returns only explicitly approved recipes through the exact six read-only tools", async () => {
    const { mcp, recipes, runtime } = await fixture();
    const cuisine = runtime.discoveryService.createFacetGroup(owner, {
      name: "Cuisine",
    });
    const italian = runtime.discoveryService.createFacetTerm(owner, {
      groupId: cuisine,
      name: "Italian",
    });
    runtime.discoveryService.assignTerms(editor, recipes[0].id, [italian.id]);
    runtime.discoveryService.assignTerms(editor, recipes[1].id, [italian.id]);
    const collectionId = runtime.discoveryService.createCollection(owner, {
      title: "Dinner",
    });
    runtime.discoveryService.assignCollectionRecipes(owner, collectionId, [
      recipes[0].id,
      recipes[1].id,
    ]);
    runtime.database.sqlite
      .prepare(
        `INSERT INTO personal_recipe_states
         (user_id, recipe_id, favorite, note, cooked_count, version, created_at, updated_at)
         VALUES (?, ?, 0, ?, 0, 1, ?, ?)`,
      )
      .run(
        viewer.userId,
        recipes[0].id,
        "PRIVATE HOUSEHOLD NOTE",
        "2026-07-31T00:00:00.000Z",
        "2026-07-31T00:00:00.000Z",
      );
    mcp.setRecipeApproval(owner, recipes[0].id, true);

    const issued = mcp.issueToken(owner, {
      name: "Hermes",
      scopes: ["recipes:read", "collections:read"],
    });
    expect(issued.token).toMatch(/^fm_ro_/);
    expect(mcp.toolNames()).toEqual(MCP_TOOL_NAMES);
    expect(MCP_TOOL_NAMES).toEqual([
      "search_recipes",
      "get_recipe",
      "get_scaled_recipe",
      "list_collections",
      "list_saved_views",
      "find_recipes",
    ]);

    const search = mcp.execute(issued.token, {
      arguments: {
        equipment: ["Dutch oven"],
        includeTermIds: [italian.id],
        ingredients: ["tomatoes"],
        maxTimeMinutes: 120,
        query: "lasagna",
      },
      tool: "search_recipes",
    });
    expect(search).toEqual([
      {
        id: recipes[0].id,
        title: recipes[0].title,
        updatedAt: recipes[0].updatedAt,
      },
    ]);
    const recipe = mcp.execute(issued.token, {
      arguments: { recipeId: recipes[0].id },
      tool: "get_recipe",
    });
    const serialized = JSON.stringify(recipe);
    expect(serialized).not.toContain("PRIVATE HOUSEHOLD NOTE");
    expect(serialized).not.toContain("example.com");
    expect(serialized).not.toContain("fingerprint");
    expect(serialized).not.toContain("originalWording");
    expect(recipe).toMatchObject({
      baseYield: 4,
      id: recipes[0].id,
      title: "Sunday Lasagna",
    });
    expect(() =>
      mcp.execute(issued.token, {
        arguments: { recipeId: recipes[1].id },
        tool: "get_recipe",
      }),
    ).toThrow("not available");

    const scaled = mcp.execute(issued.token, {
      arguments: {
        recipeId: recipes[0].id,
        targetServings: 8,
        unitPreference: "metric",
      },
      tool: "get_scaled_recipe",
    });
    expect(scaled).toMatchObject({
      targetServings: 8,
      unitPreference: "metric",
    });
    expect(JSON.stringify(scaled)).toContain("910 g");

    const collections = mcp.execute(issued.token, {
      arguments: {},
      tool: "list_collections",
    });
    expect(collections).toMatchObject([
      { id: collectionId, recipeIds: [recipes[0].id], title: "Dinner" },
    ]);
    const views = mcp.execute(issued.token, {
      arguments: {},
      tool: "list_saved_views",
    });
    expect(Array.isArray(views)).toBe(true);
    expect(JSON.stringify(views)).not.toContain("userId");

    const found = mcp.execute(issued.token, {
      arguments: {
        equipment: ["Dutch oven"],
        includeTermIds: [italian.id],
        ingredients: ["tomatoes"],
        maxTimeMinutes: 120,
      },
      tool: "find_recipes",
    });
    expect(found).toMatchObject([{ id: recipes[0].id }]);
    expect(
      mcp.execute(issued.token, {
        arguments: { maxTimeMinutes: 60 },
        tool: "find_recipes",
      }),
    ).toEqual([]);
    expect(
      runtime.database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM recipe_publications")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("enforces Owner administration, exact scopes, expiry, revocation, and fixed-window limits", async () => {
    const { mcp, recipes } = await fixture({ rateLimit: 2 });
    expect(() =>
      mcp.issueToken(editor, { name: "No", scopes: ["recipes:read"] }),
    ).toThrow("Owner");
    expect(() => mcp.setRecipeApproval(viewer, recipes[0].id, true)).toThrow(
      "Owner",
    );
    expect(() =>
      mcp.issueToken(owner, {
        name: "Bad scopes",
        scopes: ["collections:read"],
      }),
    ).toThrow("recipes:read");
    mcp.setRecipeApproval(owner, recipes[0].id, true);

    const recipesOnly = mcp.issueToken(owner, {
      name: "Recipes only",
      scopes: ["recipes:read"],
    });
    expect(() =>
      mcp.execute(recipesOnly.token, {
        arguments: {},
        tool: "list_collections",
      }),
    ).toThrow(McpScopeError);
    expect(() =>
      mcp.execute("anonymous", {
        arguments: {},
        tool: "search_recipes",
      }),
    ).toThrow(McpAuthenticationError);

    const now = new Date("2026-07-31T12:00:00.000Z");
    const expiring = mcp.issueToken(
      owner,
      {
        expiresAt: new Date("2026-07-31T12:00:01.000Z"),
        name: "Short",
        scopes: ["recipes:read"],
      },
      now,
    );
    expect(() =>
      mcp.execute(
        expiring.token,
        { arguments: {}, tool: "search_recipes" },
        new Date("2026-07-31T12:00:02.000Z"),
      ),
    ).toThrow("expired");

    const revoked = mcp.issueToken(owner, {
      name: "Revoke me",
      scopes: ["recipes:read"],
    });
    mcp.revokeToken(owner, revoked.id);
    expect(() =>
      mcp.execute(revoked.token, {
        arguments: {},
        tool: "search_recipes",
      }),
    ).toThrow("revoked");

    const limited = mcp.issueToken(owner, {
      name: "Limited",
      scopes: ["recipes:read"],
    });
    const request = { arguments: {}, tool: "search_recipes" } as const;
    mcp.execute(limited.token, request, now);
    mcp.execute(limited.token, request, now);
    expect(() => mcp.execute(limited.token, request, now)).toThrow(
      McpRateLimitError,
    );
  });

  it("stores token hashes and redacted use/audit records without raw token or tool arguments", async () => {
    const { mcp, recipes, runtime } = await fixture();
    mcp.setRecipeApproval(owner, recipes[0].id, true);
    const issued = mcp.issueToken(owner, {
      name: "Audit token",
      scopes: ["recipes:read"],
    });
    mcp.execute(issued.token, {
      arguments: { query: "SECRET_QUERY_NEVER_LOG" },
      tool: "search_recipes",
    });
    const context = mcp.authenticateToken(issued.token);
    expect(context.principal).toEqual({
      kind: "service",
      scopes: ["recipes:read"],
      subject: issued.id,
    });
    expect(mcp.listTokens(owner)[0]).not.toHaveProperty("token");
    expect(mcp.listTokens(owner)[0]).not.toHaveProperty("tokenHash");

    const stored = JSON.stringify({
      audits: runtime.database.sqlite
        .prepare(
          `SELECT action, actor_id AS actorId, subject_id AS subjectId, metadata
           FROM audit_events WHERE action LIKE 'mcp.%' ORDER BY created_at`,
        )
        .all(),
      tokens: runtime.database.sqlite
        .prepare("SELECT id, name, scopes FROM mcp_tokens")
        .all(),
      uses: runtime.database.sqlite
        .prepare(
          `SELECT token_id AS tokenId, tool, outcome, result_count AS resultCount
           FROM mcp_use_records`,
        )
        .all(),
    });
    expect(stored).not.toContain(issued.token);
    expect(stored).not.toContain("SECRET_QUERY_NEVER_LOG");
    expect(stored).not.toContain("token_hash");
    expect(stored).toContain("search_recipes");
    const storedHash = runtime.database.sqlite
      .prepare("SELECT token_hash AS tokenHash FROM mcp_tokens WHERE id = ?")
      .get(issued.id) as { tokenHash: string };
    expect(storedHash.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  async function fixture(options: { rateLimit?: number } = {}) {
    const directory = await mkdtemp(join(tmpdir(), "found-made-mcp-"));
    const runtime = await createRuntime({
      dataDir: directory,
      startWorker: false,
    });
    cleanup.push({ directory, runtime });
    const timestamp = "2026-07-31T00:00:00.000Z";
    const insertUser = runtime.database.sqlite.prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?)`,
    );
    const insertRole = runtime.database.sqlite.prepare(
      `INSERT INTO app_users (user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const principal of [owner, editor, viewer]) {
      insertUser.run(
        principal.userId,
        principal.userId,
        `${principal.userId}@example.test`,
        timestamp,
        timestamp,
      );
      insertRole.run(principal.userId, principal.role, timestamp, timestamp);
    }
    const recipes = [
      runtime.recipeService.create(fourServingRecipe()),
      runtime.recipeService.create(
        fourServingRecipe({
          id: "private-lasagna",
          source: { originalUrl: "https://example.test/private" },
          title: "Private Lasagna",
        }),
        { allowDuplicate: true },
      ),
    ];
    return {
      directory,
      mcp: new McpService(
        runtime.database.sqlite,
        runtime.recipeAccessService,
        runtime.discoveryService,
        { rateLimit: options.rateLimit ?? 100 },
      ),
      recipes,
      runtime,
    };
  }
});
