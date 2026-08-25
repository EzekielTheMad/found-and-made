export const OFFLINE_CACHE_VERSION = "v1";
export const GLOBAL_ASSET_CACHE = `found-made-global-${OFFLINE_CACHE_VERSION}`;
export const PROTECTED_CACHE_PREFIX = `found-made-protected-${OFFLINE_CACHE_VERSION}-`;

export type OfflineRequestPolicy =
  "global-asset" | "network-only" | "protected-opt-in";

const GLOBAL_ASSET_PATHS = new Set([
  "/manifest.webmanifest",
  "/offline.html",
  "/icons/icon.svg",
  "/icons/maskable-icon.svg",
]);

const PROTECTED_PATH_PREFIXES = ["/api/media/", "/api/offline/recipes/"];

const PROTECTED_EXACT_PATHS = new Set(["/api/offline/library"]);

export function classifyOfflineRequest(
  method: string,
  path: string,
): OfflineRequestPolicy {
  if (method.toUpperCase() !== "GET") {
    return "network-only";
  }

  const normalizedPath = path.split("?", 1)[0] ?? path;
  if (
    GLOBAL_ASSET_PATHS.has(normalizedPath) ||
    normalizedPath.startsWith("/assets/")
  ) {
    return "global-asset";
  }

  if (
    PROTECTED_EXACT_PATHS.has(normalizedPath) ||
    PROTECTED_PATH_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix))
  ) {
    return "protected-opt-in";
  }

  return "network-only";
}

export function isServerApprovedForOfflineCache(headers: Headers): boolean {
  return headers.get("x-found-made-offline-cache")?.toLowerCase() === "allowed";
}

async function digestScope(partitionKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(partitionKey);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 24);
}

export async function protectedCacheName(
  partitionKey: string,
): Promise<string> {
  if (partitionKey.trim().length < 16) {
    throw new Error(
      "Offline partition keys must be opaque and at least 16 characters.",
    );
  }

  return `${PROTECTED_CACHE_PREFIX}${await digestScope(partitionKey)}`;
}

export interface ProtectedContextTransition {
  readonly nextCacheName: string | null;
  readonly purgeCacheNames: readonly string[];
}

export async function transitionProtectedContext(
  previousPartitionKey: string | null,
  nextPartitionKey: string | null,
): Promise<ProtectedContextTransition> {
  const previousCacheName = previousPartitionKey
    ? await protectedCacheName(previousPartitionKey)
    : null;
  const nextCacheName = nextPartitionKey
    ? await protectedCacheName(nextPartitionKey)
    : null;

  return {
    nextCacheName,
    purgeCacheNames:
      previousCacheName && previousCacheName !== nextCacheName
        ? [previousCacheName]
        : [],
  };
}

export function protectedCacheNames(cacheNames: readonly string[]): string[] {
  return cacheNames.filter((name) => name.startsWith(PROTECTED_CACHE_PREFIX));
}

export function recoverProtectedCacheName(
  cacheNames: readonly string[],
): string | null {
  const protectedNames = protectedCacheNames(cacheNames);
  if (protectedNames.length > 1) {
    throw new Error(
      "Offline account context is ambiguous and must be re-authenticated.",
    );
  }
  return protectedNames[0] ?? null;
}

export type OfflineNavigationTarget =
  | { readonly kind: "library" }
  | { readonly kind: "recipe"; readonly recipeId: string }
  | { readonly kind: "unavailable" };

export function offlineNavigationTarget(path: string): OfflineNavigationTarget {
  if (path === "/") {
    return { kind: "library" };
  }
  const match = /^\/recipes\/([A-Za-z0-9][A-Za-z0-9._:-]{7,127})\/?$/.exec(
    path,
  );
  if (match?.[1]) {
    return { kind: "recipe", recipeId: match[1] };
  }
  return { kind: "unavailable" };
}
