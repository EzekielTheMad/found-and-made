import { describe, expect, it } from "vitest";

import {
  classifyOfflineRequest,
  GLOBAL_ASSET_CACHE,
  offlineNavigationTarget,
  protectedCacheName,
  protectedCacheNames,
  recoverProtectedCacheName,
  transitionProtectedContext,
} from "#src/modules/offline/offline-policy";

describe("offline cache policy", () => {
  it("keeps app assets global while protecting user snapshots and media", () => {
    expect(classifyOfflineRequest("GET", "/assets/app-abc.js")).toBe(
      "global-asset",
    );
    expect(classifyOfflineRequest("GET", "/manifest.webmanifest")).toBe(
      "global-asset",
    );
    expect(classifyOfflineRequest("GET", "/api/offline/library")).toBe(
      "protected-opt-in",
    );
    expect(
      classifyOfflineRequest("GET", "/api/offline/recipes/recipe-12345678"),
    ).toBe("protected-opt-in");
    expect(classifyOfflineRequest("GET", "/api/media/media-12345678/web")).toBe(
      "protected-opt-in",
    );
    expect(classifyOfflineRequest("GET", "/recipes/recipe-12345678")).toBe(
      "network-only",
    );
    expect(classifyOfflineRequest("POST", "/api/offline/library")).toBe(
      "network-only",
    );
  });

  it("hashes opaque account partitions rather than exposing them in cache names", async () => {
    const partitionKey = "opaque-account-partition-123456789";
    const name = await protectedCacheName(partitionKey);
    expect(name).not.toContain(partitionKey);
    expect(name).not.toBe(GLOBAL_ASSET_CACHE);
    await expect(protectedCacheName("too-short")).rejects.toThrow("opaque");
  });

  it("purges the old protected namespace on logout and account switch", async () => {
    const first = "opaque-account-partition-first";
    const second = "opaque-account-partition-second";
    const firstName = await protectedCacheName(first);
    const secondName = await protectedCacheName(second);

    await expect(transitionProtectedContext(first, null)).resolves.toEqual({
      nextCacheName: null,
      purgeCacheNames: [firstName],
    });
    await expect(transitionProtectedContext(first, second)).resolves.toEqual({
      nextCacheName: secondName,
      purgeCacheNames: [firstName],
    });
    await expect(transitionProtectedContext(first, first)).resolves.toEqual({
      nextCacheName: firstName,
      purgeCacheNames: [],
    });
  });

  it("selects only protected namespaces for an all-user purge", () => {
    expect(
      protectedCacheNames([
        GLOBAL_ASSET_CACHE,
        "found-made-protected-v1-a",
        "unrelated-cache",
        "found-made-protected-v1-b",
      ]),
    ).toEqual(["found-made-protected-v1-a", "found-made-protected-v1-b"]);
  });

  it("recovers a sole account namespace after a service-worker restart", () => {
    expect(
      recoverProtectedCacheName([
        GLOBAL_ASSET_CACHE,
        "found-made-protected-v1-current",
      ]),
    ).toBe("found-made-protected-v1-current");
    expect(recoverProtectedCacheName([GLOBAL_ASSET_CACHE])).toBeNull();
    expect(() =>
      recoverProtectedCacheName([
        "found-made-protected-v1-first",
        "found-made-protected-v1-second",
      ]),
    ).toThrow("ambiguous");
  });

  it("routes only the offline library and recipe documents to cached data", () => {
    expect(offlineNavigationTarget("/")).toEqual({ kind: "library" });
    expect(offlineNavigationTarget("/recipes/recipe-12345678")).toEqual({
      kind: "recipe",
      recipeId: "recipe-12345678",
    });
    expect(offlineNavigationTarget("/admin")).toEqual({ kind: "unavailable" });
  });
});
