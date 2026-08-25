import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface JournalEntry {
  breakpoints: boolean;
  idx: number;
  tag: string;
  version: string;
  when: number;
}

interface MigrationJournal {
  dialect: string;
  entries: JournalEntry[];
  version: string;
}

export const LEGACY_RECIPE = {
  aggregate: JSON.stringify({
    ingredients: [],
    instructions: [],
    servings: { label: "servings", value: 4 },
    title: "Migration matrix soup",
  }),
  createdAt: "2026-01-02T03:04:05.000Z",
  fingerprint: "migration-matrix-soup-v1",
  id: "recipe_migration_matrix",
  title: "Migration matrix soup",
  updatedAt: "2026-01-02T03:04:05.000Z",
  version: 1,
} as const;

export async function createMigrationPrefix(
  sourceFolder: string,
  targetFolder: string,
  entryCount: number,
): Promise<void> {
  const journal = JSON.parse(
    await readFile(join(sourceFolder, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
  const entries = journal.entries.slice(0, entryCount);

  await mkdir(join(targetFolder, "meta"), { recursive: true });
  await writeFile(
    join(targetFolder, "meta", "_journal.json"),
    `${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
    "utf8",
  );
  await Promise.all(
    entries.map(({ tag }) =>
      copyFile(
        join(sourceFolder, `${tag}.sql`),
        join(targetFolder, `${tag}.sql`),
      ),
    ),
  );
}

export async function writeSyntheticMigrationFolder(
  targetFolder: string,
  migrations: Array<{ sql: string; tag: string; when: number }>,
): Promise<void> {
  await mkdir(join(targetFolder, "meta"), { recursive: true });
  const journal: MigrationJournal = {
    dialect: "sqlite",
    entries: migrations.map(({ tag, when }, idx) => ({
      breakpoints: true,
      idx,
      tag,
      version: "6",
      when,
    })),
    version: "7",
  };
  await writeFile(
    join(targetFolder, "meta", "_journal.json"),
    `${JSON.stringify(journal, null, 2)}\n`,
    "utf8",
  );
  await Promise.all(
    migrations.map(({ sql, tag }) =>
      writeFile(join(targetFolder, `${tag}.sql`), `${sql.trim()}\n`, "utf8"),
    ),
  );
}
