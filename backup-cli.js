const usage =
  "Usage: backup-cli.js create | verify <backup-directory> | restore <backup-directory> <empty-target-root>";

try {
  const command = parseCommand(process.argv.slice(2));
  const runtime = await import("./build/server/index.js");
  let result;
  if (command.kind === "create")
    result = await required(runtime, "backupCreate")();
  else if (command.kind === "verify")
    result = await required(runtime, "backupVerify")(command.backupDirectory);
  else
    result = await required(runtime, "backupRestoreCold")(
      command.backupDirectory,
      command.targetRoot,
    );
  process.stdout.write(
    `${JSON.stringify({ event: "backup.command_completed", result })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      event: "backup.command_failed",
      message: error instanceof Error ? error.message : "unknown error",
    })}\n`,
  );
  process.exitCode = 1;
}

function parseCommand(args) {
  const [kind, ...rest] = args;
  if (kind === "create" && rest.length === 0) return { kind };
  if (kind === "verify" && rest.length === 1 && usablePath(rest[0])) {
    return { backupDirectory: rest[0], kind };
  }
  if (
    kind === "restore" &&
    rest.length === 2 &&
    usablePath(rest[0]) &&
    usablePath(rest[1])
  ) {
    return { backupDirectory: rest[0], kind, targetRoot: rest[1] };
  }
  throw new Error(usage);
}

function usablePath(value) {
  return Boolean(value && value.trim()) && !value.includes("\0");
}

function required(module, name) {
  const value = module[name];
  if (typeof value !== "function") {
    throw new Error(`Built server does not expose ${name}; rebuild the image`);
  }
  return value;
}
