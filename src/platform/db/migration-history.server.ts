import { createHash } from "node:crypto";

import type Database from "better-sqlite3";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";

const MIGRATIONS_TABLE = "__drizzle_migrations";

interface AppliedMigrationRow {
  created_at: number | string | null;
  hash: string;
}

/**
 * Drizzle's SQLite migrator decides what to run from the newest timestamp only.
 * Validate the complete applied prefix first so a newer or divergent database is
 * refused instead of being opened with an unknown schema identity.
 */
export function assertMigrationHistoryCompatible(
  sqlite: Database.Database,
  migrationsFolder: string,
): void {
  const expected = readMigrationFiles({ migrationsFolder });
  assertExpectedHistoryIsOrdered(expected);

  if (!tableExists(sqlite, MIGRATIONS_TABLE)) {
    const unmanagedTables = listApplicationTables(sqlite);
    if (unmanagedTables.length > 0) {
      throw new Error(
        `Database schema is not managed by this release: migration history is missing for ${unmanagedTables.join(", ")}`,
      );
    }
    return;
  }

  const applied = sqlite
    .prepare(
      `SELECT hash, created_at FROM ${MIGRATIONS_TABLE} ORDER BY created_at ASC`,
    )
    .all() as AppliedMigrationRow[];

  if (applied.length === 0) {
    const unmanagedTables = listApplicationTables(sqlite);
    if (unmanagedTables.length > 0) {
      throw new Error(
        `Database schema is divergent: migration history is empty for ${unmanagedTables.join(", ")}`,
      );
    }
    return;
  }

  const newestExpected = expected.at(-1)?.folderMillis;
  if (applied.length > expected.length) {
    throw new Error(
      "Database migration history is newer than this application release",
    );
  }

  for (const [index, actual] of applied.entries()) {
    const createdAt = Number(actual.created_at);
    if (!Number.isSafeInteger(createdAt)) {
      throw new Error(
        `Database migration history is divergent at position ${index}: invalid migration timestamp`,
      );
    }
    if (newestExpected !== undefined && createdAt > newestExpected) {
      throw new Error(
        `Database migration history is newer than this application release (${createdAt})`,
      );
    }

    const wanted = expected[index];
    if (
      wanted === undefined ||
      createdAt !== wanted.folderMillis ||
      !acceptedMigrationHashes(wanted).has(actual.hash)
    ) {
      throw new Error(
        `Database migration history is divergent at position ${index}`,
      );
    }
  }
}

/**
 * Early Windows-built images recorded Drizzle's byte-level hash after their
 * migration SQL had CRLF line endings. The repository now stores canonical LF
 * files. Accept only those two byte encodings of the exact same SQL so an
 * operating-system checkout difference does not make an otherwise identical
 * applied migration look divergent.
 */
function acceptedMigrationHashes(migration: MigrationMeta): Set<string> {
  const source = migration.sql.join("--> statement-breakpoint");
  const lf = source.replaceAll("\r\n", "\n");
  const crlf = lf.replaceAll("\n", "\r\n");
  return new Set([migration.hash, sha256(lf), sha256(crlf)]);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertExpectedHistoryIsOrdered(expected: MigrationMeta[]): void {
  for (let index = 1; index < expected.length; index += 1) {
    if (expected[index - 1].folderMillis >= expected[index].folderMillis) {
      throw new Error(
        "Application migration journal is invalid: timestamps must increase",
      );
    }
  }
}

function tableExists(sqlite: Database.Database, tableName: string): boolean {
  return (
    sqlite
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(tableName) !== undefined
  );
}

function listApplicationTables(sqlite: Database.Database): string[] {
  const rows = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> ? ORDER BY name",
    )
    .all(MIGRATIONS_TABLE) as Array<{ name: string }>;
  return rows.map(({ name }) => name);
}
