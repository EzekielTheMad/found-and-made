import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");

describe("container verification harness", () => {
  it("builds, loads, and runs both release architectures", async () => {
    const verifier = await readFile(
      resolve(root, "scripts/verify-container.mjs"),
      "utf8",
    );
    expect(verifier).toMatch(/"--platform",\s*"linux\/amd64",\s*"--load"/);
    expect(verifier).toMatch(
      /"--platform",\s*"linux\/arm64",\s*"--load",\s*"--tag",\s*arm64Image/,
    );
    expect(verifier).toContain('"--platform",\n      "linux/arm64"');
    expect(verifier).toContain('"docker", ["start", arm64Container]');
    expect(verifier).toContain("container_verification.arm64_runtime_verified");
    expect(verifier).toContain('"docker", ["buildx", "inspect"]');
  });

  it("uses unique names and only cleans up exact task-owned resources", async () => {
    const verifier = await readFile(
      resolve(root, "scripts/verify-container.mjs"),
      "utf8",
    );
    expect(verifier).toContain("const resourceId = `found-made-verify-");
    expect(verifier).toMatch(
      /commandIgnoringFailure\("docker", \[\s*"rm",\s*"--force",\s*invalidContainer/s,
    );
    expect(verifier).toContain('"docker", ["rm", "--force", container]');
    expect(verifier).toContain('"docker", ["rm", "--force", arm64Container]');
    expect(verifier).toContain('"docker", ["volume", "rm", "--force", volume]');
    expect(verifier).toContain('"docker", ["network", "rm", network]');
    expect(verifier).not.toMatch(
      /docker\s+(system\s+prune|volume\s+prune|container\s+prune)/,
    );
  });

  it("proves container boundaries, persistence, readiness failure, and graceful shutdown", async () => {
    const verifier = await readFile(
      resolve(root, "scripts/verify-container.mjs"),
      "utf8",
    );
    expect(verifier).toContain('"PUID=10001"');
    expect(verifier).toContain('"PGID=10002"');
    expect(verifier).toContain('"PUID=0"');
    expect(verifier).toContain('"--read-only"');
    expect(verifier).toContain('"chmod", "0555", "/data/keys"');
    expect(verifier).toContain("unavailableStatus === 503");
    expect(verifier).toContain("{{.State.Health.Status}}");
    expect(verifier).toContain(
      '"top", containerName, "-eo", "pid,uid,gid,args"',
    );
    expect(verifier).toContain("node server");
    expect(verifier).toContain("/data/db/found-and-made.sqlite");
    expect(verifier).toContain("/data/keys/instance.key");
    expect(verifier).toContain('"event":"server.stopped"');
    expect(verifier).toContain(
      "installation identity changed after container restart",
    );
    expect(verifier).toContain("container_verification.unavailable");
  });

  it("runs the arm64 image under CI foreign-architecture emulation", async () => {
    const verifier = await readFile(
      resolve(root, "scripts/verify-container.mjs"),
      "utf8",
    );
    const workflow = await readFile(
      resolve(root, ".github/workflows/ci.yml"),
      "utf8",
    );
    const arm64Runtime = verifier.slice(
      verifier.indexOf("async function verifyArm64Runtime()"),
      verifier.indexOf("async function assertOwnership"),
    );
    expect(verifier).toContain("const arm64StartupTimeoutMs = 120_000;");
    expect(
      verifier.match(/waitForReady\(port, arm64StartupTimeoutMs\)/g),
    ).toHaveLength(2);
    expect(
      verifier.match(
        /waitForContainerHealth\(\s*arm64Container,\s*"healthy",\s*arm64StartupTimeoutMs,?\s*\)/g,
      ),
    ).toHaveLength(2);
    expect(arm64Runtime).toContain('"--health-start-period",\n      "30s"');
    expect(arm64Runtime).toContain('"--health-timeout",\n      "10s"');
    expect(arm64Runtime).toContain('"--health-retries",\n      "6"');
    expect(workflow).toContain("docker/setup-qemu-action@v3");
    expect(workflow).toContain("platforms: arm64");
    expect(workflow).toContain("docker/setup-buildx-action@v3");
    expect(workflow).toContain("npm run verify:container");
  });
});
