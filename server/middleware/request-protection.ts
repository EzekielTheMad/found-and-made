import type { Express, Request, RequestHandler } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const AUTH_PATHS = [
  "/api/auth",
  "/forgot-password",
  "/invite/",
  "/recover/",
  "/setup",
  "/sign-in",
  "/sign-out",
] as const;
const HEAVY_MUTATION_PATHS = ["/cookbooks", "/exports", "/imports"] as const;
const HEAVY_READ_PATHS = [
  "/cookbooks/jobs/",
  "/exports/recipes/",
  "/public/media/",
] as const;

export interface RequestLimit {
  max: number;
  windowMs: number;
}

export interface RequestProtectionOptions {
  limits?: Partial<Record<RateLimitPolicy, RequestLimit>>;
  now?: () => number;
  publicOrigin: string;
}

type RateLimitPolicy = "auth" | "heavy" | "media" | "mutation";

const DEFAULT_LIMITS: Record<RateLimitPolicy, RequestLimit> = {
  auth: { max: 10, windowMs: 60_000 },
  heavy: { max: 20, windowMs: 60_000 },
  media: { max: 300, windowMs: 60_000 },
  mutation: { max: 120, windowMs: 60_000 },
};

export function configureTrustedProxy(
  app: Express,
  raw = process.env.TRUSTED_PROXY_RANGES,
): void {
  if (!raw) return;
  const ranges = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    ranges.length === 0 ||
    ranges.some((value) =>
      ["*", "true", "false", "0"].includes(value.toLowerCase()),
    )
  ) {
    throw new Error(
      "TRUSTED_PROXY_RANGES must contain explicit proxy addresses or CIDR ranges",
    );
  }
  app.set("trust proxy", ranges);
}

export function createRequestProtection({
  limits = {},
  now = Date.now,
  publicOrigin,
}: RequestProtectionOptions): RequestHandler {
  const normalizedOrigin = exactOrigin(publicOrigin);
  const limiters = new Map<RateLimitPolicy, FixedWindowLimiter>();
  for (const policy of Object.keys(DEFAULT_LIMITS) as RateLimitPolicy[]) {
    const limit = limits[policy] ?? DEFAULT_LIMITS[policy];
    limiters.set(policy, new FixedWindowLimiter(limit, now));
  }

  return (request, response, next) => {
    if (request.path === "/mcp") return next();

    if (
      isUnsafeMethod(request) &&
      !isBetterAuthPath(request.path) &&
      !isTrustedBrowserMutation(request, normalizedOrigin)
    ) {
      response.set("Cache-Control", "no-store");
      response.status(403).type("application/problem+json").json({
        status: 403,
        title: "Cross-site request blocked",
        type: "about:blank",
      });
      return;
    }

    const policy = rateLimitPolicy(request);
    if (!policy) return next();
    const limiter = limiters.get(policy)!;
    const result = limiter.consume(`${policy}:${clientAddress(request)}`);
    if (result.allowed) return next();

    response.set({
      "Cache-Control": "no-store",
      "Retry-After": String(result.retryAfterSeconds),
    });
    response.status(429).type("application/problem+json").json({
      status: 429,
      title: "Too many requests",
      type: "about:blank",
    });
  };
}

function isTrustedBrowserMutation(
  request: Request,
  publicOrigin: string,
): boolean {
  const fetchSite = request.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site") return false;
  if (
    fetchSite &&
    fetchSite !== "same-origin" &&
    fetchSite !== "same-site" &&
    fetchSite !== "none"
  ) {
    return false;
  }

  const origin = request.get("origin");
  if (origin) return origin === publicOrigin;
  return fetchSite === "same-origin";
}

function rateLimitPolicy(request: Request): RateLimitPolicy | undefined {
  if (isUnsafeMethod(request) && isBetterAuthPath(request.path)) return "auth";
  if (
    isUnsafeMethod(request) &&
    AUTH_PATHS.some((path) => matchesPath(request.path, path))
  ) {
    return "auth";
  }
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    request.path.startsWith("/api/media/")
  ) {
    return "media";
  }
  if (
    (isUnsafeMethod(request) &&
      (HEAVY_MUTATION_PATHS.some((path) => matchesPath(request.path, path)) ||
        /^\/recipes\/[^/]+\/media(?:\/|$)/.test(request.path))) ||
    ((request.method === "GET" || request.method === "HEAD") &&
      HEAVY_READ_PATHS.some((path) => request.path.startsWith(path)))
  ) {
    return "heavy";
  }
  return isUnsafeMethod(request) ? "mutation" : undefined;
}

function isBetterAuthPath(path: string): boolean {
  return matchesPath(path, "/api/auth");
}

function isUnsafeMethod(request: Request): boolean {
  return !SAFE_METHODS.has(request.method);
}

function matchesPath(candidate: string, prefix: string): boolean {
  if (prefix.endsWith("/")) return candidate.startsWith(prefix);
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function clientAddress(request: Request): string {
  return request.ip || request.socket.remoteAddress || "unknown";
}

function exactOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.origin !== value) {
    throw new Error("Request protection requires a normalized public origin");
  }
  return parsed.origin;
}

class FixedWindowLimiter {
  private readonly entries = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private readonly maxEntries = 10_000;

  constructor(
    private readonly limit: RequestLimit,
    private readonly now: () => number,
  ) {
    if (
      !Number.isSafeInteger(limit.max) ||
      limit.max < 1 ||
      !Number.isSafeInteger(limit.windowMs) ||
      limit.windowMs < 1
    ) {
      throw new Error("HTTP rate limits must be positive whole numbers");
    }
  }

  consume(
    key: string,
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const timestamp = this.now();
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= timestamp) {
      if (!entry && this.entries.size >= this.maxEntries) {
        this.removeExpired(timestamp);
        if (this.entries.size >= this.maxEntries) {
          return {
            allowed: false,
            retryAfterSeconds: Math.max(
              1,
              Math.ceil(this.limit.windowMs / 1_000),
            ),
          };
        }
      }
      entry = { count: 0, resetAt: timestamp + this.limit.windowMs };
      this.entries.set(key, entry);
    }
    entry.count += 1;
    if (entry.count <= this.limit.max) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((entry.resetAt - timestamp) / 1_000),
      ),
    };
  }

  private removeExpired(timestamp: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= timestamp) this.entries.delete(key);
    }
  }
}
