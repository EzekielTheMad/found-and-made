import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";

export interface DataPaths {
  backups: string;
  db: string;
  exports: string;
  imports: string;
  keys: string;
  mediaOriginals: string;
  mediaWeb: string;
  print: string;
  root: string;
}

export function resolveDataPaths(dataDir?: string): DataPaths {
  const requested = dataDir?.trim() || ".data";
  const root = resolve(requested);
  const parsedRoot = parse(root).root;

  if (!isAbsolute(root) || root === parsedRoot) {
    throw new Error("DATA_DIR must resolve to a dedicated non-root directory");
  }

  return {
    backups: resolve(root, "backups"),
    db: resolve(root, "db"),
    exports: resolve(root, "exports"),
    imports: resolve(root, "imports"),
    keys: resolve(root, "keys"),
    mediaOriginals: resolve(root, "media", "originals"),
    mediaWeb: resolve(root, "media", "web"),
    print: resolve(root, "print"),
    root,
  };
}

export async function ensureDataPaths(paths: DataPaths): Promise<void> {
  const directories = [
    paths.root,
    paths.backups,
    paths.db,
    paths.exports,
    paths.imports,
    paths.keys,
    paths.mediaOriginals,
    paths.mediaWeb,
    paths.print,
  ];

  for (const directory of directories) {
    await mkdir(directory, { recursive: true });
    await access(directory, constants.R_OK | constants.W_OK);
  }
}
