import { createHash, randomBytes, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { DiscoveryService } from "../discovery/discovery.service.server";
import type { Principal } from "../identity/identity.types";
import { projectRecipe } from "../recipes/recipe.projections";
import type {
  RecipeAggregate,
  RecipeProjection,
} from "../recipes/recipe.types";
import type { RecipeAccessService } from "../recipes/recipe-access.service.server";
import {
  type FindRecipesInput,
  type IssuedMcpToken,
  McpAuthenticationError,
  type McpCollectionDto,
  type McpAuthenticatedContext,
  type McpRecipeDto,
  type McpRecipeSummaryDto,
  McpRateLimitError,
  type McpSavedViewDto,
  type McpScaledRecipeDto,
  type McpScope,
  McpScopeError,
  type McpTokenSummary,
  McpTokenValidationError,
  type McpToolInput,
  type McpToolName,
  type McpToolResult,
  MCP_TOOL_NAMES,
  type SearchRecipesInput,
  type IssueMcpTokenInput,
} from "./mcp.types";

interface McpServiceOptions {
  rateLimit?: number;
  rateWindowMs?: number;
}

interface TokenRow {
  createdAt: string;
  expiresAt: string | null;
  id: string;
  lastUsedAt: string | null;
  name: string;
  revokedAt: string | null;
  scopes: string;
}

export class McpService {
  private readonly rateLimit: number;
  private readonly rateWindowMs: number;

  constructor(
    private readonly sqlite: Database.Database,
    private readonly recipeAccess: RecipeAccessService,
    private readonly discovery: DiscoveryService,
    options: McpServiceOptions = {},
  ) {
    this.rateLimit = options.rateLimit ?? 60;
    this.rateWindowMs = options.rateWindowMs ?? 60_000;
    if (!Number.isInteger(this.rateLimit) || this.rateLimit < 1)
      throw new Error("MCP rate limit must be a positive whole number");
    if (!Number.isInteger(this.rateWindowMs) || this.rateWindowMs < 1_000)
      throw new Error("MCP rate window must be at least one second");
  }

  toolNames(): readonly McpToolName[] {
    return MCP_TOOL_NAMES;
  }

  issueToken(
    principal: Principal,
    input: IssueMcpTokenInput,
    now = new Date(),
  ): IssuedMcpToken {
    const ownerId = requireOwner(principal);
    const name = requiredText(input.name, 120, "Token name");
    const scopes = validScopes(input.scopes);
    if (input.expiresAt && input.expiresAt.getTime() <= now.getTime()) {
      throw new McpTokenValidationError("Token expiry must be in the future");
    }
    const token = `fm_ro_${randomBytes(32).toString("base64url")}`;
    const id = randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO mcp_tokens
         (id, name, token_hash, scopes, created_by, created_at, expires_at,
          revoked_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        id,
        name,
        tokenHash(token),
        JSON.stringify(scopes),
        ownerId,
        now.toISOString(),
        input.expiresAt?.toISOString() ?? null,
      );
    this.audit("mcp.token.issued", ownerId, id, { scopes }, now);
    return {
      createdAt: now.toISOString(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt.toISOString() } : {}),
      id,
      name,
      scopes,
      token,
    };
  }

  listTokens(principal: Principal): McpTokenSummary[] {
    requireOwner(principal);
    const rows = this.sqlite
      .prepare(
        `SELECT id, name, scopes, created_at AS createdAt,
          expires_at AS expiresAt, revoked_at AS revokedAt,
          last_used_at AS lastUsedAt
         FROM mcp_tokens ORDER BY created_at DESC, id`,
      )
      .all() as TokenRow[];
    return rows.map(toTokenSummary);
  }

  revokeToken(
    principal: Principal,
    tokenId: string,
    now = new Date(),
  ): McpTokenSummary {
    const ownerId = requireOwner(principal);
    const result = this.sqlite
      .prepare(
        `UPDATE mcp_tokens SET revoked_at = COALESCE(revoked_at, ?)
         WHERE id = ?`,
      )
      .run(now.toISOString(), tokenId);
    if (result.changes !== 1) throw new Error("MCP token not found");
    this.audit("mcp.token.revoked", ownerId, tokenId, {}, now);
    return this.tokenSummary(tokenId);
  }

  setRecipeApproval(
    principal: Principal,
    recipeId: string,
    approved: boolean,
    now = new Date(),
  ): void {
    const ownerId = requireOwner(principal);
    this.recipeAccess.get(principal, recipeId);
    if (approved) {
      this.sqlite
        .prepare(
          `INSERT INTO mcp_recipe_approvals (recipe_id, approved_by, approved_at)
           VALUES (?, ?, ?)
           ON CONFLICT(recipe_id) DO UPDATE SET
             approved_by = excluded.approved_by,
             approved_at = excluded.approved_at`,
        )
        .run(recipeId, ownerId, now.toISOString());
    } else {
      this.sqlite
        .prepare("DELETE FROM mcp_recipe_approvals WHERE recipe_id = ?")
        .run(recipeId);
    }
    this.audit(
      approved ? "mcp.recipe.approved" : "mcp.recipe.unapproved",
      ownerId,
      recipeId,
      {},
      now,
    );
  }

  listApprovedRecipeIds(principal: Principal): string[] {
    requireOwner(principal);
    return this.sqlite
      .prepare(
        `SELECT approval.recipe_id AS recipeId
         FROM mcp_recipe_approvals approval
         JOIN recipes recipe ON recipe.id = approval.recipe_id
         WHERE recipe.deleted_at IS NULL ORDER BY approval.recipe_id`,
      )
      .all()
      .map((row) => (row as { recipeId: string }).recipeId);
  }

  execute(
    rawToken: string,
    request: McpToolInput,
    now = new Date(),
  ): McpToolResult {
    if (!MCP_TOOL_NAMES.includes(request.tool)) {
      throw new Error("Unknown or non-read-only MCP tool");
    }
    let authenticated: McpAuthenticatedContext;
    try {
      authenticated = this.authenticateToken(rawToken, now);
    } catch (error) {
      this.audit(
        "mcp.authentication.rejected",
        null,
        null,
        { reason: authenticationReason(error) },
        now,
      );
      throw error;
    }

    try {
      this.consumeRateLimit(authenticated.token.id, now);
    } catch (error) {
      this.recordUse(
        authenticated.token.id,
        request.tool,
        "rate_limited",
        0,
        now,
      );
      throw error;
    }

    try {
      requireToolScope(authenticated.token.scopes, request.tool);
      const result = this.executeAuthenticated(
        authenticated.principal,
        request,
      );
      const count = Array.isArray(result) ? result.length : 1;
      this.recordUse(
        authenticated.token.id,
        request.tool,
        "success",
        count,
        now,
      );
      this.sqlite
        .prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?")
        .run(now.toISOString(), authenticated.token.id);
      return result;
    } catch (error) {
      this.recordUse(
        authenticated.token.id,
        request.tool,
        error instanceof McpScopeError ? "denied" : "error",
        0,
        now,
      );
      throw error;
    }
  }

  private executeAuthenticated(
    principal: Extract<Principal, { kind: "service" }>,
    request: McpToolInput,
  ): McpToolResult {
    switch (request.tool) {
      case "search_recipes":
        return this.find(principal, request.arguments);
      case "get_recipe":
        return this.recipeDto(principal, request.arguments.recipeId);
      case "get_scaled_recipe":
        return this.scaledRecipeDto(
          principal,
          request.arguments.recipeId,
          request.arguments.targetServings,
          request.arguments.unitPreference ?? "as-written",
        );
      case "list_collections":
        return this.collections(principal);
      case "list_saved_views":
        return this.savedViews(principal);
      case "find_recipes":
        return this.find(principal, request.arguments);
    }
  }

  private search(
    principal: Extract<Principal, { kind: "service" }>,
    input: SearchRecipesInput,
  ): McpRecipeSummaryDto[] {
    const approved = this.approvedIds();
    return this.discovery
      .search(
        principal,
        {
          ...(input.excludeTermIds?.length
            ? { excludeTermIds: input.excludeTermIds }
            : {}),
          ...(input.includeTermIds?.length
            ? { includeTermIds: input.includeTermIds }
            : {}),
          ...(input.query?.trim() ? { search: input.query.trim() } : {}),
        },
        input.sort ?? "title",
      )
      .filter((recipe) => approved.has(recipe.id))
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  }

  private find(
    principal: Extract<Principal, { kind: "service" }>,
    input: FindRecipesInput,
  ): McpRecipeSummaryDto[] {
    if (
      input.maxTimeMinutes !== undefined &&
      (!Number.isFinite(input.maxTimeMinutes) || input.maxTimeMinutes <= 0)
    ) {
      throw new Error("Maximum time must be a positive number of minutes");
    }
    const ingredients = normalizedFilters(input.ingredients);
    const equipment = normalizedFilters(input.equipment);
    return this.search(principal, input)
      .filter((summary) => {
        const recipe = this.recipeAccess.get(principal, summary.id);
        const recipeIngredients = recipe.ingredients.map((item) =>
          item.name.toLowerCase(),
        );
        const recipeEquipment = recipe.equipment.map((item) =>
          item.name.toLowerCase(),
        );
        if (
          !ingredients.every((wanted) =>
            recipeIngredients.some((name) => name.includes(wanted)),
          )
        )
          return false;
        if (
          !equipment.every((wanted) =>
            recipeEquipment.some((name) => name.includes(wanted)),
          )
        )
          return false;
        if (input.maxTimeMinutes !== undefined) {
          const minutes = totalKnownMinutes(recipe);
          if (minutes === undefined || minutes > input.maxTimeMinutes)
            return false;
        }
        return true;
      })
      .sort(
        (left, right) =>
          left.title.localeCompare(right.title) ||
          left.id.localeCompare(right.id),
      );
  }

  private recipeDto(
    principal: Extract<Principal, { kind: "service" }>,
    recipeId: string,
  ): McpRecipeDto {
    this.requireApproved(recipeId);
    const recipe = this.recipeAccess.get(principal, recipeId);
    return toRecipeDto(recipe, projectRecipe(recipe));
  }

  private scaledRecipeDto(
    principal: Extract<Principal, { kind: "service" }>,
    recipeId: string,
    targetServings: number,
    unitPreference: "as-written" | "metric",
  ): McpScaledRecipeDto {
    this.requireApproved(recipeId);
    const recipe = this.recipeAccess.get(principal, recipeId);
    const projection = projectRecipe(recipe, targetServings, unitPreference);
    return {
      ...toRecipeDto(recipe, projection),
      targetServings: projection.targetYield,
      unitPreference,
    };
  }

  private collections(
    principal: Extract<Principal, { kind: "service" }>,
  ): McpCollectionDto[] {
    const approved = this.approvedIds();
    return this.discovery.collections(principal).map((summary) => {
      const detail = this.discovery.collection(principal, summary.id);
      return {
        description: detail.description,
        id: detail.id,
        recipeIds: detail.recipeIds.filter((id) => approved.has(id)),
        title: detail.title,
      };
    });
  }

  private savedViews(
    principal: Extract<Principal, { kind: "service" }>,
  ): McpSavedViewDto[] {
    return this.discovery
      .listSavedViews(principal)
      .filter((view) => view.isStarter)
      .map((view) => ({
        criteria: {
          ...(view.criteria.excludeTermIds?.length
            ? { excludeTermIds: [...view.criteria.excludeTermIds] }
            : {}),
          ...(view.criteria.includeTermIds?.length
            ? { includeTermIds: [...view.criteria.includeTermIds] }
            : {}),
          ...(view.criteria.search ? { search: view.criteria.search } : {}),
        },
        id: view.id,
        name: view.name,
        sort: view.sort,
      }));
  }

  authenticateToken(
    rawToken: string,
    now = new Date(),
  ): McpAuthenticatedContext {
    if (!rawToken.startsWith("fm_ro_") || rawToken.length < 40) {
      throw new McpAuthenticationError("Invalid MCP token");
    }
    const row = this.sqlite
      .prepare(
        `SELECT id, name, scopes, created_at AS createdAt,
          expires_at AS expiresAt, revoked_at AS revokedAt,
          last_used_at AS lastUsedAt
         FROM mcp_tokens WHERE token_hash = ?`,
      )
      .get(tokenHash(rawToken)) as TokenRow | undefined;
    if (!row) throw new McpAuthenticationError("Invalid MCP token");
    if (row.revokedAt) throw new McpAuthenticationError("MCP token is revoked");
    if (row.expiresAt && new Date(row.expiresAt).getTime() <= now.getTime())
      throw new McpAuthenticationError("MCP token is expired");
    const token = toTokenSummary(row);
    return {
      principal: {
        kind: "service",
        scopes: token.scopes,
        subject: token.id,
      },
      token,
    };
  }

  private consumeRateLimit(tokenId: string, now: Date): void {
    this.sqlite.transaction(() => {
      const windowStartedAt = new Date(
        Math.floor(now.getTime() / this.rateWindowMs) * this.rateWindowMs,
      ).toISOString();
      const row = this.sqlite
        .prepare(
          `SELECT window_started_at AS windowStartedAt,
            request_count AS requestCount
           FROM mcp_rate_windows WHERE token_id = ?`,
        )
        .get(tokenId) as
        { requestCount: number; windowStartedAt: string } | undefined;
      if (
        row?.windowStartedAt === windowStartedAt &&
        row.requestCount >= this.rateLimit
      )
        throw new McpRateLimitError("MCP rate limit exceeded");
      const requestCount =
        row?.windowStartedAt === windowStartedAt ? row.requestCount + 1 : 1;
      this.sqlite
        .prepare(
          `INSERT INTO mcp_rate_windows (token_id, window_started_at, request_count)
           VALUES (?, ?, ?)
           ON CONFLICT(token_id) DO UPDATE SET
             window_started_at = excluded.window_started_at,
             request_count = excluded.request_count`,
        )
        .run(tokenId, windowStartedAt, requestCount);
    })();
  }

  private approvedIds(): Set<string> {
    return new Set(
      this.sqlite
        .prepare(
          `SELECT approval.recipe_id AS recipeId
           FROM mcp_recipe_approvals approval
           JOIN recipes recipe ON recipe.id = approval.recipe_id
           WHERE recipe.deleted_at IS NULL`,
        )
        .all()
        .map((row) => (row as { recipeId: string }).recipeId),
    );
  }

  private requireApproved(recipeId: string): void {
    if (!this.approvedIds().has(recipeId))
      throw new Error("MCP recipe not available");
  }

  private tokenSummary(tokenId: string): McpTokenSummary {
    const row = this.sqlite
      .prepare(
        `SELECT id, name, scopes, created_at AS createdAt,
          expires_at AS expiresAt, revoked_at AS revokedAt,
          last_used_at AS lastUsedAt FROM mcp_tokens WHERE id = ?`,
      )
      .get(tokenId) as TokenRow | undefined;
    if (!row) throw new Error("MCP token not found");
    return toTokenSummary(row);
  }

  private recordUse(
    tokenId: string,
    tool: McpToolName,
    outcome: "denied" | "error" | "rate_limited" | "success",
    resultCount: number,
    now: Date,
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO mcp_use_records
         (id, token_id, tool, outcome, result_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        tokenId,
        tool,
        outcome,
        resultCount,
        now.toISOString(),
      );
    this.audit(
      "mcp.tool.used",
      null,
      tokenId,
      { outcome, resultCount, tool },
      now,
    );
  }

  private audit(
    action: string,
    actorId: string | null,
    subjectId: string | null,
    metadata: Record<string, unknown>,
    now: Date,
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO audit_events
         (id, action, actor_id, subject_id, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        action,
        actorId,
        subjectId,
        JSON.stringify(metadata),
        now.toISOString(),
      );
  }
}

function toRecipeDto(
  recipe: RecipeAggregate,
  projection: RecipeProjection,
): McpRecipeDto {
  const projectedIngredients = new Map(
    projection.classic
      .flatMap((component) => component.ingredients)
      .map((item) => [item.id, item]),
  );
  return {
    allergens: recipe.allergens
      .filter((item) => item.confirmed)
      .map((item) => item.name),
    baseYield: recipe.baseYield,
    diets: recipe.diets
      .filter((item) => item.confirmed)
      .map((item) => item.name),
    equipment: recipe.equipment.map(({ name, required }) => ({
      name,
      required,
    })),
    id: recipe.id,
    ingredients: recipe.ingredients.map((ingredient) => ({
      amount:
        projectedIngredients.get(ingredient.id)?.displayQuantity ?? "as needed",
      name: ingredient.name,
      requirement: ingredient.requirement,
    })),
    steps: [...recipe.steps]
      .sort((left, right) => left.position - right.position)
      .map((step) => ({
        instruction: step.instruction,
        position: step.position,
        ...(step.temperature ? { temperature: step.temperature } : {}),
        ...(step.time ? { time: step.time } : {}),
      })),
    title: recipe.title,
    version: recipe.version,
    yieldText: recipe.yieldText,
  };
}

function requireOwner(principal: Principal): string {
  if (principal.kind !== "user" || principal.role !== "owner")
    throw new Error("MCP administration requires Owner access");
  return principal.userId;
}

function validScopes(input: readonly McpScope[]): McpScope[] {
  const scopes = [...new Set(input)];
  if (!scopes.includes("recipes:read"))
    throw new McpTokenValidationError("MCP tokens require recipes:read");
  if (
    scopes.some(
      (scope) => scope !== "recipes:read" && scope !== "collections:read",
    )
  )
    throw new McpTokenValidationError("Unknown MCP token scope");
  return scopes.sort();
}

function requireToolScope(
  scopes: readonly McpScope[],
  tool: McpToolName,
): void {
  const required =
    tool === "list_collections" || tool === "list_saved_views"
      ? "collections:read"
      : "recipes:read";
  if (!scopes.includes(required))
    throw new McpScopeError(`Tool requires ${required}`);
}

function toTokenSummary(row: TokenRow): McpTokenSummary {
  return {
    createdAt: row.createdAt,
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
    id: row.id,
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
    name: row.name,
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
    scopes: validScopes(JSON.parse(row.scopes) as McpScope[]),
  };
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function requiredText(value: string, maximum: number, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum)
    throw new Error(
      `${label} is required and must be at most ${maximum} characters`,
    );
  return normalized;
}

function normalizedFilters(values: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean),
    ),
  ];
}

function totalKnownMinutes(recipe: RecipeAggregate): number | undefined {
  let total = 0;
  let found = false;
  for (const step of recipe.steps) {
    if (!step.time) continue;
    const matches = [
      ...step.time
        .toLowerCase()
        .matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)/g),
    ];
    for (const match of matches) {
      found = true;
      const value = Number(match[1]);
      total += match[2]?.startsWith("h") ? value * 60 : value;
    }
  }
  return found ? total : undefined;
}

function authenticationReason(error: unknown): string {
  if (!(error instanceof McpAuthenticationError)) return "invalid";
  if (error.message.includes("expired")) return "expired";
  if (error.message.includes("revoked")) return "revoked";
  return "invalid";
}
