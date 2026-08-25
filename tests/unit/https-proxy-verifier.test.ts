import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");

describe("HTTPS reverse-proxy verifier contract", () => {
  it("uses a trusted ephemeral CA and exercises the production topology in CI", async () => {
    const [verifier, workflow] = await Promise.all([
      readFile(resolve(root, "scripts/verify-https-proxy.mjs"), "utf8"),
      readFile(resolve(root, ".github/workflows/ci.yml"), "utf8"),
    ]);

    expect(verifier).toContain('from "selfsigned"');
    expect(verifier).toContain("rejectUnauthorized: true");
    expect(verifier).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
    expect(verifier).not.toContain("rejectUnauthorized: false");
    expect(verifier).toContain("TRUSTED_PROXY_RANGES");
    expect(verifier).toContain("SameSite=Lax");
    expect(verifier).toContain("strict-transport-security");
    expect(verifier).toContain("Cross-site request blocked");
    expect(verifier).toContain(
      "proxy did not overwrite spoofed forwarding headers",
    );
    expect(verifier).toContain("await stopBackend(backend)");
    expect(verifier).toContain("await closeServer(proxy)");
    expect(workflow).toContain("npm run verify:https-proxy");
  });
});
