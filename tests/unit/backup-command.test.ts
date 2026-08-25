import { describe, expect, it, vi } from "vitest";

import {
  parseBackupCommand,
  runBackupCommand,
} from "#src/platform/backup/backup-command.server";

describe("backup command wrapper", () => {
  it("parses only bounded create, verify, and restore forms", () => {
    expect(parseBackupCommand(["create"])).toEqual({ kind: "create" });
    expect(parseBackupCommand(["verify", "/data/backups/generation"])).toEqual({
      backupDirectory: "/data/backups/generation",
      kind: "verify",
    });
    expect(
      parseBackupCommand(["restore", "/data/backups/generation", "/restore"]),
    ).toEqual({
      backupDirectory: "/data/backups/generation",
      kind: "restore",
      targetRoot: "/restore",
    });
    for (const args of [
      [],
      ["create", "extra"],
      ["verify"],
      ["restore", "/backup"],
      ["restore", "/backup", ""],
      ["unknown"],
    ]) {
      expect(() => parseBackupCommand(args)).toThrow("Usage:");
    }
  });

  it("dispatches restore only through the cold restore boundary", async () => {
    const api = {
      create: vi.fn(() => Promise.resolve({ generation: "one" })),
      restoreCold: vi.fn(() => Promise.resolve({ restored: true })),
      verify: vi.fn(() => Promise.resolve({ verified: true })),
    };
    await expect(runBackupCommand(["create"], api)).resolves.toEqual({
      generation: "one",
    });
    await expect(runBackupCommand(["verify", "/backup"], api)).resolves.toEqual(
      { verified: true },
    );
    await expect(
      runBackupCommand(["restore", "/backup", "/restore"], api),
    ).resolves.toEqual({ restored: true });
    expect(api.restoreCold).toHaveBeenCalledWith("/backup", "/restore");
    expect(api.verify).toHaveBeenCalledWith("/backup");
  });
});
