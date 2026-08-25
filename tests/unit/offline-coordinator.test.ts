import { afterEach, describe, expect, it } from "vitest";

import { cacheProtectedUrls } from "../../app/components/offline-coordinator";

describe("offline coordinator browser boundary", () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );

  afterEach(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
  });

  it("fails closed when plain HTTP does not expose a service worker", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { onLine: true },
    });

    await expect(
      cacheProtectedUrls(["/api/offline/library"]),
    ).resolves.toMatchObject({
      error: "Offline worker is unavailable",
      ok: false,
    });
  });
});
