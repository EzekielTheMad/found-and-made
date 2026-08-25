import {
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import type { McpService } from "../../modules/mcp/mcp.service.server";
import {
  McpAuthenticationError,
  McpRateLimitError,
  McpScopeError,
  type McpToolInput,
  type McpToolResult,
} from "../../modules/mcp/mcp.types";

const recipeIdSchema = z.string().trim().min(1).max(120);
const termIdsSchema = z.array(z.string().trim().min(1).max(120)).max(100);
const searchSchema = z.object({
  excludeTermIds: termIdsSchema.optional(),
  includeTermIds: termIdsSchema.optional(),
  query: z.string().trim().max(200).optional(),
  sort: z.enum(["recent", "title", "created"]).optional(),
});
const findSchema = searchSchema.extend({
  equipment: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  ingredients: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  maxTimeMinutes: z.number().positive().max(10_080).optional(),
});

export function createFoundMadeMcpHandler(service: McpService): McpHttpHandler {
  return createMcpHandler(
    ({ requestInfo }) => {
      const rawToken = bearerToken(requestInfo?.headers.get("authorization"));
      const server = new McpServer(
        { name: "found-and-made", version: "0.1.0-alpha.0" },
        {
          instructions:
            "Read-only access to recipes explicitly approved by the Found & Made Owner.",
        },
      );

      server.registerTool(
        "search_recipes",
        {
          annotations: readOnlyAnnotations,
          description:
            "Search approved recipes by text, taxonomy, ingredients, equipment, and time.",
          inputSchema: findSchema,
          title: "Search recipes",
        },
        (args) =>
          executeTool(service, rawToken, {
            arguments: args,
            tool: "search_recipes",
          }),
      );
      server.registerTool(
        "get_recipe",
        {
          annotations: readOnlyAnnotations,
          description: "Retrieve one explicitly approved recipe.",
          inputSchema: z.object({ recipeId: recipeIdSchema }),
          title: "Get recipe",
        },
        (args) =>
          executeTool(service, rawToken, {
            arguments: args,
            tool: "get_recipe",
          }),
      );
      server.registerTool(
        "get_scaled_recipe",
        {
          annotations: readOnlyAnnotations,
          description:
            "Project one approved recipe at a target serving count without modifying it.",
          inputSchema: z.object({
            recipeId: recipeIdSchema,
            targetServings: z.number().positive().max(10_000),
            unitPreference: z.enum(["as-written", "metric"]).optional(),
          }),
          title: "Get scaled recipe",
        },
        (args) =>
          executeTool(service, rawToken, {
            arguments: args,
            tool: "get_scaled_recipe",
          }),
      );
      server.registerTool(
        "list_collections",
        {
          annotations: readOnlyAnnotations,
          description:
            "List collections with recipe membership limited to approved recipes.",
          inputSchema: z.object({}),
          title: "List collections",
        },
        (args) =>
          executeTool(service, rawToken, {
            arguments: args,
            tool: "list_collections",
          }),
      );
      server.registerTool(
        "list_saved_views",
        {
          annotations: readOnlyAnnotations,
          description: "List recipe-library saved views.",
          inputSchema: z.object({}),
          title: "List saved views",
        },
        (args) =>
          executeTool(service, rawToken, {
            arguments: args,
            tool: "list_saved_views",
          }),
      );
      server.registerTool(
        "find_recipes",
        {
          annotations: readOnlyAnnotations,
          description:
            "Find approved recipes by available ingredients, equipment, taxonomy, and time.",
          inputSchema: findSchema,
          title: "Find recipes",
        },
        (args) =>
          executeTool(service, rawToken, {
            arguments: args,
            tool: "find_recipes",
          }),
      );

      return server;
    },
    {
      legacy: "stateless",
    },
  );
}

export function bearerToken(header: string | null | undefined): string {
  const match = /^Bearer ([^\s]+)$/.exec(header ?? "");
  if (!match?.[1]) throw new McpAuthenticationError("Bearer token required");
  return match[1];
}

const readOnlyAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
} as const;

function executeTool(
  service: McpService,
  rawToken: string,
  input: McpToolInput,
) {
  try {
    const result = service.execute(rawToken, input);
    return successfulResult(result);
  } catch (error) {
    return failedResult(safeToolError(error));
  }
}

function successfulResult(result: McpToolResult) {
  return {
    content: [{ text: JSON.stringify(result), type: "text" as const }],
    structuredContent: { result },
  };
}

function failedResult(message: string) {
  return {
    content: [{ text: message, type: "text" as const }],
    isError: true,
  };
}

function safeToolError(error: unknown): string {
  if (error instanceof McpAuthenticationError) return "Authentication failed";
  if (error instanceof McpRateLimitError) return "Rate limit exceeded";
  if (error instanceof McpScopeError)
    return "Token scope does not permit this tool";
  if (error instanceof Error && error.message === "MCP recipe not available") {
    return "Recipe not available";
  }
  return "Tool request failed";
}
