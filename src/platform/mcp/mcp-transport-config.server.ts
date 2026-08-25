import { BlockList, isIP } from "node:net";

export interface McpTransportConfig {
  allowedCidrs: readonly string[];
  allowedHosts: ReadonlySet<string>;
  allowedOrigins: ReadonlySet<string>;
  enabled: boolean;
  requestRateLimit: number;
}

export type McpTransportRejection =
  "disabled" | "forbidden-host" | "forbidden-origin" | "forbidden-source";

export function mcpTransportConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): McpTransportConfig {
  const enabled = parseBoolean(env.MCP_ENABLED, false, "MCP_ENABLED");
  const allowedHosts = new Set(
    commaList(env.MCP_ALLOWED_HOSTS).map(normalizeConfiguredHost),
  );
  const allowedOrigins = new Set(
    commaList(env.MCP_ALLOWED_ORIGINS).map(normalizeConfiguredOrigin),
  );
  const allowedCidrs = commaList(env.MCP_ALLOWED_CIDRS);
  const requestRateLimit = parsePositiveInteger(
    env.MCP_REQUEST_RATE_LIMIT,
    120,
    "MCP_REQUEST_RATE_LIMIT",
  );
  for (const cidr of allowedCidrs) validateCidr(cidr);

  if (enabled && allowedHosts.size === 0) {
    throw new Error("MCP_ALLOWED_HOSTS is required when MCP is enabled");
  }
  if (enabled && allowedOrigins.size === 0) {
    throw new Error("MCP_ALLOWED_ORIGINS is required when MCP is enabled");
  }

  return {
    allowedCidrs,
    allowedHosts,
    allowedOrigins,
    enabled,
    requestRateLimit,
  };
}

export function rejectMcpTransportRequest(
  config: McpTransportConfig,
  input: { host?: string; origin?: string; remoteAddress?: string },
): McpTransportRejection | null {
  if (!config.enabled) return "disabled";

  const host = normalizeRequestHost(input.host);
  if (!host || !config.allowedHosts.has(host)) return "forbidden-host";

  if (!input.origin || !config.allowedOrigins.has(input.origin)) {
    return "forbidden-origin";
  }

  if (
    config.allowedCidrs.length > 0 &&
    (!input.remoteAddress ||
      !isAddressInCidrs(input.remoteAddress, config.allowedCidrs))
  ) {
    return "forbidden-source";
  }

  return null;
}

function commaList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeConfiguredHost(value: string): string {
  if (value.includes("://") || value.includes("/") || value.includes("?")) {
    throw new Error(`Invalid MCP allowed host: ${value}`);
  }
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized) throw new Error("MCP allowed hosts cannot be empty");
  return normalized;
}

function normalizeRequestHost(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(`http://${value}`).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

function normalizeConfiguredOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    if (
      parsed.origin !== value ||
      !["http:", "https:"].includes(parsed.protocol)
    ) {
      throw new Error("Origin must contain only scheme and authority");
    }
    return parsed.origin;
  } catch {
    throw new Error(`Invalid MCP allowed origin: ${value}`);
  }
}

function validateCidr(cidr: string): void {
  const parsed = parseCidr(cidr);
  const list = new BlockList();
  list.addSubnet(parsed.address, parsed.prefix, parsed.family);
}

function isAddressInCidrs(address: string, cidrs: readonly string[]): boolean {
  const normalized = normalizeRemoteAddress(address);
  const family = isIP(normalized);
  if (family === 0) return false;

  const list = new BlockList();
  for (const cidr of cidrs) {
    const parsed = parseCidr(cidr);
    list.addSubnet(parsed.address, parsed.prefix, parsed.family);
  }
  return list.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

function normalizeRemoteAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function parseCidr(cidr: string): {
  address: string;
  family: "ipv4" | "ipv6";
  prefix: number;
} {
  const [address, prefixText, ...extra] = cidr.split("/");
  const version = address ? isIP(address) : 0;
  const prefix = Number(prefixText);
  const maximum = version === 4 ? 32 : version === 6 ? 128 : -1;
  if (
    extra.length > 0 ||
    !address ||
    prefixText === undefined ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > maximum
  ) {
    throw new Error(`Invalid MCP allowed CIDR: ${cidr}`);
  }
  return {
    address,
    family: version === 4 ? "ipv4" : "ipv6",
    prefix,
  };
}

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive whole number`);
  }
  return parsed;
}
