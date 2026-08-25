import { describe, expect, it } from "vitest";

import { libraryResultView } from "../../app/routes/exports-index";
import {
  downloadHeaders,
  individualExportOptions,
} from "../../app/routes/exports-recipe";

describe("export route boundaries", () => {
  it("parses exact serving and unit projection options", () => {
    const form = new FormData();
    form.set("targetYield", "12");
    form.set("unitPreference", "metric");
    expect(individualExportOptions(form)).toEqual({
      targetYield: 12,
      unitPreference: "metric",
    });

    const defaults = new FormData();
    expect(individualExportOptions(defaults)).toEqual({
      unitPreference: "as-written",
    });
  });

  it("rejects invalid target servings before generating an artifact", () => {
    const form = new FormData();
    form.set("targetYield", "-2");
    expect(() => individualExportOptions(form)).toThrow("positive");
  });

  it("serves downloads as private attachments with a constrained opaque name", () => {
    const headers = new Headers(
      downloadHeaders("recipe-00000000-0000-4000-8000-000000000001.json"),
    );
    expect(headers.get("cache-control")).toBe("private, no-store");
    expect(headers.get("content-disposition")).toBe(
      'attachment; filename="recipe-00000000-0000-4000-8000-000000000001.json"',
    );
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(() => downloadHeaders('recipe-safe.json"\r\nX-Leak: yes')).toThrow(
      "invalid",
    );
  });

  it("whitelists library result metadata and cannot expose a filesystem path", () => {
    const view = libraryResultView({
      artifactName: "library-00000000-0000-4000-8000-000000000001",
      fileCount: 8,
      manifest: {
        path: "manifest.json",
        sha256: "a".repeat(64),
        size: 2048,
      },
    });
    expect(view).toEqual({
      artifactName: "library-00000000-0000-4000-8000-000000000001",
      fileCount: 8,
      manifestSha256: "a".repeat(64),
    });
    expect(JSON.stringify(view)).not.toMatch(/(?:absolute|path|\\|\/data\/)/i);
  });
});
