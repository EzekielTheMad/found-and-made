import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = await mkdtemp(join(tmpdir(), "found-made-live-"));
const CLEANUP_TIMEOUT_MS = 5_000;
const FETCH_TIMEOUT_MS = 2_000;
const OWNER_EMAIL = "release-owner@example.test";
let ownedProcess;
let verificationError;

try {
  const first = await exerciseServer();
  const second = await exerciseServer(first.installationId);
  const productionCommands = await exerciseProductionCommands();

  process.stdout.write(
    `${JSON.stringify({
      event: "verification.complete",
      firstPid: first.pid,
      installationPersisted: first.installationId === second.installationId,
      productionCommands,
      secondPid: second.pid,
    })}\n`,
  );
} catch (error) {
  verificationError = error;
}

const cleanupErrors = [];
try {
  if (ownedProcess) {
    terminateChildTree(ownedProcess);
    if (ownedProcess.exitCode === null && ownedProcess.signalCode === null) {
      await withTimeout(
        once(ownedProcess, "exit"),
        CLEANUP_TIMEOUT_MS,
        `verification cleanup failed: server PID ${String(ownedProcess.pid)} did not exit within ${CLEANUP_TIMEOUT_MS}ms`,
      );
    }
  }
} catch (error) {
  cleanupErrors.push(error);
}
try {
  await rm(dataDir, { force: true, recursive: true });
} catch (error) {
  cleanupErrors.push(error);
}

if (cleanupErrors.length > 0) {
  const cleanupError = new AggregateError(
    cleanupErrors,
    "verification cleanup failed",
  );
  if (verificationError) {
    throw new AggregateError(
      [verificationError, cleanupError],
      "server verification and cleanup failed",
    );
  }
  throw cleanupError;
}
if (verificationError) throw verificationError;

async function exerciseServer(expectedInstallationId) {
  const port = await findAvailablePort();
  const output = [];
  const errors = [];
  const startedAt = new Date().toISOString();

  ownedProcess = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      HOST: "127.0.0.1",
      ALLOW_INSECURE_PUBLIC_ORIGIN: "true",
      NODE_ENV: "production",
      PORT: String(port),
      PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  ownedProcess.stdout.setEncoding("utf8");
  ownedProcess.stderr.setEncoding("utf8");
  ownedProcess.stdout.on("data", (chunk) => output.push(chunk));
  ownedProcess.stderr.on("data", (chunk) => errors.push(chunk));

  process.stdout.write(
    `${JSON.stringify({
      command: `${process.execPath} server.js`,
      event: "verification.server_started",
      parentPid: process.pid,
      pid: ownedProcess.pid,
      port,
      startedAt,
      workingDirectory: projectRoot,
    })}\n`,
  );

  await waitForReady(ownedProcess, port, output, errors);

  const readyResponse = await fetch(`http://127.0.0.1:${port}/health/ready`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  assert(readyResponse.status === 200, "readiness endpoint did not return 200");
  const ready = await readyResponse.json();
  assert(ready.status === "ready", "readiness payload was not ready");

  const systemResponse = await fetch(`http://127.0.0.1:${port}/api/v1/system`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  assert(systemResponse.status === 200, "system endpoint did not return 200");
  assertHttpBaseline(systemResponse);
  const system = await systemResponse.json();
  assert(
    typeof system.installationId === "string" &&
      system.installationId.length > 0,
    "system endpoint did not return an installation ID",
  );

  if (expectedInstallationId) {
    assert(
      system.installationId === expectedInstallationId,
      "installation ID changed after restart",
    );
  }

  if (!expectedInstallationId) await createInitialOwner(port);

  const socialCardResponse = await fetch(
    `http://127.0.0.1:${port}/public/assets/social-card.webp`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  assert(
    socialCardResponse.status === 200,
    "fallback social card did not return 200",
  );
  assert(
    socialCardResponse.headers.get("content-type") === "image/webp",
    "fallback social card was not served as WebP",
  );
  const socialCard = Buffer.from(await socialCardResponse.arrayBuffer());
  assert(
    socialCard.byteLength > 1_000 &&
      socialCard.subarray(0, 4).toString() === "RIFF",
    "fallback social card was not a usable WebP image",
  );

  const missingApiResponse = await fetch(
    `http://127.0.0.1:${port}/api/v1/not-a-resource`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  assert(
    missingApiResponse.status === 404,
    "unknown API route did not return 404",
  );
  assertHttpBaseline(missingApiResponse);
  const missingApi = await missingApiResponse.json();
  assert(
    missingApi.title === "Resource not found" &&
      missingApi.status === 404 &&
      missingApi.requestId === missingApiResponse.headers.get("x-request-id"),
    "unknown API route did not return a correlated generic problem",
  );

  const exitPromise = once(ownedProcess, "exit");
  const signalled = ownedProcess.kill("SIGTERM");
  assert(signalled, "failed to signal the task-owned server");

  const [exitCode, exitSignal] = await withTimeout(
    exitPromise,
    5_000,
    "server did not stop within five seconds",
  );
  assert(
    exitCode === 0 || exitSignal === "SIGTERM",
    `server exited unexpectedly: code=${String(exitCode)} signal=${String(
      exitSignal,
    )}`,
  );

  await assertPortClosed(port);
  const applicationShutdownLogged = output
    .join("")
    .includes('"event":"server.stopped"');
  if (process.platform !== "win32") {
    assert(
      applicationShutdownLogged,
      "application did not log completion of its graceful shutdown path",
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      applicationShutdownLogged,
      event: "verification.server_stopped",
      exitCode,
      exitSignal,
      pid: ownedProcess.pid,
      port,
      portClosed: true,
    })}\n`,
  );

  const result = {
    installationId: system.installationId,
    pid: ownedProcess.pid,
  };
  ownedProcess = undefined;
  return result;
}

async function createInitialOwner(port) {
  const origin = `http://127.0.0.1:${port}`;
  const response = await fetch(`${origin}/setup`, {
    body: new URLSearchParams({
      email: OWNER_EMAIL,
      name: "Release Owner",
      password: "release verification password",
    }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      "sec-fetch-site": "same-origin",
    },
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  assert(
    response.status === 302 && response.headers.get("location") === "/",
    "production setup route did not create the initial Owner",
  );
}

async function exerciseProductionCommands() {
  const commandEnvironment = {
    ...process.env,
    ALLOW_INSECURE_PUBLIC_ORIGIN: "true",
    DATA_DIR: dataDir,
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    PORT: "4173",
    PUBLIC_ORIGIN: "http://127.0.0.1:4173",
  };

  const recovery = runProductionCommand(
    ["server.js", "recover-owner", OWNER_EMAIL],
    commandEnvironment,
    "Owner recovery command",
  );
  assert(
    recovery.event === "owner.recovery_link_created" &&
      typeof recovery.url === "string",
    "Owner recovery command did not return its success event",
  );
  const recoveryUrl = new URL(recovery.url);
  const recoveryToken = recoveryUrl.pathname.split("/").at(-1);
  assert(
    recoveryUrl.origin === commandEnvironment.PUBLIC_ORIGIN &&
      recoveryUrl.pathname.startsWith("/recover/") &&
      recoveryToken,
    "Owner recovery command returned an invalid URL",
  );

  const liveDatabasePath = join(dataDir, "db", "found-and-made.sqlite");
  const liveDatabase = new Database(liveDatabasePath, { readonly: true });
  try {
    const recoveryRow = liveDatabase
      .prepare(
        `SELECT kind, token_hash AS tokenHash
         FROM recovery_tokens
         WHERE user_id = (SELECT id FROM user WHERE email = ?)`,
      )
      .get(OWNER_EMAIL);
    assert(
      recoveryRow?.kind === "server" &&
        recoveryRow.tokenHash ===
          createHash("sha256").update(recoveryToken).digest("hex") &&
        recoveryRow.tokenHash !== recoveryToken,
      "Owner recovery command did not persist only the expected token hash",
    );
  } finally {
    liveDatabase.close();
  }

  const created = runProductionCommand(
    ["backup-cli.js", "create"],
    commandEnvironment,
    "backup create command",
  );
  const backupDirectory = created.result?.directory;
  assert(
    created.event === "backup.command_completed" &&
      typeof backupDirectory === "string" &&
      pathIsInside(resolve(dataDir, "backups"), resolve(backupDirectory)),
    "backup create command returned an invalid backup directory",
  );

  const verified = runProductionCommand(
    ["backup-cli.js", "verify", backupDirectory],
    commandEnvironment,
    "backup verify command",
  );
  assert(
    verified.event === "backup.command_completed" &&
      verified.result?.version === 1 &&
      Array.isArray(verified.result.files),
    "backup verify command did not validate its manifest",
  );

  const restoreRoot = await mkdtemp(join(tmpdir(), "found-made-cli-restore-"));
  try {
    const restored = runProductionCommand(
      ["backup-cli.js", "restore", backupDirectory, restoreRoot],
      commandEnvironment,
      "backup restore command",
    );
    assert(
      restored.event === "backup.command_completed" &&
        restored.result?.restored === true,
      "backup restore command did not report success",
    );

    const restoredDatabase = new Database(
      join(restoreRoot, "db", "found-and-made.sqlite"),
      { readonly: true },
    );
    try {
      const owner = restoredDatabase
        .prepare(
          `SELECT a.role
           FROM user u JOIN app_users a ON a.user_id = u.id
           WHERE u.email = ?`,
        )
        .get(OWNER_EMAIL);
      const migrationCount = restoredDatabase
        .prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations")
        .get().count;
      assert(
        owner?.role === "owner" && migrationCount === 14,
        "cold-restored database did not reopen the Owner at migration 14",
      );
    } finally {
      restoredDatabase.close();
    }

    const [liveKey, restoredKey] = await Promise.all([
      readFile(join(dataDir, "keys", "instance.key")),
      readFile(join(restoreRoot, "keys", "instance.key")),
    ]);
    assert(
      liveKey.equals(restoredKey),
      "cold restore did not preserve the installation key",
    );
  } finally {
    await rm(restoreRoot, { force: true, recursive: true });
  }

  return {
    backupCreate: true,
    backupRestore: true,
    backupVerify: true,
    ownerRecovery: true,
  };
}

function runProductionCommand(arguments_, environment, label) {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: projectRoot,
    encoding: "utf8",
    env: environment,
    maxBuffer: 256_000,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    windowsHide: true,
  });
  assert(!result.error, `${label} could not be launched`);
  assert(result.status === 0, `${label} failed`);
  const records = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
  assert(records.length > 0, `${label} returned no structured output`);
  return records.at(-1);
}

function pathIsInside(parent, candidate) {
  const relation = relative(parent, candidate);
  return (
    Boolean(relation) && !relation.startsWith("..") && !isAbsolute(relation)
  );
}

async function findAvailablePort() {
  const server = createServer();
  server.unref();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(
    typeof address === "object" && address !== null,
    "failed to reserve an available port",
  );
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForReady(child, port, output, errors) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `server exited before readiness\nstdout:\n${output.join(
          "",
        )}\nstderr:\n${errors.join("")}`,
      );
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 200) return;
    } catch {
      // The listener may not be bound yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    `server did not become ready\nstdout:\n${output.join(
      "",
    )}\nstderr:\n${errors.join("")}`,
  );
}

async function assertPortClosed(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/health/live`, {
      signal: AbortSignal.timeout(500),
    });
  } catch {
    return;
  }
  throw new Error(`task-owned port ${port} remained open after shutdown`);
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function terminateChildTree(target) {
  if (!target?.pid) return;
  if (process.platform === "win32") {
    if (target.exitCode !== null || target.signalCode !== null) return;
    const result = spawnSync(
      "taskkill.exe",
      ["/PID", String(target.pid), "/T", "/F"],
      {
        stdio: "ignore",
        timeout: CLEANUP_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    if (!result.error && result.status === 0) return;
    target.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-target.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertHttpBaseline(response) {
  assert(
    response.headers.get("cache-control") === "no-store",
    "API response was not marked no-store",
  );
  assert(
    response.headers.get("cross-origin-opener-policy") === null,
    "plain HTTP response unexpectedly advertised COOP isolation",
  );
  assert(
    response.headers.get("origin-agent-cluster") === null,
    "plain HTTP response unexpectedly advertised an origin agent cluster",
  );
  assert(
    response.headers.get("cross-origin-resource-policy") === "same-origin",
    "CORP header missing",
  );
  assert(
    response.headers.get("referrer-policy") === "no-referrer",
    "referrer policy missing",
  );
  assert(
    response.headers.get("x-content-type-options") === "nosniff",
    "content type protection missing",
  );
  assert(
    response.headers.get("x-frame-options") === "DENY",
    "frame protection missing",
  );
  assert(
    response.headers.get("x-powered-by") === null,
    "framework identity header leaked",
  );
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      response.headers.get("x-request-id") || "",
    ),
    "correlation ID missing or invalid",
  );
}
