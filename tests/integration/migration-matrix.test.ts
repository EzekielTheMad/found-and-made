import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "#src/platform/db/database.server";

import {
  createMigrationPrefix,
  LEGACY_RECIPE,
  writeSyntheticMigrationFolder,
} from "./fixtures/migration-fixtures";

const migrationsFolder = resolve(process.cwd(), "drizzle");
const expectedMigrations = readMigrationFiles({ migrationsFolder });

describe("migration hardening matrix", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup
        .splice(0)
        .map((directory) =>
          rm(directory, { force: true, recursive: true, maxRetries: 3 }),
        ),
    );
  });

  it("applies every migration to a fresh database and reopens idempotently", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "fresh.db");

    const first = openDatabase({ filePath, migrationsFolder });
    const firstHistory = migrationHistory(first.sqlite);
    expect(firstHistory).toHaveLength(expectedMigrations.length);
    expect(tableNames(first.sqlite)).toEqual(
      expect.arrayContaining([
        "jobs",
        "recipes",
        "media_assets",
        "print_jobs",
        "mcp_tokens",
      ]),
    );
    first.close();

    const second = openDatabase({ filePath, migrationsFolder });
    expect(migrationHistory(second.sqlite)).toEqual(firstHistory);
    expect(second.sqlite.pragma("integrity_check", { simple: true })).toBe(
      "ok",
    );
    second.close();
  });

  it("upgrades a representative recipe database without losing its data", async () => {
    const directory = await temporaryDirectory();
    const legacyMigrations = join(directory, "legacy-migrations");
    const filePath = join(directory, "upgrade.db");
    await createMigrationPrefix(migrationsFolder, legacyMigrations, 2);

    const legacy = openDatabase({
      filePath,
      migrationsFolder: legacyMigrations,
    });
    legacy.sqlite
      .prepare(
        `INSERT INTO recipes
          (aggregate, created_at, deleted_at, fingerprint, id, source_canonical_url, title, updated_at, variant_of_id, version)
         VALUES
          (@aggregate, @createdAt, NULL, @fingerprint, @id, NULL, @title, @updatedAt, NULL, @version)`,
      )
      .run(LEGACY_RECIPE);
    legacy.close();

    const upgraded = openDatabase({ filePath, migrationsFolder });
    expect(migrationHistory(upgraded.sqlite)).toHaveLength(
      expectedMigrations.length,
    );
    expect(
      upgraded.sqlite
        .prepare(
          "SELECT id, title, fingerprint, aggregate FROM recipes WHERE id = ?",
        )
        .get(LEGACY_RECIPE.id),
    ).toEqual({
      aggregate: LEGACY_RECIPE.aggregate,
      fingerprint: LEGACY_RECIPE.fingerprint,
      id: LEGACY_RECIPE.id,
      title: LEGACY_RECIPE.title,
    });
    expect(
      upgraded.sqlite.pragma("foreign_key_check") as unknown[],
    ).toHaveLength(0);
    upgraded.close();
  });

  it.each(
    expectedMigrations.slice(0, -1).map((migration, index) => ({
      boundary: index + 1,
      createdAt: migration.folderMillis,
    })),
  )(
    "upgrades released migration boundary $boundary ($createdAt) without losing durable settings",
    async ({ boundary }) => {
      const directory = await temporaryDirectory();
      const boundaryMigrations = join(directory, "boundary-migrations");
      const filePath = join(directory, "boundary.db");
      await createMigrationPrefix(
        migrationsFolder,
        boundaryMigrations,
        boundary,
      );

      const beforeUpgrade = openDatabase({
        filePath,
        migrationsFolder: boundaryMigrations,
      });
      beforeUpgrade.sqlite
        .prepare(
          `INSERT INTO system_settings (key, updated_at, value)
           VALUES (?, ?, ?)`,
        )
        .run(
          "migration-boundary-marker",
          "2026-08-05T00:00:00.000Z",
          String(boundary),
        );
      beforeUpgrade.close();

      const upgraded = openDatabase({ filePath, migrationsFolder });
      expect(migrationHistory(upgraded.sqlite)).toHaveLength(
        expectedMigrations.length,
      );
      expect(
        upgraded.sqlite
          .prepare("SELECT value FROM system_settings WHERE key = ?")
          .pluck()
          .get("migration-boundary-marker"),
      ).toBe(String(boundary));
      expect(upgraded.sqlite.pragma("integrity_check", { simple: true })).toBe(
        "ok",
      );
      expect(
        upgraded.sqlite.pragma("foreign_key_check") as unknown[],
      ).toHaveLength(0);
      upgraded.close();
    },
  );

  it("rolls back all statements and history for a failing forward migration", async () => {
    const directory = await temporaryDirectory();
    const fixtureFolder = join(directory, "atomic-migrations");
    const filePath = join(directory, "atomic.db");
    const firstMigration = {
      sql: "CREATE TABLE stable_data (id text PRIMARY KEY NOT NULL);",
      tag: "0000_stable",
      when: 1_800_000_000_000,
    };
    await writeSyntheticMigrationFolder(fixtureFolder, [firstMigration]);
    openDatabase({ filePath, migrationsFolder: fixtureFolder }).close();

    await writeSyntheticMigrationFolder(fixtureFolder, [
      firstMigration,
      {
        sql: `
          CREATE TABLE should_rollback (id text PRIMARY KEY NOT NULL);
          --> statement-breakpoint
          INSERT INTO table_that_does_not_exist (id) VALUES ('failure');
        `,
        tag: "0001_fails_atomically",
        when: 1_800_000_000_001,
      },
    ]);

    expect(() =>
      openDatabase({ filePath, migrationsFolder: fixtureFolder }),
    ).toThrow();

    const inspected = new Database(filePath, { readonly: true });
    expect(tableNames(inspected)).toContain("stable_data");
    expect(tableNames(inspected)).not.toContain("should_rollback");
    expect(migrationHistory(inspected)).toHaveLength(1);
    inspected.close();
  });

  it("refuses migration history created by a newer application release", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "newer.db");
    const current = openDatabase({ filePath, migrationsFolder });
    current.sqlite
      .prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      )
      .run("future-release-hash", expectedMigrations.at(-1)!.folderMillis + 1);
    current.close();

    expect(() => openDatabase({ filePath, migrationsFolder })).toThrow(
      /newer than this application release/,
    );
  });

  it("accepts the exact applied SQL recorded with Windows CRLF endings", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "crlf-history.db");
    const current = openDatabase({ filePath, migrationsFolder });

    for (const migration of expectedMigrations) {
      const source = migration.sql.join("--> statement-breakpoint");
      const crlf = source.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
      const crlfHash = createHash("sha256").update(crlf).digest("hex");
      current.sqlite
        .prepare(
          "UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?",
        )
        .run(crlfHash, migration.folderMillis);
    }
    current.close();

    const reopened = openDatabase({ filePath, migrationsFolder });
    expect(migrationHistory(reopened.sqlite)).toHaveLength(
      expectedMigrations.length,
    );
    expect(reopened.sqlite.pragma("integrity_check", { simple: true })).toBe(
      "ok",
    );
    reopened.close();
  });

  it("refuses divergent or unmanaged schema identities", async () => {
    const directory = await temporaryDirectory();
    const divergentPath = join(directory, "divergent.db");
    const divergent = openDatabase({
      filePath: divergentPath,
      migrationsFolder,
    });
    divergent.sqlite
      .prepare("UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?")
      .run("different-history", expectedMigrations.at(-1)!.folderMillis);
    divergent.close();

    expect(() =>
      openDatabase({ filePath: divergentPath, migrationsFolder }),
    ).toThrow(/divergent/);

    const unmanagedPath = join(directory, "unmanaged.db");
    const unmanaged = new Database(unmanagedPath);
    unmanaged.exec("CREATE TABLE recipes (id text PRIMARY KEY NOT NULL)");
    unmanaged.close();
    expect(() =>
      openDatabase({ filePath: unmanagedPath, migrationsFolder }),
    ).toThrow(/migration history is missing/);
  });

  async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "found-made-migrations-"));
    cleanup.push(directory);
    return directory;
  }
});

function migrationHistory(sqlite: Database.Database): unknown[] {
  return sqlite
    .prepare(
      "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC",
    )
    .all();
}

function tableNames(sqlite: Database.Database): string[] {
  return (
    sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => name);
}
