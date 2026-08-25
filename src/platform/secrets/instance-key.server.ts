import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function ensureInstanceKey(keysDirectory: string): Promise<void> {
  const keyPath = join(keysDirectory, "instance.key");

  try {
    await writeFile(keyPath, randomBytes(32).toString("base64url"), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }

  const key = (await readFile(keyPath, "utf8")).trim();
  if (key.length < 32) {
    throw new Error("The instance key is missing or invalid");
  }
}

export async function readInstanceKey(keysDirectory: string): Promise<string> {
  const key = (
    await readFile(join(keysDirectory, "instance.key"), "utf8")
  ).trim();
  if (key.length < 32)
    throw new Error("The instance key is missing or invalid");
  return key;
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
