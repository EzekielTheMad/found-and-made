import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
  readImportUpload,
  removeImportUpload,
  storeImportUpload,
} from "#src/platform/files/import-upload.server";
import {
  ensureDataPaths,
  resolveDataPaths,
} from "#src/platform/files/data-paths.server";

describe("import upload storage", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    for (const directory of cleanup.splice(0)) {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("magic-checks and stores an opaque reference under the data root", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "found-made-import-upload-"),
    );
    cleanup.push(directory);
    const paths = resolveDataPaths(directory);
    await ensureDataPaths(paths);
    const bytes = await sharp({
      create: {
        background: "#934d32",
        channels: 3,
        height: 16,
        width: 16,
      },
    })
      .png()
      .toBuffer();

    const stored = await storeImportUpload(
      paths,
      new File([bytes], "private source name.png", { type: "image/png" }),
    );

    expect(stored.mimeType).toBe("image/png");
    expect(stored.storageRef).toMatch(/^[a-f0-9-]+\.png$/);
    expect(
      Buffer.from(await readImportUpload(paths, stored.storageRef)),
    ).toEqual(bytes);
    expect(await readFile(join(paths.imports, stored.storageRef))).toEqual(
      bytes,
    );
    await removeImportUpload(paths, stored.storageRef);
    await expect(
      readFile(join(paths.imports, stored.storageRef)),
    ).rejects.toThrow();
  });

  it("rejects storage references that could escape the import directory", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "found-made-import-upload-"),
    );
    cleanup.push(directory);
    const paths = resolveDataPaths(directory);
    await ensureDataPaths(paths);

    await expect(readImportUpload(paths, "../app.db")).rejects.toThrow(
      "Invalid import storage reference",
    );
  });

  it("rejects a claimed image whose bytes are not an allowed file", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "found-made-import-upload-"),
    );
    cleanup.push(directory);
    const paths = resolveDataPaths(directory);
    await ensureDataPaths(paths);

    await expect(
      storeImportUpload(
        paths,
        new File(["not an image"], "spoofed.png", { type: "image/png" }),
      ),
    ).rejects.toThrow("Unsupported import file type");
  });
});
