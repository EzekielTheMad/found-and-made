import { describe, expect, it } from "vitest";

import { McpRequestLimiter } from "../../src/platform/mcp/mcp-request-limiter.server";

describe("MCP request limiter", () => {
  it("limits every authenticated protocol request and resets by window", () => {
    const limiter = new McpRequestLimiter(2, 1_000);
    expect(limiter.consume("token", 100).allowed).toBe(true);
    expect(limiter.consume("token", 200).allowed).toBe(true);
    expect(limiter.consume("token", 300)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1,
    });
    expect(limiter.consume("token", 1_100).allowed).toBe(true);
  });

  it("isolates token subjects", () => {
    const limiter = new McpRequestLimiter(1);
    expect(limiter.consume("one", 100).allowed).toBe(true);
    expect(limiter.consume("one", 200).allowed).toBe(false);
    expect(limiter.consume("two", 200).allowed).toBe(true);
  });
});
