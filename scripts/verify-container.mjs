import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const timeoutMs = Number.parseInt(
  process.env.CONTAINER_VERIFY_TIMEOUT_MS || "600000",
  10,
);
const arm64StartupTimeoutMs = 120_000;
const verifyArm64 = process.env.CONTAINER_VERIFY_ARM64 !== "false";
const resourceId = `found-made-verify-${process.pid}-${Date.now().toString(36)}`;
const image = `${resourceId}:amd64`;
const arm64Image = `${resourceId}:arm64`;
const container = resourceId;
const arm64Container = `${resourceId}-arm64`;
const invalidContainer = `${resourceId}-invalid`;
const volume = `${resourceId}-data`;
const arm64Volume = `${resourceId}-arm64-data`;
const network = `${resourceId}-network`;
const arm64Network = `${resourceId}-arm64-network`;
let resourcesCreated = false;

try {
  await assertDockerAvailable();
  await buildImages();
  await verifyRuntime();
  if (verifyArm64) await verifyArm64Runtime();
  emit("container_verification.complete", { image, resourceId });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Docker unavailable:")) {
    emit("container_verification.unavailable", { message, resourceId });
    process.exitCode = 2;
  } else {
    emit("container_verification.failed", { message, resourceId });
    process.exitCode = 1;
  }
} finally {
  await cleanup();
}

async function assertDockerAvailable() {
  try {
    await command(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      15_000,
    );
    await command("docker", ["buildx", "inspect"], 15_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Docker unavailable: ${message}`, { cause: error });
  }
}

async function buildImages() {
  // From this point cleanup may need to remove the uniquely tagged local image.
  resourcesCreated = true;
  emit("container_verification.build_started", {
    image,
    platform: "linux/amd64",
  });
  await command(
    "docker",
    [
      "buildx",
      "build",
      "--platform",
      "linux/amd64",
      "--load",
      "--tag",
      image,
      ".",
    ],
    timeoutMs,
  );
  emit("container_verification.build_complete", {
    image,
    platform: "linux/amd64",
  });

  if (verifyArm64) {
    emit("container_verification.build_started", {
      image: arm64Image,
      platform: "linux/arm64",
    });
    await command(
      "docker",
      [
        "buildx",
        "build",
        "--platform",
        "linux/arm64",
        "--load",
        "--tag",
        arm64Image,
        ".",
      ],
      timeoutMs,
    );
    emit("container_verification.build_complete", {
      image: arm64Image,
      platform: "linux/arm64",
    });
  }
}

async function verifyRuntime() {
  await verifyEntrypointRejection();
  const port = await findAvailablePort();
  resourcesCreated = true;
  await command("docker", ["network", "create", network], 30_000);
  await command("docker", ["volume", "create", volume], 30_000);
  await command(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      container,
      "--network",
      network,
      "--publish",
      `127.0.0.1:${port}:3000`,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16777216",
      "--health-interval",
      "1s",
      "--health-start-period",
      "1s",
      "--health-timeout",
      "2s",
      "--health-retries",
      "3",
      "--volume",
      `${volume}:/data`,
      "--env",
      "PUID=10001",
      "--env",
      "PGID=10002",
      "--env",
      "ALLOW_INSECURE_PUBLIC_ORIGIN=true",
      "--env",
      `PUBLIC_ORIGIN=http://127.0.0.1:${port}`,
      image,
    ],
    30_000,
  );

  emit("container_verification.container_started", {
    container,
    image,
    port,
    volume,
  });
  await waitForReady(port);
  await waitForContainerHealth(container, "healthy");
  const initial = await fetchJson(port, "/api/v1/system");
  assert(
    typeof initial.installationId === "string" &&
      initial.installationId.length > 0,
    "system identity missing",
  );
  await assertOwnership(container);

  // Make one required durable directory unwritable while the application stays
  // live. Readiness must return a real 503 rather than a cached success.
  await command(
    "docker",
    ["exec", "--user", "0", container, "chmod", "0555", "/data/keys"],
    15_000,
  );
  let unavailableStatus;
  try {
    unavailableStatus = await fetchStatus(port, "/health/ready");
    assert(
      unavailableStatus === 503,
      `expected readiness 503 for unwritable storage, got ${unavailableStatus}`,
    );
    await waitForContainerHealth(container, "unhealthy");
  } finally {
    await command(
      "docker",
      ["exec", "--user", "0", container, "chmod", "0755", "/data/keys"],
      15_000,
    );
  }
  await waitForReady(port);
  await waitForContainerHealth(container, "healthy");
  emit("container_verification.readiness_failure_verified", {
    unavailableStatus,
  });

  await stopContainer(container);
  const stoppedLogs = await command("docker", ["logs", container], 15_000);
  assert(
    stoppedLogs.stdout.includes('"event":"server.stopped"'),
    "application did not log graceful shutdown",
  );
  await command("docker", ["start", container], 30_000);
  await waitForReady(port);
  const restarted = await fetchJson(port, "/api/v1/system");
  assert(
    restarted.installationId === initial.installationId,
    "installation identity changed after container restart",
  );
  emit("container_verification.persistence_verified", {
    installationPersisted: true,
  });
}

async function verifyArm64Runtime() {
  const port = await findAvailablePort();
  await command("docker", ["network", "create", arm64Network], 30_000);
  await command("docker", ["volume", "create", arm64Volume], 30_000);
  await command(
    "docker",
    [
      "run",
      "--detach",
      "--platform",
      "linux/arm64",
      "--name",
      arm64Container,
      "--network",
      arm64Network,
      "--publish",
      `127.0.0.1:${port}:3000`,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16777216",
      "--health-interval",
      "1s",
      "--health-start-period",
      "30s",
      "--health-timeout",
      "10s",
      "--health-retries",
      "6",
      "--volume",
      `${arm64Volume}:/data`,
      "--env",
      "PUID=10001",
      "--env",
      "PGID=10002",
      "--env",
      "ALLOW_INSECURE_PUBLIC_ORIGIN=true",
      "--env",
      `PUBLIC_ORIGIN=http://127.0.0.1:${port}`,
      arm64Image,
    ],
    30_000,
  );

  await waitForReady(port, arm64StartupTimeoutMs);
  await waitForContainerHealth(
    arm64Container,
    "healthy",
    arm64StartupTimeoutMs,
  );
  const initial = await fetchJson(port, "/api/v1/system");
  assert(
    typeof initial.installationId === "string" &&
      initial.installationId.length > 0,
    "arm64 system identity missing",
  );
  await assertOwnership(arm64Container);

  await stopContainer(arm64Container);
  const stoppedLogs = await command("docker", ["logs", arm64Container], 15_000);
  assert(
    stoppedLogs.stdout.includes('"event":"server.stopped"'),
    "arm64 application did not log graceful shutdown",
  );
  await command("docker", ["start", arm64Container], 30_000);
  await waitForReady(port, arm64StartupTimeoutMs);
  await waitForContainerHealth(
    arm64Container,
    "healthy",
    arm64StartupTimeoutMs,
  );
  const restarted = await fetchJson(port, "/api/v1/system");
  assert(
    restarted.installationId === initial.installationId,
    "arm64 installation identity changed after restart",
  );
  emit("container_verification.arm64_runtime_verified", {
    container: arm64Container,
    image: arm64Image,
    installationPersisted: true,
    platform: "linux/arm64",
  });
}

async function assertOwnership(containerName) {
  const processTable = (
    await command(
      "docker",
      ["top", containerName, "-eo", "pid,uid,gid,args"],
      15_000,
    )
  ).stdout;
  const applicationProcesses = processTable
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      const fields = line.split(/\s+/);
      return (
        fields[1] === "10001" &&
        fields[2] === "10002" &&
        /\bnode server\.js(?:\s|$)/.test(fields.slice(3).join(" "))
      );
    });
  assert(
    applicationProcesses.length === 1,
    `expected one Node application process, got ${applicationProcesses.length}`,
  );
  const [, uid, gid] = applicationProcesses[0].split(/\s+/, 4);
  const ownership = (
    await command(
      "docker",
      [
        "exec",
        containerName,
        "stat",
        "-c",
        "%u:%g",
        "/data",
        "/data/db",
        "/data/db/found-and-made.sqlite",
        "/data/keys",
        "/data/keys/instance.key",
      ],
      15_000,
    )
  ).stdout
    .trim()
    .split(/\r?\n/);
  assert(
    uid === "10001" && gid === "10002",
    `expected task user 10001:10002, got ${uid}:${gid}`,
  );
  assert(
    ownership.length === 5 &&
      ownership.every((value) => value === "10001:10002"),
    `expected durable paths owned by 10001:10002, got ${ownership.join(",")}`,
  );
  emit("container_verification.identity_verified", {
    durablePathOwnership: ownership,
    gid,
    process: applicationProcesses[0],
    uid,
  });
}

async function verifyEntrypointRejection() {
  let failure;
  try {
    await command(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        invalidContainer,
        "--env",
        "PUID=0",
        "--env",
        "PGID=10002",
        image,
      ],
      30_000,
    );
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof Error, "container accepted a root PUID");
  assert(
    failure.message.includes("PUID must not be root (0)"),
    "root PUID rejection did not return the expected generic setup error",
  );
  emit("container_verification.root_identity_rejected", {
    rejectedPuid: 0,
  });
}

async function stopContainer(containerName) {
  await command("docker", ["stop", "--time", "8", containerName], 20_000);
  const state = await command(
    "docker",
    ["inspect", "--format", "{{.State.Status}}", containerName],
    15_000,
  );
  assert(
    state.stdout.trim() === "exited",
    `container did not stop cleanly: ${state.stdout.trim()}`,
  );
}

async function waitForReady(port, waitMs = 30_000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (
      (await fetchStatus(port, "/health/live")) === 200 &&
      (await fetchStatus(port, "/health/ready")) === 200
    )
      return;
    await delay(100);
  }
  throw new Error(`container did not become live and ready within ${waitMs}ms`);
}

async function waitForContainerHealth(
  containerName,
  expected,
  waitMs = 30_000,
) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const health = await command(
      "docker",
      ["inspect", "--format", "{{.State.Health.Status}}", containerName],
      15_000,
    );
    if (health.stdout.trim() === expected) return;
    await delay(250);
  }
  throw new Error(
    `container health did not become ${expected} within ${waitMs}ms`,
  );
}

async function fetchStatus(port, path) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.status;
  } catch {
    return 0;
  }
}

async function fetchJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(3_000),
  });
  assert(response.ok, `${path} returned ${response.status}`);
  return response.json();
}

async function findAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(
    typeof address === "object" && address !== null,
    "could not reserve a host port",
  );
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function cleanup() {
  if (resourcesCreated) {
    await commandIgnoringFailure("docker", ["rm", "--force", invalidContainer]);
    await commandIgnoringFailure("docker", ["rm", "--force", container]);
    await commandIgnoringFailure("docker", ["rm", "--force", arm64Container]);
    await commandIgnoringFailure("docker", ["volume", "rm", "--force", volume]);
    await commandIgnoringFailure("docker", [
      "volume",
      "rm",
      "--force",
      arm64Volume,
    ]);
    await commandIgnoringFailure("docker", ["network", "rm", network]);
    await commandIgnoringFailure("docker", ["network", "rm", arm64Network]);
    await commandIgnoringFailure("docker", ["image", "rm", "--force", image]);
    await commandIgnoringFailure("docker", [
      "image",
      "rm",
      "--force",
      arm64Image,
    ]);
  }
  emit("container_verification.cleanup_complete", { resourceId });
}

async function commandIgnoringFailure(executable, args) {
  try {
    await command(executable, args, 30_000);
  } catch {
    /* cleanup remains best effort */
  }
}

function command(executable, args, commandTimeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: projectRoot,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child).finally(() => {
        finish(() =>
          reject(
            new Error(
              `${executable} ${args.join(" ")} timed out after ${commandTimeoutMs}ms`,
            ),
          ),
        );
      });
    }, commandTimeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error) => {
      if (timedOut) return;
      finish(() => reject(error));
    });
    child.on("close", (code) => {
      if (timedOut) return;
      finish(() => {
        if (code === 0) resolve({ stdout, stderr });
        else
          reject(
            new Error(
              `${executable} ${args.join(" ")} failed with ${code}: ${stderr || stdout}`,
            ),
          );
      });
    });
  });
}

async function terminateProcessTree(child) {
  const deadline = Date.now() + 5_000;
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    await runTerminationCommand(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      Math.min(4_000, remainingTime(deadline)),
    );
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForChildClose(child, remainingTime(deadline));
  }
}

function runTerminationCommand(executable, args, timeoutMs) {
  if (timeoutMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const terminator = spawn(executable, args, {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      terminator.kill("SIGKILL");
      finish();
    }, timeoutMs);
    terminator.once("error", finish);
    terminator.once("close", finish);
  });
}

function waitForChildClose(child, timeoutMs) {
  if (timeoutMs <= 0 || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function remainingTime(deadline) {
  return Math.max(0, deadline - Date.now());
}

function appendBounded(current, chunk) {
  const maximumCharacters = 1_000_000;
  const combined = current + String(chunk);
  return combined.length <= maximumCharacters
    ? combined
    : combined.slice(-maximumCharacters);
}

function emit(event, details) {
  process.stdout.write(
    `${JSON.stringify({ event, timestamp: new Date().toISOString(), ...details })}\n`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
