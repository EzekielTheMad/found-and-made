import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { BackupService } from "#src/modules/backup/backup.service.server";
import { createRuntime, type AppRuntime } from "#src/platform/runtime.server";
import { fourServingRecipe } from "../fixtures/four-serving-recipe";

describe("online backup and cold restore", () => {
  const cleanup: Array<{ directory: string; runtime?: AppRuntime }> = [];

  afterEach(async () => {
    for (const item of cleanup.splice(0)) {
      await item.runtime?.close();
      await rm(item.directory, { force: true, recursive: true });
    }
  });

  it("creates an atomic online snapshot, restores it into an empty root, and reopens durable state", async () => {
    const source = await runtimeFixture("found-made-backup-source-");
    seedUser(source.runtime, "owner", "owner");
    seedUser(source.runtime, "viewer", "viewer");
    const owner = {
      kind: "user",
      role: "owner",
      userId: "owner",
    } as const;
    const recipe = source.runtime.recipeService.create(fourServingRecipe());
    const view = source.runtime.discoveryService.createSavedView(
      { kind: "user", role: "viewer", userId: "viewer" },
      { criteria: { search: "lasagna" }, name: "My kitchen" },
    );
    const media = await source.runtime.mediaService.upload(owner, {
      altText: "Restorable lasagna",
      bytes: await sharp({
        create: {
          background: "#8b3f2f",
          channels: 3,
          height: 120,
          width: 160,
        },
      })
        .jpeg()
        .toBuffer(),
      recipeId: recipe.id,
      role: "hero",
    });
    source.runtime.mcpService.setRecipeApproval(owner, recipe.id, true);
    const mcpToken = source.runtime.mcpService.issueToken(owner, {
      name: "Restore Hermes",
      scopes: ["recipes:read"],
    });
    const profile = source.runtime.printingService.createProfile(owner, {
      config: {
        defaultLayout: "classic-single-column",
        duplex: true,
        includeMetadata: true,
        includePhotos: true,
        marginsMm: { bottom: 12, left: 12, right: 12, top: 12 },
        pageSize: "letter",
        typography: {
          bodyFontSizePt: 10,
          fontFamily: "Source Serif 4",
          headingFontSizePt: 20,
        },
      },
      name: "Restore profile",
    });
    await writeFile(
      join(source.runtime.dataPaths.imports, "source.txt"),
      "import state",
    );
    await writeFile(
      join(source.runtime.dataPaths.exports, "library.json"),
      "export state",
    );
    await writeFile(
      join(source.runtime.dataPaths.mediaOriginals, "hero.jpg"),
      "original media",
    );
    await writeFile(
      join(source.runtime.dataPaths.mediaWeb, "hero.webp"),
      "web media",
    );
    await writeFile(
      join(source.runtime.dataPaths.print, "profile.json"),
      "print profile state",
    );

    const service = new BackupService(
      source.runtime.dataPaths,
      source.runtime.database.sqlite,
    );
    const backup = await service.createOnlineBackup(
      new Date("2026-07-31T12:00:00.000Z"),
    );
    expect(backup.manifest.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "db/found-and-made.sqlite",
        "exports/library.json",
        "imports/source.txt",
        "keys/instance.key",
        "media/originals/hero.jpg",
        "media/web/hero.webp",
        "print/profile.json",
      ]),
    );
    await expect(service.verify(backup.directory)).resolves.toEqual(
      backup.manifest,
    );

    const targetDirectory = await mkdtemp(
      join(tmpdir(), "found-made-backup-restore-"),
    );
    cleanup.push({ directory: targetDirectory });
    await service.restore(backup.directory, targetDirectory);
    const restored = await createRuntime({
      dataDir: targetDirectory,
      startWorker: false,
    });
    cleanup.find((item) => item.directory === targetDirectory)!.runtime =
      restored;
    expect(restored.recipeService.get(recipe.id)).toMatchObject({
      title: recipe.title,
    });
    expect(
      restored.discoveryService
        .listSavedViews({ kind: "user", role: "viewer", userId: "viewer" })
        .map((item) => item.id),
    ).toContain(view.id);
    expect(restored.identityService.principalForUser("owner")).toEqual(owner);
    expect(restored.mcpService.authenticateToken(mcpToken.token).token.id).toBe(
      mcpToken.id,
    );
    expect(restored.mcpService.listApprovedRecipeIds(owner)).toContain(
      recipe.id,
    );
    expect(restored.printingService.getProfile(owner, profile.id).name).toBe(
      "Restore profile",
    );
    expect(restored.mediaService.get(owner, media.id).recipeId).toBe(recipe.id);
    await expect(
      readFile(restored.mediaService.file(media.id, "original").path),
    ).resolves.toBeInstanceOf(Buffer);
    await expect(
      readFile(join(restored.dataPaths.print, "profile.json"), "utf8"),
    ).resolves.toBe("print profile state");
  });

  it("rejects tampered manifests and artifacts without overwriting a target", async () => {
    const source = await runtimeFixture("found-made-backup-tamper-");
    const service = new BackupService(
      source.runtime.dataPaths,
      source.runtime.database.sqlite,
    );
    const backup = await service.createOnlineBackup();
    await writeFile(join(backup.directory, "imports", "tampered.txt"), "extra");
    await expect(service.verify(backup.directory)).rejects.toThrow(
      "artifacts do not match",
    );

    const second = await service.createOnlineBackup();
    await writeFile(
      join(second.directory, "manifest.json"),
      JSON.stringify({
        files: [{ path: "../escape", sha256: "0".repeat(64), size: 0 }],
        version: 1,
      }),
    );
    await expect(service.verify(second.directory)).rejects.toThrow(
      "manifest is invalid",
    );

    const nonemptyTarget = await mkdtemp(
      join(tmpdir(), "found-made-backup-nonempty-"),
    );
    cleanup.push({ directory: nonemptyTarget });
    await writeFile(join(nonemptyTarget, "keep.txt"), "do not overwrite");
    await expect(
      service.restore(backup.directory, nonemptyTarget),
    ).rejects.toThrow();
    await expect(
      readFile(join(nonemptyTarget, "keep.txt"), "utf8"),
    ).resolves.toBe("do not overwrite");
  });

  it("aborts an online generation when durable files change across the database snapshot", async () => {
    const source = await runtimeFixture("found-made-backup-changing-");
    const changingPath = join(source.runtime.dataPaths.imports, "changing.txt");
    await writeFile(changingPath, "before");
    const sqlite = source.runtime.database.sqlite;
    const originalBackup = sqlite.backup.bind(sqlite);
    Object.defineProperty(sqlite, "backup", {
      configurable: true,
      value: async (...args: Parameters<typeof sqlite.backup>) => {
        const result = await originalBackup(...args);
        await writeFile(changingPath, "changed after database snapshot");
        return result;
      },
    });
    const service = new BackupService(source.runtime.dataPaths, sqlite);

    await expect(service.createOnlineBackup()).rejects.toThrow(
      "Durable files changed",
    );
    expect(await readdir(source.runtime.dataPaths.backups)).toEqual([]);
  });

  async function runtimeFixture(prefix: string) {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    const runtime = await createRuntime({
      dataDir: directory,
      startWorker: false,
    });
    const item = { directory, runtime };
    cleanup.push(item);
    return item;
  }
});

function seedUser(
  runtime: AppRuntime,
  userId: string,
  role: "owner" | "editor" | "viewer",
): void {
  const timestamp = "2026-07-31T00:00:00.000Z";
  runtime.database.sqlite
    .prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(userId, userId, `${userId}@example.test`, timestamp, timestamp);
  runtime.database.sqlite
    .prepare(
      `INSERT INTO app_users (user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(userId, role, timestamp, timestamp);
}
