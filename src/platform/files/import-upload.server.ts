import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { fileTypeFromBuffer } from "file-type";

import type { DataPaths } from "./data-paths.server";

const MAX_IMPORT_FILE_BYTES = 100 * 1024 * 1024;
const allowedMimes = new Set([
  "application/pdf",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

export class ImportUploadStore {
  public constructor(private readonly paths: DataPaths) {}

  public store(file: File) {
    return storeImportUpload(this.paths, file);
  }

  public remove(storageRef: string) {
    return removeImportUpload(this.paths, storageRef);
  }

  public read(storageRef: string) {
    return readImportUpload(this.paths, storageRef);
  }
}

export async function storeImportUpload(
  paths: DataPaths,
  file: File,
): Promise<{ mimeType: string; storageRef: string }> {
  if (file.size < 1 || file.size > MAX_IMPORT_FILE_BYTES) {
    throw new Error("Import files must be between 1 byte and 100 MiB");
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected || !allowedMimes.has(detected.mime)) {
    throw new Error("Unsupported import file type");
  }
  const mimeType = detected.mime;
  const extension = detected.ext || safeExtension(file.name);
  const storageRef = `${randomUUID()}.${extension}`;
  await writeFile(join(paths.imports, storageRef), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  return { mimeType, storageRef };
}

export async function removeImportUpload(
  paths: DataPaths,
  storageRef: string,
): Promise<void> {
  if (!storageRef || basename(storageRef) !== storageRef) return;
  try {
    await unlink(join(paths.imports, storageRef));
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
  }
}

export async function readImportUpload(
  paths: DataPaths,
  storageRef: string,
): Promise<Uint8Array> {
  if (!storageRef || basename(storageRef) !== storageRef) {
    throw new Error("Invalid import storage reference");
  }
  const bytes = await readFile(join(paths.imports, storageRef));
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_IMPORT_FILE_BYTES) {
    throw new Error("Stored import file is outside the supported size limit");
  }
  return new Uint8Array(bytes);
}

function safeExtension(fileName: string): string {
  const extension = extname(fileName).slice(1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : "bin";
}
