import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import Database from "better-sqlite3";

import type { DataPaths } from "../../platform/files/data-paths.server";

const manifestName = "manifest.json";
const databaseRelativePath = "db/found-and-made.sqlite";
const manifestVersion = 1;

export interface BackupManifest {
  files: BackupFile[];
  generatedAt: string;
  migration: MigrationIdentity;
  version: number;
}

export interface BackupFile {
  path: string;
  sha256: string;
  size: number;
}

export interface MigrationIdentity {
  count: number;
  latestHash: string | null;
}

export interface BackupGeneration {
  directory: string;
  manifest: BackupManifest;
}

/** Server-only backup service. Restore callers must ensure the application is offline. */
export class BackupService {
  public constructor(
    private readonly paths: DataPaths,
    private readonly sqlite: Database.Database,
  ) {}

  public async createOnlineBackup(now = new Date()): Promise<BackupGeneration> {
    await mkdir(this.paths.backups, { recursive: true });
    const generation = `backup-${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const finalDirectory = join(this.paths.backups, generation);
    const temporaryDirectory = join(this.paths.backups, `.${generation}.tmp`);
    await mkdir(temporaryDirectory);
    try {
      const sourceStateBefore = await durableFileState(this.paths);
      await mkdir(dirname(join(temporaryDirectory, databaseRelativePath)), {
        recursive: true,
      });
      const snapshotPath = join(temporaryDirectory, databaseRelativePath);
      await this.sqlite.backup(snapshotPath);
      normalizeSnapshot(snapshotPath);
      for (const directory of durableDirectories(this.paths)) {
        await copyTree(
          directory.source,
          join(temporaryDirectory, directory.relative),
        );
      }
      const sourceStateAfter = await durableFileState(this.paths);
      if (
        JSON.stringify(sourceStateBefore) !== JSON.stringify(sourceStateAfter)
      ) {
        throw new Error(
          "Durable files changed during online backup; retry during a quiet period",
        );
      }
      const manifest: BackupManifest = {
        files: await describeFiles(temporaryDirectory),
        generatedAt: now.toISOString(),
        migration: migrationIdentity(this.sqlite),
        version: manifestVersion,
      };
      await writeFile(
        join(temporaryDirectory, manifestName),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporaryDirectory, finalDirectory);
      return { directory: finalDirectory, manifest };
    } catch (error) {
      await rm(temporaryDirectory, { force: true, recursive: true });
      throw error;
    }
  }

  public async verify(backupDirectory: string): Promise<BackupManifest> {
    const manifest = await readManifest(backupDirectory);
    validateManifest(manifest);
    if (!sameMigration(manifest.migration, migrationIdentity(this.sqlite))) {
      throw new Error("Backup schema is incompatible with this application");
    }
    await verifyArtifacts(backupDirectory, manifest);
    return manifest;
  }

  /** Cold restore only: target must be absent or empty and never be this live data root. */
  public async restore(
    backupDirectory: string,
    targetRoot: string,
  ): Promise<void> {
    const manifest = await this.verify(backupDirectory);
    const target = resolve(targetRoot);
    const currentRoot = resolve(this.paths.root);
    const backupRoot = resolve(backupDirectory);
    if (
      target === currentRoot ||
      target.startsWith(`${currentRoot}${sep}`) ||
      currentRoot.startsWith(`${target}${sep}`) ||
      target === backupRoot ||
      target.startsWith(`${backupRoot}${sep}`) ||
      backupRoot.startsWith(`${target}${sep}`)
    ) {
      throw new Error("Backup restore target overlaps protected data");
    }
    const targetState = await rootState(target);
    if (targetState === "nonempty") {
      throw new Error("Backup restore target must be absent or empty");
    }
    const temporary = join(
      dirname(target),
      `.${basename(target)}.restore-${randomUUID()}`,
    );
    await mkdir(temporary);
    try {
      for (const file of manifest.files) {
        const source = safeArtifactPath(backupDirectory, file.path);
        const destination = safeArtifactPath(temporary, file.path);
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(source, destination, 0);
      }
      await verifyArtifacts(temporary, manifest);
      if (targetState === "empty") await rmdir(target);
      await rename(temporary, target);
      await verifyArtifacts(target, manifest);
    } catch (error) {
      await rm(temporary, { force: true, recursive: true });
      throw error;
    }
  }
}

interface DurableFileState {
  modifiedAt: number;
  path: string;
  size: number;
}

async function durableFileState(paths: DataPaths): Promise<DurableFileState[]> {
  const result: DurableFileState[] = [];
  for (const directory of durableDirectories(paths)) {
    const files = await listFiles(directory.source, directory.source, false);
    for (const path of files) {
      const info = await lstat(safeArtifactPath(directory.source, path));
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error("Unsupported durable artifact type");
      }
      result.push({
        modifiedAt: info.mtimeMs,
        path: `${directory.relative}/${path}`,
        size: info.size,
      });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function durableDirectories(
  paths: DataPaths,
): Array<{ relative: string; source: string }> {
  return [
    { relative: "keys", source: paths.keys },
    { relative: "media/originals", source: paths.mediaOriginals },
    { relative: "media/web", source: paths.mediaWeb },
    { relative: "imports", source: paths.imports },
    { relative: "exports", source: paths.exports },
    { relative: "print", source: paths.print },
  ];
}

async function copyTree(source: string, destination: string): Promise<void> {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink())
    throw new Error("Symlinked durable artifacts are not allowed");
  if (!sourceStat.isDirectory()) {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    return;
  }
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const childSource = join(source, entry.name);
    const childDestination = join(destination, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("Symlinked durable artifacts are not allowed");
    if (entry.isDirectory()) await copyTree(childSource, childDestination);
    else if (entry.isFile()) await copyFile(childSource, childDestination);
    else throw new Error("Unsupported durable artifact type");
  }
}

async function describeFiles(root: string): Promise<BackupFile[]> {
  const files = await listFiles(root);
  return Promise.all(
    files.map(async (path) => {
      const fullPath = safeArtifactPath(root, path);
      const info = await stat(fullPath);
      return { path, sha256: await hashFile(fullPath), size: info.size };
    }),
  );
}

async function listFiles(
  root: string,
  current = root,
  skipRootManifest = true,
): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (skipRootManifest && entry.name === manifestName && current === root)
      continue;
    const fullPath = join(current, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("Symlinked backup artifacts are not allowed");
    if (entry.isDirectory())
      result.push(...(await listFiles(root, fullPath, skipRootManifest)));
    else if (entry.isFile()) result.push(toRelative(root, fullPath));
    else throw new Error("Unsupported backup artifact type");
  }
  return result.sort();
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function readManifest(directory: string): Promise<BackupManifest> {
  const path = safeArtifactPath(directory, manifestName);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Backup manifest is invalid");
  const contents = await readFile(path, "utf8");
  if (contents.length > 2 * 1024 * 1024)
    throw new Error("Backup manifest is invalid");
  try {
    return JSON.parse(contents) as BackupManifest;
  } catch {
    throw new Error("Backup manifest is invalid");
  }
}

function validateManifest(manifest: BackupManifest): void {
  if (
    manifest.version !== manifestVersion ||
    !Array.isArray(manifest.files) ||
    !manifest.generatedAt ||
    !manifest.migration ||
    !Number.isInteger(manifest.migration.count)
  ) {
    throw new Error("Backup manifest is invalid");
  }
  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !isSafeRelativePath(file.path) ||
      paths.has(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error("Backup manifest is invalid");
    }
    paths.add(file.path);
  }
  if (!paths.has(databaseRelativePath))
    throw new Error("Backup manifest is invalid");
}

async function verifyArtifacts(
  root: string,
  manifest: BackupManifest,
): Promise<void> {
  const expected = new Set(manifest.files.map((file) => file.path));
  const actual = new Set(await listFiles(root));
  if (
    actual.size !== expected.size ||
    [...actual].some((path) => !expected.has(path))
  ) {
    throw new Error("Backup artifacts do not match manifest");
  }
  for (const file of manifest.files) {
    const path = safeArtifactPath(root, file.path);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size) {
      throw new Error("Backup artifact verification failed");
    }
    if ((await hashFile(path)) !== file.sha256)
      throw new Error("Backup artifact verification failed");
  }
  verifySqlite(
    safeArtifactPath(root, databaseRelativePath),
    manifest.migration,
  );
}

function verifySqlite(
  path: string,
  expectedMigration: MigrationIdentity,
): void {
  const database = new Database(path, { fileMustExist: true, readonly: true });
  try {
    const integrity = database.pragma("integrity_check", { simple: true });
    if (integrity !== "ok")
      throw new Error("Backup SQLite integrity check failed");
    const foreignKeys = database.pragma("foreign_key_check") as unknown[];
    if (foreignKeys.length)
      throw new Error("Backup SQLite foreign key check failed");
    if (!sameMigration(migrationIdentity(database), expectedMigration)) {
      throw new Error("Backup schema is incompatible with manifest");
    }
  } finally {
    database.close();
  }
}

function normalizeSnapshot(path: string): void {
  const database = new Database(path);
  try {
    database.pragma("wal_checkpoint(TRUNCATE)");
    database.pragma("journal_mode = DELETE");
  } finally {
    database.close();
  }
}

function migrationIdentity(database: Database.Database): MigrationIdentity {
  try {
    const rows = database
      .prepare("SELECT hash FROM __drizzle_migrations ORDER BY created_at")
      .all() as Array<{ hash: string }>;
    return { count: rows.length, latestHash: rows.at(-1)?.hash ?? null };
  } catch {
    throw new Error("Database migration identity is unavailable");
  }
}

function sameMigration(
  left: MigrationIdentity,
  right: MigrationIdentity,
): boolean {
  return left.count === right.count && left.latestHash === right.latestHash;
}

async function rootState(
  root: string,
): Promise<"absent" | "empty" | "nonempty"> {
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) return "nonempty";
    return (await readdir(root)).length ? "nonempty" : "empty";
  } catch (error) {
    if (isNotFound(error)) return "absent";
    throw error;
  }
}

function safeArtifactPath(root: string, artifact: string): string {
  if (!isSafeRelativePath(artifact))
    throw new Error("Unsafe backup artifact path");
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, artifact);
  if (
    resolved !== resolvedRoot &&
    !resolved.startsWith(`${resolvedRoot}${sep}`)
  ) {
    throw new Error("Unsafe backup artifact path");
  }
  return resolved;
}

function isSafeRelativePath(path: string): boolean {
  return (
    !isAbsolute(path) &&
    !path.includes("\\") &&
    path !== "" &&
    !path.split("/").some((part) => !part || part === "." || part === "..")
  );
}

function toRelative(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  if (!isSafeRelativePath(value))
    throw new Error("Unsafe backup artifact path");
  return value;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
