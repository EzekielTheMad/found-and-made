import { parse } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDataPaths } from "#src/platform/files/data-paths.server";

describe("resolveDataPaths", () => {
  it("rejects a filesystem root", () => {
    expect(() => resolveDataPaths(parse(process.cwd()).root)).toThrow(
      "dedicated non-root directory",
    );
  });

  it("keeps every durable path below the configured root", () => {
    const paths = resolveDataPaths(".data-test");
    const durablePaths: string[] = [
      paths.backups,
      paths.db,
      paths.exports,
      paths.imports,
      paths.keys,
      paths.mediaOriginals,
      paths.mediaWeb,
      paths.print,
      paths.root,
    ];
    for (const path of durablePaths) {
      expect(path.startsWith(paths.root)).toBe(true);
    }
  });
});
