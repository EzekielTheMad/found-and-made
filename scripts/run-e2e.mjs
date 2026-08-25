import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = await mkdtemp(join(tmpdir(), "found-made-e2e-"));
const cliPath = join(
  projectRoot,
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);
const playwrightArguments = process.argv.slice(2);
let playwright;
let server;
let timer;
let interrupted = false;
let timedOut = false;
let runError;
const CLEANUP_TIMEOUT_MS = 5_000;

try {
  server = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ALLOW_INSECURE_PUBLIC_ORIGIN: "true",
      DATA_DIR: dataDir,
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      PORT: "4173",
      PUBLIC_ORIGIN: "http://127.0.0.1:4173",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  server.stdout.pipe(process.stdout);
  server.stderr.pipe(process.stderr);
  process.stdout.write(
    `${JSON.stringify({
      command: `${process.execPath} server.js`,
      event: "e2e.server_started",
      parentPid: process.pid,
      pid: server.pid,
      workingDirectory: projectRoot,
    })}\n`,
  );
  await waitForReady(server, "http://127.0.0.1:4173/health/ready", 20_000);

  playwright = spawn(
    process.execPath,
    [cliPath, "test", ...playwrightArguments],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        E2E_DATA_DIR: dataDir,
        E2E_EXTERNAL_SERVER: "1",
      },
      stdio: "inherit",
      detached: process.platform !== "win32",
      windowsHide: true,
    },
  );
  process.stdout.write(
    `${JSON.stringify({
      command:
        `${process.execPath} ${cliPath} test ${playwrightArguments.join(" ")}`.trim(),
      event: "e2e.playwright_started",
      parentPid: process.pid,
      pid: playwright.pid,
      workingDirectory: projectRoot,
    })}\n`,
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      interrupted = true;
      requestTermination(playwright, "Playwright");
      requestTermination(server, "E2E server");
    });
  }
  const timeoutMs = Number(process.env.E2E_PROCESS_TIMEOUT_MS ?? 90_000);
  timer = setTimeout(() => {
    timedOut = true;
    requestTermination(playwright, "Playwright");
    requestTermination(server, "E2E server");
  }, timeoutMs);
  timer.unref();

  const [code, signal] = await waitForExit(
    playwright,
    timeoutMs + CLEANUP_TIMEOUT_MS,
    "Playwright",
  );
  if (code !== 0 || interrupted || timedOut)
    throw new Error(
      `Playwright exited unexpectedly: code=${String(code)} signal=${String(signal)} timedOut=${String(timedOut)}`,
    );
} catch (error) {
  runError = error;
}

clearTimeout(timer);
const cleanupErrors = [];
for (const [target, label] of [
  [playwright, "Playwright"],
  [server, "E2E server"],
]) {
  try {
    terminateChildTree(target);
  } catch (error) {
    cleanupErrors.push(`${label} termination: ${error.message}`);
  }
}
const exitResults = await Promise.allSettled([
  waitForExit(playwright, CLEANUP_TIMEOUT_MS, "Playwright"),
  waitForExit(server, CLEANUP_TIMEOUT_MS, "E2E server"),
]);
for (const result of exitResults) {
  if (result.status === "rejected") cleanupErrors.push(result.reason.message);
}
try {
  await rm(dataDir, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 100,
  });
} catch (error) {
  cleanupErrors.push(`temporary data removal: ${error.message}`);
}

if (cleanupErrors.length > 0) {
  throw new Error(`E2E cleanup failed: ${cleanupErrors.join("; ")}`, {
    cause: runError,
  });
}
if (runError) throw runError;

async function waitForReady(target, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (target.exitCode !== null || target.signalCode !== null) {
      throw new Error("E2E server exited before readiness");
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`E2E server did not become ready within ${timeoutMs}ms`);
}

function waitForExit(target, timeoutMs = CLEANUP_TIMEOUT_MS, label = "child") {
  if (!target || target.exitCode !== null || target.signalCode !== null) {
    return Promise.resolve([
      target?.exitCode ?? null,
      target?.signalCode ?? null,
    ]);
  }
  return new Promise((resolve, reject) => {
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      resolve([code, signal]);
    };
    const timeout = setTimeout(() => {
      target.removeListener("exit", onExit);
      reject(
        new Error(
          `${label} PID ${String(target.pid)} did not exit within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    target.once("exit", onExit);
    if (target.exitCode !== null || target.signalCode !== null) {
      target.removeListener("exit", onExit);
      clearTimeout(timeout);
      resolve([target.exitCode, target.signalCode]);
    }
  });
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

function requestTermination(target, label) {
  try {
    terminateChildTree(target);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        error: error.message,
        event: "e2e.termination_failed",
        label,
        pid: target?.pid ?? null,
      })}\n`,
    );
  }
}
