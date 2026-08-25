import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");

describe("container contract", () => {
  it("packages the built server, migrations, and production dependencies", async () => {
    const dockerfile = await readFile(resolve(root, "Dockerfile"), "utf8");

    expect(dockerfile).toContain("FROM node:24-bookworm-slim");
    expect(dockerfile).toContain("npm prune --omit=dev");
    expect(dockerfile).toContain("COPY --from=build /app/build ./build");
    expect(dockerfile).toContain("COPY drizzle ./drizzle");
    expect(dockerfile).toContain("COPY server.js ./");
    expect(dockerfile).toContain(
      "sed -i 's/\\r$//' /usr/local/bin/docker-entrypoint",
    );
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini"');
    expect(dockerfile).toContain('CMD ["node", "server.js"]');
    expect(dockerfile).toContain("/health/ready");
  });

  it("drops privileges without recursively changing the mounted volume", async () => {
    const entrypoint = await readFile(
      resolve(root, "docker-entrypoint.sh"),
      "utf8",
    );

    expect(entrypoint).toContain('validate_id "${PUID:-}" PUID');
    expect(entrypoint).toContain('validate_id "${PGID:-}" PGID');
    expect(entrypoint).toContain("DATA_DIR must be an absolute");
    expect(entrypoint).toContain('exec gosu "$PUID:$PGID" "$@"');
    expect(entrypoint).not.toContain("\r");
    expect(entrypoint).not.toMatch(/\bchown\s+-R\b/);
  });

  it("keeps generated and private runtime state out of the image context", async () => {
    const dockerignore = await readFile(resolve(root, ".dockerignore"), "utf8");

    expect(dockerignore).toMatch(/^\.data$/m);
    expect(dockerignore).toMatch(/^design_handoff_found_and_made$/m);
    expect(dockerignore).toMatch(/^\.git$/m);
    expect(dockerignore).toMatch(/^node_modules$/m);
  });
});
