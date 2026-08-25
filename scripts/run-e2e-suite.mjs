import { spawn, spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testsRoot = join(projectRoot, "tests", "e2e");
const runner = join(projectRoot, "scripts", "run-e2e.mjs");
const CLEANUP_TIMEOUT_MS = 5_000;
const SPEC_TIMEOUT_MS = Number(
  process.env.E2E_SUITE_SPEC_TIMEOUT_MS ?? 105_000,
);
const specs = (await readdir(testsRoot))
  .filter((name) => name.endsWith(".spec.ts"))
  .sort()
  .map((name) =>
    relative(projectRoot, join(testsRoot, name)).replaceAll("\\", "/"),
  );

if (specs.length === 0) throw new Error("No Playwright specs were found");

const suiteStartedAt = Date.now();
emit("e2e_suite.started", { specCount: specs.length });

for (const spec of specs) {
  const specStartedAt = Date.now();
  emit("e2e_suite.spec_started", { spec });
  const child = spawn(process.execPath, [runner, spec], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const terminate = () => requestTermination(child, spec);
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
  let code;
  let signal;
  try {
    [code, signal] = await waitForExit(child, SPEC_TIMEOUT_MS, spec);
  } catch (error) {
    terminateChildTree(child);
    await waitForExit(child, CLEANUP_TIMEOUT_MS, spec);
    throw error;
  } finally {
    process.removeListener("SIGINT", terminate);
    process.removeListener("SIGTERM", terminate);
  }
  if (code !== 0) {
    throw new Error(
      `E2E spec failed: ${spec}; code=${String(code)} signal=${String(signal)}`,
    );
  }
  emit("e2e_suite.spec_complete", {
    elapsedMs: Date.now() - specStartedAt,
    spec,
  });
}

emit("e2e_suite.complete", {
  elapsedMs: Date.now() - suiteStartedAt,
  specCount: specs.length,
});

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

function waitForExit(target, timeoutMs, label) {
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
          `E2E runner PID ${String(target.pid)} for ${label} did not exit within ${timeoutMs}ms`,
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

function requestTermination(target, spec) {
  try {
    terminateChildTree(target);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        error: error.message,
        event: "e2e_suite.termination_failed",
        pid: target?.pid ?? null,
        spec,
      })}\n`,
    );
  }
}

function emit(event, details) {
  process.stdout.write(
    `${JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      ...details,
    })}\n`,
  );
}
