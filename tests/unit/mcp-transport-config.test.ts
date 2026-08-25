import { describe, expect, it } from "vitest";

import {
  mcpTransportConfigFromEnv,
  rejectMcpTransportRequest,
} from "../../src/platform/mcp/mcp-transport-config.server";

describe("MCP transport configuration", () => {
  it("is disabled by default", () => {
    const config = mcpTransportConfigFromEnv({});
    expect(config.enabled).toBe(false);
    expect(config.requestRateLimit).toBe(120);
    expect(
      rejectMcpTransportRequest(config, {
        host: "recipes.example.test",
        origin: "https://hermes.example.test",
        remoteAddress: "10.0.0.5",
      }),
    ).toBe("disabled");
  });

  it("requires explicit hosts and origins when enabled", () => {
    expect(() => mcpTransportConfigFromEnv({ MCP_ENABLED: "true" })).toThrow(
      "MCP_ALLOWED_HOSTS",
    );
    expect(() =>
      mcpTransportConfigFromEnv({
        MCP_ALLOWED_HOSTS: "recipes.example.test",
        MCP_ENABLED: "true",
      }),
    ).toThrow("MCP_ALLOWED_ORIGINS");
  });

  it("accepts only the configured host, origin, and source network", () => {
    const config = mcpTransportConfigFromEnv({
      MCP_ALLOWED_CIDRS: "10.24.0.0/16,2001:db8::/32",
      MCP_ALLOWED_HOSTS: "recipes.example.test,192.0.2.10",
      MCP_ALLOWED_ORIGINS: "https://hermes.example.test",
      MCP_ENABLED: "true",
    });

    expect(
      rejectMcpTransportRequest(config, {
        host: "recipes.example.test:443",
        origin: "https://hermes.example.test",
        remoteAddress: "10.24.8.4",
      }),
    ).toBeNull();
    expect(
      rejectMcpTransportRequest(config, {
        host: "attacker.example.test",
        origin: "https://hermes.example.test",
        remoteAddress: "10.24.8.4",
      }),
    ).toBe("forbidden-host");
    expect(
      rejectMcpTransportRequest(config, {
        host: "recipes.example.test",
        origin: "https://browser.example.test",
        remoteAddress: "10.24.8.4",
      }),
    ).toBe("forbidden-origin");
    expect(
      rejectMcpTransportRequest(config, {
        host: "recipes.example.test",
        origin: "https://hermes.example.test",
        remoteAddress: "203.0.113.10",
      }),
    ).toBe("forbidden-source");
  });

  it("normalizes IPv4-mapped socket addresses", () => {
    const config = mcpTransportConfigFromEnv({
      MCP_ALLOWED_CIDRS: "127.0.0.0/8",
      MCP_ALLOWED_HOSTS: "localhost",
      MCP_ALLOWED_ORIGINS: "http://hermes.local",
      MCP_ENABLED: "true",
    });
    expect(
      rejectMcpTransportRequest(config, {
        host: "localhost:3000",
        origin: "http://hermes.local",
        remoteAddress: "::ffff:127.0.0.1",
      }),
    ).toBeNull();
  });

  it("rejects malformed configuration", () => {
    expect(() =>
      mcpTransportConfigFromEnv({
        MCP_ALLOWED_CIDRS: "10.0.0.0/99",
      }),
    ).toThrow("Invalid MCP allowed CIDR");
    expect(() =>
      mcpTransportConfigFromEnv({
        MCP_ALLOWED_HOSTS: "https://recipes.example.test",
      }),
    ).toThrow("Invalid MCP allowed host");
    expect(() =>
      mcpTransportConfigFromEnv({
        MCP_ALLOWED_ORIGINS: "https://hermes.example.test/path",
      }),
    ).toThrow("Invalid MCP allowed origin");
    expect(() =>
      mcpTransportConfigFromEnv({ MCP_REQUEST_RATE_LIMIT: "0" }),
    ).toThrow("MCP_REQUEST_RATE_LIMIT");
  });
});
