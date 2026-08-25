import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import type { Principal } from "#src/modules/identity/identity.types";
import { createRuntime, type AppRuntime } from "#src/platform/runtime.server";
import { fourServingRecipe } from "../fixtures/four-serving-recipe";

const editor: Principal = { kind: "user", role: "editor", userId: "editor" };
const viewer: Principal = { kind: "user", role: "viewer", userId: "viewer" };

describe("media application service", () => {
  const cleanup: Array<{ directory: string; runtime: AppRuntime }> = [];

  afterEach(async () => {
    for (const item of cleanup.splice(0)) {
      await item.runtime.close();
      await rm(item.directory, { force: true, recursive: true });
    }
  });

  it("magic-checks, bounds, sanitizes EXIF, and creates durable derivatives", async () => {
    const { runtime } = await runtimeFixture();
    const recipe = runtime.recipeService.create(fourServingRecipe());
    const source = await sharp({
      create: {
        background: { alpha: 1, b: 30, g: 90, r: 180 },
        channels: 4,
        height: 600,
        width: 800,
      },
    })
      .jpeg()
      .withExif({ IFD0: { Artist: "Private source metadata" } })
      .toBuffer();

    const asset = await runtime.mediaService.upload(editor, {
      altText: "A finished lasagna in a baking dish",
      bytes: source,
      caption: "Sunday dinner",
      recipeId: recipe.id,
      role: "hero",
    });
    const original = runtime.mediaService.file(asset.id, "original");
    const web = runtime.mediaService.file(asset.id, "web");
    const social = runtime.mediaService.file(asset.id, "social");
    const originalMetadata = await sharp(
      await readFile(original.path),
    ).metadata();
    const webMetadata = await sharp(await readFile(web.path)).metadata();
    const socialMetadata = await sharp(await readFile(social.path)).metadata();

    expect(original.contentType).toBe("image/jpeg");
    expect(originalMetadata.exif).toBeUndefined();
    expect(originalMetadata.width).toBe(800);
    expect(webMetadata.exif).toBeUndefined();
    expect(webMetadata.format).toBe("webp");
    expect(socialMetadata).toMatchObject({
      format: "webp",
      height: 630,
      width: 1200,
    });
    expect(asset.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("re-encodes polyglot input and rejects oversized pixel dimensions", async () => {
    const { runtime } = await runtimeFixture();
    const recipe = runtime.recipeService.create(fourServingRecipe());
    const png = await sharp({
      create: {
        background: "#355f42",
        channels: 3,
        height: 16,
        width: 16,
      },
    })
      .png()
      .toBuffer();
    const marker = Buffer.from("<script>private-polyglot-marker</script>");
    const asset = await runtime.mediaService.upload(editor, {
      altText: "A green square",
      bytes: Buffer.concat([png, marker]),
      recipeId: recipe.id,
      role: "gallery",
    });
    const sanitized = await readFile(
      runtime.mediaService.file(asset.id, "original").path,
    );
    expect(sanitized.indexOf(marker)).toBe(-1);

    const pixelBomb = Buffer.from(png);
    pixelBomb.writeUInt32BE(100_000, 16);
    pixelBomb.writeUInt32BE(100_000, 20);
    pixelBomb.writeUInt32BE(crc32(pixelBomb.subarray(12, 29)), 29);
    await expect(
      runtime.mediaService.upload(editor, {
        altText: "Oversized dimensions",
        bytes: pixelBomb,
        recipeId: recipe.id,
        role: "gallery",
      }),
    ).rejects.toThrow();
    expect(runtime.mediaService.list(editor, recipe.id)).toHaveLength(1);
  });

  it("rejects unauthorized and non-image uploads before persistence", async () => {
    const { runtime } = await runtimeFixture();
    const recipe = runtime.recipeService.create(fourServingRecipe());
    await expect(
      runtime.mediaService.upload(viewer, {
        altText: "Not allowed",
        bytes: Buffer.from("not an image"),
        recipeId: recipe.id,
        role: "hero",
      }),
    ).rejects.toThrow("authorized");
    await expect(
      runtime.mediaService.upload(editor, {
        altText: "Not an image",
        bytes: Buffer.from("not an image"),
        recipeId: recipe.id,
        role: "hero",
      }),
    ).rejects.toThrow("Only JPEG");
    expect(runtime.mediaService.list(editor, recipe.id)).toEqual([]);
  });

  it("replaces a hero and removes only the superseded files", async () => {
    const { runtime } = await runtimeFixture();
    const recipe = runtime.recipeService.create(fourServingRecipe());
    const bytes = await sharp({
      create: {
        background: "#8b3f2f",
        channels: 3,
        height: 80,
        width: 120,
      },
    })
      .png()
      .toBuffer();
    const first = await runtime.mediaService.upload(editor, {
      altText: "First hero",
      bytes,
      recipeId: recipe.id,
      role: "hero",
    });
    const firstPaths = (["original", "web", "social"] as const).map(
      (variant) => runtime.mediaService.file(first.id, variant).path,
    );
    const second = await runtime.mediaService.upload(editor, {
      altText: "Second hero",
      bytes,
      recipeId: recipe.id,
      role: "hero",
    });
    expect(runtime.mediaService.hero(recipe.id)?.id).toBe(second.id);
    for (const path of firstPaths) await expect(access(path)).rejects.toThrow();
  });

  it("updates accessible metadata, ordering, and focal crop atomically", async () => {
    const { runtime } = await runtimeFixture();
    const recipe = runtime.recipeService.create(fourServingRecipe());
    const bytes = await sharp({
      create: {
        background: "#315a3d",
        channels: 3,
        height: 400,
        width: 1200,
      },
    })
      .png()
      .toBuffer();
    const asset = await runtime.mediaService.upload(editor, {
      altText: "Original description",
      bytes,
      recipeId: recipe.id,
      role: "gallery",
    });
    const previousSocial = runtime.mediaService.file(asset.id, "social").path;

    await expect(
      runtime.mediaService.update(viewer, asset.id, {
        altText: "Unauthorized change",
        focalX: 0,
        focalY: 0,
        position: 0,
      }),
    ).rejects.toThrow("authorized");
    const updated = await runtime.mediaService.update(editor, asset.id, {
      altText: "A green serving platter",
      caption: "Centered on the plated dish",
      focalX: 80,
      focalY: 25,
      position: 4,
    });

    expect(updated).toMatchObject({
      altText: "A green serving platter",
      caption: "Centered on the plated dish",
      focalX: 80,
      focalY: 25,
      position: 4,
    });
    expect(runtime.mediaService.file(asset.id, "social").path).not.toBe(
      previousSocial,
    );
    await expect(access(previousSocial)).rejects.toThrow();
  });

  it("removes the row and only its exact derivative files", async () => {
    const { runtime } = await runtimeFixture();
    const recipe = runtime.recipeService.create(fourServingRecipe());
    const bytes = await sharp({
      create: {
        background: "#6f3b2b",
        channels: 3,
        height: 80,
        width: 120,
      },
    })
      .png()
      .toBuffer();
    const keep = await runtime.mediaService.upload(editor, {
      altText: "Keep this image",
      bytes,
      recipeId: recipe.id,
      role: "gallery",
    });
    const remove = await runtime.mediaService.upload(editor, {
      altText: "Remove this image",
      bytes,
      recipeId: recipe.id,
      role: "gallery",
    });
    const removedPaths = (["original", "web", "social"] as const).map(
      (variant) => runtime.mediaService.file(remove.id, variant).path,
    );
    const keptPath = runtime.mediaService.file(keep.id, "web").path;

    await expect(
      runtime.mediaService.remove(viewer, remove.id),
    ).rejects.toThrow("authorized");
    await runtime.mediaService.remove(editor, remove.id);

    expect(
      runtime.mediaService.list(editor, recipe.id).map((item) => item.id),
    ).toEqual([keep.id]);
    for (const path of removedPaths)
      await expect(access(path)).rejects.toThrow();
    await expect(access(keptPath)).resolves.toBeUndefined();
  });

  async function runtimeFixture() {
    const directory = await mkdtemp(join(tmpdir(), "found-made-media-"));
    const item = {
      directory,
      runtime: await createRuntime({ dataDir: directory, startWorker: false }),
    };
    cleanup.push(item);
    return item;
  }
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
