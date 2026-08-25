export type BackupCommand =
  | { kind: "create" }
  | { backupDirectory: string; kind: "verify" }
  | { backupDirectory: string; kind: "restore"; targetRoot: string };

export interface BackupCommandApi {
  create(): Promise<unknown>;
  restoreCold(backupDirectory: string, targetRoot: string): Promise<unknown>;
  verify(backupDirectory: string): Promise<unknown>;
}

export function parseBackupCommand(args: readonly string[]): BackupCommand {
  const [command, ...rest] = args;
  if (command === "create" && rest.length === 0) return { kind: "create" };
  if (command === "verify" && rest.length === 1 && usablePath(rest[0])) {
    return { backupDirectory: rest[0], kind: "verify" };
  }
  if (
    command === "restore" &&
    rest.length === 2 &&
    usablePath(rest[0]) &&
    usablePath(rest[1])
  ) {
    return { backupDirectory: rest[0], kind: "restore", targetRoot: rest[1] };
  }
  throw new Error(
    "Usage: backup-cli.js create | verify <backup-directory> | restore <backup-directory> <empty-target-root>",
  );
}

export async function runBackupCommand(
  args: readonly string[],
  api: BackupCommandApi,
): Promise<unknown> {
  const command = parseBackupCommand(args);
  switch (command.kind) {
    case "create":
      return api.create();
    case "verify":
      return api.verify(command.backupDirectory);
    case "restore":
      return api.restoreCold(command.backupDirectory, command.targetRoot);
  }
}

function usablePath(value: string | undefined): value is string {
  return (
    typeof value === "string" && Boolean(value.trim()) && !value.includes("\0")
  );
}
