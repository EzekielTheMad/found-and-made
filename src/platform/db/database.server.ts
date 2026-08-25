import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "./schema";
import { assertMigrationHistoryCompatible } from "./migration-history.server";

export interface DatabaseHandle {
  db: ReturnType<typeof drizzle<typeof schema>>;
  sqlite: Database.Database;
  close(): void;
}

interface OpenDatabaseOptions {
  filePath: string;
  migrationsFolder?: string;
}

export function openDatabase({
  filePath,
  migrationsFolder = resolve(process.cwd(), "drizzle"),
}: OpenDatabaseOptions): DatabaseHandle {
  mkdirSync(dirname(filePath), { recursive: true });

  const sqlite = new Database(filePath);
  try {
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.pragma("synchronous = FULL");

    assertMigrationHistoryCompatible(sqlite, migrationsFolder);
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder });

    return {
      db,
      sqlite,
      close() {
        if (sqlite.open) sqlite.close();
      },
    };
  } catch (error) {
    if (sqlite.open) sqlite.close();
    throw error;
  }
}
