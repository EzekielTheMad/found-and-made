/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const verifierPath = resolve(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "verify-remote-container.mjs",
);
const {
  assertSafeArchiveListing,
  buildArchiveArguments,
  buildScpArguments,
  buildSshArguments,
  createRemoteVerifierScript,
  createResourceNames,
  loadConfiguration,
  validateRemoteRoot,
  validateRemoteTarget,
  validateUnixId,
} = await import(pathToFileURL(verifierPath).href);

const config = {
  keyPath: "C:\\keys\\unraid",
  target: "verifier@192.0.2.10",
};

describe("remote container verification harness", () => {
  it("requires explicit, injection-safe remote coordinates", () => {
    expect(() => validateRemoteTarget(undefined)).toThrow(
      "REMOTE_VERIFY_TARGET is required",
    );
    expect(() => validateRemoteTarget("-oProxyCommand=bad")).toThrow();
    expect(validateRemoteTarget(config.target)).toBe(config.target);

    expect(() => validateRemoteRoot(undefined)).toThrow(
      "no remote staging path is guessed",
    );
    expect(() => validateRemoteRoot("/")).toThrow("dedicated non-root");
    expect(() => validateRemoteRoot("/tmp/a;touch/x")).toThrow();
    expect(() =>
      validateRemoteRoot("/mnt/user/appdata/found-and-made"),
    ).toThrow("must not be or contain");
    expect(() => validateRemoteRoot("/mnt/user/appdata")).toThrow(
      "must not be or contain",
    );
    expect(
      validateRemoteRoot("/mnt/user/system/found-made-verification/"),
    ).toBe("/mnt/user/system/found-made-verification");
  });

  it("creates valid task-scoped Docker and staging names", () => {
    const names = createResourceNames(
      1_800_000_000_000,
      "0123456789abcdefabcd",
    );

    expect(names.resourceId).toMatch(
      /^found-made-remote-[a-z0-9]+-[a-f0-9]{20}$/,
    );
    expect(names.container).toBe(names.resourceId);
    expect(names.invalidContainer).toBe(`${names.resourceId}-invalid`);
    expect(names.cleanupContainer).toBe(`${names.resourceId}-cleanup`);
    expect(names.image).toBe(`${names.resourceId}:amd64`);
  });

  it("uses argument arrays with strict, noninteractive SSH and SCP", () => {
    const sshArguments = buildSshArguments(config, [
      "test",
      "-d",
      "/safe/root",
    ]);
    const scpArguments = buildScpArguments(
      config,
      ["C:\\tmp\\source.tar", "C:\\tmp\\verify.sh"],
      "/safe/root/task",
    );

    expect(sshArguments).toContain("BatchMode=yes");
    expect(sshArguments).toContain("StrictHostKeyChecking=yes");
    expect(sshArguments.slice(-4)).toEqual([
      config.target,
      "test",
      "-d",
      "/safe/root",
    ]);
    expect(scpArguments).toContain("BatchMode=yes");
    expect(scpArguments).toContain("StrictHostKeyChecking=yes");
    expect(scpArguments.at(-1)).toBe(`${config.target}:/safe/root/task/`);
  });

  it("archives source without private or generated trees", () => {
    const argumentsForTar = buildArchiveArguments("C:\\tmp\\source.tar");

    expect(argumentsForTar).toContain("--exclude=./.data");
    expect(argumentsForTar).toContain("--exclude=./.git");
    expect(argumentsForTar).toContain("--exclude=./node_modules");
    expect(argumentsForTar).toContain("--exclude=./.env.*");
    expect(() =>
      assertSafeArchiveListing(
        "./package.json\n./src/index.ts\n./public/icon.svg\n",
      ),
    ).not.toThrow();
    expect(() =>
      assertSafeArchiveListing("./package.json\n./.data/private.sqlite\n"),
    ).toThrow("unsafe archive entry");
    expect(() => assertSafeArchiveListing("./src/../../outside\n")).toThrow(
      "unsafe archive entry",
    );
  });

  it("generates the complete isolated amd64 runtime gate and exact cleanup", () => {
    const script = createRemoteVerifierScript({ pgid: 10002, puid: 10001 });

    expect(script).toContain("sudo -n docker");
    expect(script).toContain("docker_cmd build --quiet --platform linux/amd64");
    expect(script).toContain("--publish 127.0.0.1::3000");
    expect(script).toContain("--read-only");
    expect(script).toContain('--volume "$DATA_DIR:/data"');
    expect(script).toContain("PUID=10001");
    expect(script).toContain("PGID=10002");
    expect(script).toContain("--env PUID=0");
    expect(script).toContain("UNAVAILABLE_STATUS");
    expect(script).toContain(
      'docker_cmd top "$CONTAINER" -eo pid,uid,gid,args',
    );
    expect(script).toContain("Node application process is not running");
    expect(script).toContain("wait_health unhealthy");
    expect(script).toContain("wait_health healthy");
    expect(script).toContain("resolve_host_port()");
    expect(script.match(/resolve_host_port/g)).toHaveLength(3);
    expect(script).toContain('"event":"server.stopped"');
    expect(script).toContain('[ "$RESTARTED_ID" = "$INSTALLATION_ID" ]');
    expect(script).toContain('docker_cmd rm --force "$CONTAINER"');
    expect(script).toContain('docker_cmd image rm --force "$IMAGE"');
    expect(script).toContain('rm -rf -- "$TASK_DIR"');
    expect(script).toContain("protected production path rejected");
    expect(script).toContain("remote container diagnostic state:");
    expect(script).toContain("docker_cmd logs --tail 200");
    expect(script).toContain(
      'exited|dead) fail "container exited before readiness"',
    );
  });

  it("rejects root and unreasonable runtime identities", () => {
    expect(validateUnixId(undefined, "PUID", 10001)).toBe(10001);
    expect(validateUnixId("65534", "PGID", 10002)).toBe(65534);
    expect(() => validateUnixId("0", "PUID", 10001)).toThrow("non-root");
    expect(() => validateUnixId("1;id", "PUID", 10001)).toThrow("non-root");
    expect(() => validateUnixId("2147483648", "PUID", 10001)).toThrow(
      "outside",
    );
  });

  it("requires an existing absolute SSH key path", async () => {
    await expect(
      loadConfiguration({
        REMOTE_VERIFY_KEY: "relative-key",
        REMOTE_VERIFY_ROOT: "/mnt/cache/appdata",
        REMOTE_VERIFY_TARGET: config.target,
      }),
    ).rejects.toThrow("absolute local path");
  });
});
