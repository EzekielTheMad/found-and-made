import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const protectedProductionPath = "/mnt/user/appdata/found-and-made";
const maximumOutputCharacters = 256_000;
const defaultTimeoutMs = 900_000;

export function validateRemoteTarget(value) {
  const target = value?.trim();
  if (!target) {
    throw new Error("REMOTE_VERIFY_TARGET is required");
  }
  if (
    target.length > 255 ||
    !/^(?:[A-Za-z_][A-Za-z0-9._-]{0,31}@)?[A-Za-z0-9][A-Za-z0-9.-]*$/.test(
      target,
    )
  ) {
    throw new Error(
      "REMOTE_VERIFY_TARGET must be a safe SSH host or user@host without a port",
    );
  }
  return target;
}

export function validateRemoteRoot(value) {
  const requested = value?.trim();
  if (!requested) {
    throw new Error(
      "REMOTE_VERIFY_ROOT is required; no remote staging path is guessed",
    );
  }
  if (requested === "/") {
    throw new Error("REMOTE_VERIFY_ROOT must be a dedicated non-root path");
  }
  if (
    requested.length > 180 ||
    !requested.startsWith("/") ||
    !/^\/[A-Za-z0-9._/-]+$/.test(requested) ||
    requested.includes("//")
  ) {
    throw new Error(
      "REMOTE_VERIFY_ROOT must be a short absolute POSIX path using only safe characters",
    );
  }

  const root = requested.length > 1 ? requested.replace(/\/+$/, "") : requested;
  const segments = root.split("/");
  if (root === "/" || segments.includes(".") || segments.includes("..")) {
    throw new Error("REMOTE_VERIFY_ROOT must be a dedicated non-root path");
  }

  const overlapsProduction =
    root === protectedProductionPath ||
    root.startsWith(`${protectedProductionPath}/`) ||
    protectedProductionPath.startsWith(`${root}/`);
  if (overlapsProduction) {
    throw new Error(
      "REMOTE_VERIFY_ROOT must not be or contain /mnt/user/appdata/found-and-made",
    );
  }
  return root;
}

export function validateUnixId(value, label, fallback) {
  const candidate = (value ?? String(fallback)).trim();
  if (!/^[1-9][0-9]{0,9}$/.test(candidate)) {
    throw new Error(`${label} must be a positive non-root Unix ID`);
  }
  const parsed = Number.parseInt(candidate, 10);
  if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) {
    throw new Error(`${label} is outside the supported Unix ID range`);
  }
  return parsed;
}

export function createResourceNames(now = Date.now(), entropy) {
  const random = entropy ?? randomBytes(10).toString("hex");
  if (!/^[a-f0-9]{20}$/.test(random)) {
    throw new Error("resource entropy must be 20 lowercase hexadecimal digits");
  }
  const resourceId = `found-made-remote-${now.toString(36)}-${random}`;
  return {
    cleanupContainer: `${resourceId}-cleanup`,
    container: resourceId,
    image: `${resourceId}:amd64`,
    invalidContainer: `${resourceId}-invalid`,
    resourceId,
  };
}

export function buildSshArguments(config, remoteArguments) {
  return [
    "-T",
    "-i",
    config.keyPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    config.target,
    ...remoteArguments,
  ];
}

export function buildScpArguments(config, localPaths, remoteDirectory) {
  return [
    "-q",
    "-i",
    config.keyPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    ...localPaths,
    `${config.target}:${remoteDirectory}/`,
  ];
}

export function buildArchiveArguments(archivePath) {
  return [
    "-cf",
    archivePath,
    "--exclude=./.data",
    "--exclude=./.git",
    "--exclude=./.react-router",
    "--exclude=./build",
    "--exclude=./coverage",
    "--exclude=./design_handoff_found_and_made",
    "--exclude=./node_modules",
    "--exclude=./.env",
    "--exclude=./.env.*",
    "--exclude=./npm-debug.log*",
    "--exclude=./*.tsbuildinfo",
    "-C",
    projectRoot,
    ".",
  ];
}

export function assertSafeArchiveListing(listing) {
  const forbiddenTopLevel = new Set([
    ".data",
    ".git",
    ".react-router",
    "build",
    "coverage",
    "design_handoff_found_and_made",
    "node_modules",
  ]);
  for (const rawEntry of listing.split(/\r?\n/)) {
    if (!rawEntry) continue;
    const normalized = rawEntry.replaceAll("\\", "/").replace(/^\.\/+/, "");
    if (!normalized) continue;
    const segments = normalized.split("/");
    const topLevel = segments[0];
    if (
      normalized.startsWith("/") ||
      segments.includes("..") ||
      forbiddenTopLevel.has(topLevel) ||
      topLevel === ".env" ||
      topLevel.startsWith(".env.")
    ) {
      throw new Error(`unsafe archive entry rejected: ${rawEntry}`);
    }
  }
}

export function createRemoteVerifierScript({
  pgid,
  puid,
  timeoutSeconds = 890,
}) {
  return `#!/bin/sh
set -eu

# Keep remote work bounded even if the SSH client disappears. The guard is
# deliberately inside the uploaded script so the remote host owns the timer.
if [ "\${FOUND_MADE_TIMEOUT_GUARD:-0}" != 1 ] && command -v timeout >/dev/null 2>&1; then
  FOUND_MADE_TIMEOUT_GUARD=1
  export FOUND_MADE_TIMEOUT_GUARD
  case "\${1:-}" in
    --cleanup-only) SCRIPT_TIMEOUT_SECONDS=25 ;;
    *) SCRIPT_TIMEOUT_SECONDS=${timeoutSeconds} ;;
  esac
  exec timeout -s TERM -k 5s "\${SCRIPT_TIMEOUT_SECONDS}s" sh "$0" "$@"
fi

TASK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
RESOURCE_ID=\${TASK_DIR##*/}
case "$RESOURCE_ID" in
  found-made-remote-*) ;;
  *) printf '%s\\n' "unsafe verification resource name" >&2; exit 2 ;;
esac
case "$RESOURCE_ID" in
  *[!a-z0-9-]*) printf '%s\\n' "unsafe verification resource name" >&2; exit 2 ;;
esac
case "$TASK_DIR" in
  /mnt/user/appdata/found-and-made|/mnt/user/appdata/found-and-made/*)
    printf '%s\\n' "protected production path rejected" >&2
    exit 2
    ;;
esac

IMAGE="$RESOURCE_ID:amd64"
CONTAINER="$RESOURCE_ID"
INVALID_CONTAINER="$RESOURCE_ID-invalid"
CLEANUP_CONTAINER="$RESOURCE_ID-cleanup"
SOURCE_DIR="$TASK_DIR/source"
DATA_DIR="$TASK_DIR/data"
ARCHIVE="$TASK_DIR/source.tar"
PUID=${puid}
PGID=${pgid}
HOST_UID=$(id -u)
HOST_GID=$(id -g)
HTTP_BODY="$TASK_DIR/http-body"

docker_cmd() {
  sudo -n docker "$@"
}

emit() {
  printf '%s\\n' "{\\"event\\":\\"$1\\"}"
}

fail() {
  printf '%s\\n' "remote container verification failed: $*" >&2
  exit 1
}

resource_exists() {
  docker_cmd "$1" inspect "$2" >/dev/null 2>&1
}

cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ "$result" -ne 0 ] && resource_exists container "$CONTAINER"; then
    printf '%s\n' "remote container diagnostic state:" >&2
    docker_cmd inspect --format \
      'status={{.State.Status}} exit={{.State.ExitCode}} error={{json .State.Error}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
      "$CONTAINER" >&2
    printf '%s\n' "remote container diagnostic logs:" >&2
    docker_cmd logs --tail 200 "$CONTAINER" >&2
  fi
  docker_cmd rm --force "$CONTAINER" >/dev/null 2>&1
  docker_cmd rm --force "$INVALID_CONTAINER" >/dev/null 2>&1
  docker_cmd rm --force "$CLEANUP_CONTAINER" >/dev/null 2>&1
  if resource_exists image "$IMAGE"; then
    docker_cmd run --rm --name "$CLEANUP_CONTAINER" --user 0 \\
      --entrypoint chown --volume "$DATA_DIR:/cleanup" "$IMAGE" \\
      -R "$HOST_UID:$HOST_GID" /cleanup >/dev/null 2>&1
    docker_cmd rm --force "$CLEANUP_CONTAINER" >/dev/null 2>&1
    docker_cmd image rm --force "$IMAGE" >/dev/null 2>&1
  fi
  rm -rf -- "$TASK_DIR"
  exit "$result"
}

trap cleanup EXIT HUP INT TERM

if [ "\${1:-}" = "--cleanup-only" ]; then
  exit 0
fi

command -v sudo >/dev/null 2>&1 || fail "sudo is unavailable"
command -v docker >/dev/null 2>&1 || fail "docker is unavailable"
command -v tar >/dev/null 2>&1 || fail "tar is unavailable"
command -v curl >/dev/null 2>&1 || fail "curl is unavailable"
docker_cmd version >/dev/null 2>&1 || fail "Docker Engine is unavailable"

for existing in "$CONTAINER" "$INVALID_CONTAINER" "$CLEANUP_CONTAINER"; do
  if resource_exists container "$existing"; then
    fail "task resource already exists: $existing"
  fi
done
if resource_exists image "$IMAGE"; then
  fail "task image already exists: $IMAGE"
fi

mkdir -m 700 -- "$SOURCE_DIR" "$DATA_DIR"
tar -xf "$ARCHIVE" -C "$SOURCE_DIR"
rm -f -- "$ARCHIVE"

emit build_started
docker_cmd build --quiet --platform linux/amd64 --tag "$IMAGE" "$SOURCE_DIR"
emit build_complete

set +e
ROOT_REJECTION=$(docker_cmd run --rm --name "$INVALID_CONTAINER" \\
  --env PUID=0 --env PGID="$PGID" "$IMAGE" 2>&1)
ROOT_STATUS=$?
set -e
[ "$ROOT_STATUS" -ne 0 ] || fail "container accepted root PUID"
printf '%s' "$ROOT_REJECTION" | grep -F "PUID must not be root (0)" >/dev/null \\
  || fail "root PUID rejection message was not observed"
emit root_identity_rejected

docker_cmd run --detach --name "$CONTAINER" \\
  --publish 127.0.0.1::3000 \\
  --read-only \\
  --tmpfs /tmp:rw,noexec,nosuid,size=16777216 \\
  --health-interval 1s \\
  --health-start-period 1s \\
  --health-timeout 2s \\
  --health-retries 3 \\
  --volume "$DATA_DIR:/data" \\
  --env PUID="$PUID" \\
  --env PGID="$PGID" \\
  --env ALLOW_INSECURE_PUBLIC_ORIGIN=true \\
  --env PUBLIC_ORIGIN=http://127.0.0.1:3000 \\
  "$IMAGE" >/dev/null

resolve_host_port() {
  PORT_BINDING=$(docker_cmd port "$CONTAINER" 3000/tcp)
  PORT_LINES=$(printf '%s\\n' "$PORT_BINDING" | wc -l | tr -d ' ')
  [ "$PORT_LINES" = 1 ] \\
    || fail "container has more than one published port binding"
  case "$PORT_BINDING" in
    127.0.0.1:*) ;;
    *) fail "container port is not bound only to IPv4 loopback: $PORT_BINDING" ;;
  esac
  HOST_PORT=\${PORT_BINDING##*:}
  case "$HOST_PORT" in
    ''|*[!0-9]*) fail "Docker did not assign a numeric host port" ;;
  esac
}

resolve_host_port
emit container_started

http_status() {
  curl --silent --show-error --max-time 3 --output "$HTTP_BODY" \\
    --write-out '%{http_code}' "http://127.0.0.1:$HOST_PORT$1" 2>/dev/null || true
}

wait_ready() {
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    CONTAINER_STATE=$(docker_cmd inspect --format '{{.State.Status}}' \
      "$CONTAINER" 2>/dev/null || true)
    case "$CONTAINER_STATE" in
      exited|dead) fail "container exited before readiness" ;;
    esac
    LIVE_STATUS=$(http_status /health/live)
    READY_STATUS=$(http_status /health/ready)
    if [ "$LIVE_STATUS" = 200 ] && [ "$READY_STATUS" = 200 ]; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  fail "application did not become live and ready within 60 seconds"
}

wait_health() {
  expected=$1
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    actual=$(docker_cmd inspect --format \\
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \\
      "$CONTAINER" 2>/dev/null || true)
    if [ "$actual" = "$expected" ]; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  fail "Docker health did not become $expected within 60 seconds"
}

wait_ready
wait_health healthy

SYSTEM_JSON=$(curl --fail --silent --show-error --max-time 3 \\
  "http://127.0.0.1:$HOST_PORT/api/v1/system")
INSTALLATION_ID=$(printf '%s' "$SYSTEM_JSON" | \\
  sed -n 's/.*"installationId":"\\([^"]*\\)".*/\\1/p')
[ -n "$INSTALLATION_ID" ] || fail "system installation identity is missing"

PROCESS_TABLE=$(docker_cmd top "$CONTAINER" -eo pid,uid,gid,args)
APPLICATION_PROCESSES=$(printf '%s\\n' "$PROCESS_TABLE" | \\
  awk -v uid="$PUID" -v gid="$PGID" \\
    '$2 == uid && $3 == gid && $0 ~ /node server\\.js([[:space:]]|$)/')
[ "$(printf '%s\\n' "$APPLICATION_PROCESSES" | sed '/^$/d' | wc -l | tr -d ' ')" = 1 ] \\
  || fail "Node application process is not running as requested PUID/PGID"

OWNERSHIP=$(docker_cmd exec "$CONTAINER" stat -c '%u:%g' \\
  /data /data/db /data/db/found-and-made.sqlite \\
  /data/keys /data/keys/instance.key)
EXPECTED_OWNERSHIP="$PUID:$PGID"
[ "$(printf '%s\\n' "$OWNERSHIP" | wc -l | tr -d ' ')" = 5 ] \\
  || fail "durable ownership result was incomplete"
[ "$(printf '%s\\n' "$OWNERSHIP" | grep -Fvx "$EXPECTED_OWNERSHIP" | wc -l | tr -d ' ')" = 0 ] \\
  || fail "durable files are not owned by requested PUID/PGID"
emit process_and_ownership_verified

docker_cmd exec --user 0 "$CONTAINER" chmod 0555 /data/keys
UNAVAILABLE_STATUS=$(http_status /health/ready)
[ "$UNAVAILABLE_STATUS" = 503 ] \\
  || fail "expected storage readiness 503, got $UNAVAILABLE_STATUS"
wait_health unhealthy
docker_cmd exec --user 0 "$CONTAINER" chmod 0755 /data/keys
wait_ready
wait_health healthy
emit readiness_transition_verified

docker_cmd stop --time 8 "$CONTAINER" >/dev/null
STOPPED_STATE=$(docker_cmd inspect --format '{{.State.Status}}' "$CONTAINER")
[ "$STOPPED_STATE" = exited ] || fail "container did not enter exited state"
STOPPED_LOGS=$(docker_cmd logs --tail 500 "$CONTAINER" 2>&1)
printf '%s' "$STOPPED_LOGS" | grep -F '"event":"server.stopped"' >/dev/null \\
  || fail "graceful shutdown log was not observed"
emit graceful_shutdown_verified

docker_cmd start "$CONTAINER" >/dev/null
resolve_host_port
wait_ready
wait_health healthy
RESTARTED_JSON=$(curl --fail --silent --show-error --max-time 3 \\
  "http://127.0.0.1:$HOST_PORT/api/v1/system")
RESTARTED_ID=$(printf '%s' "$RESTARTED_JSON" | \\
  sed -n 's/.*"installationId":"\\([^"]*\\)".*/\\1/p')
[ "$RESTARTED_ID" = "$INSTALLATION_ID" ] \\
  || fail "installation identity changed after restart"
emit persistence_verified
emit remote_container_verification_complete
`;
}

export async function loadConfiguration(environment = process.env) {
  const target = validateRemoteTarget(environment.REMOTE_VERIFY_TARGET);
  const root = validateRemoteRoot(environment.REMOTE_VERIFY_ROOT);
  const keyValue = environment.REMOTE_VERIFY_KEY?.trim();
  if (!keyValue) throw new Error("REMOTE_VERIFY_KEY is required");
  if (!isAbsolute(keyValue)) {
    throw new Error("REMOTE_VERIFY_KEY must be an absolute local path");
  }
  const keyPath = resolve(keyValue);
  const keyStats = await stat(keyPath).catch(() => undefined);
  if (!keyStats?.isFile()) {
    throw new Error("REMOTE_VERIFY_KEY must name an existing local file");
  }

  const timeoutCandidate =
    environment.REMOTE_VERIFY_TIMEOUT_MS ?? String(defaultTimeoutMs);
  if (!/^[0-9]+$/.test(timeoutCandidate)) {
    throw new Error("REMOTE_VERIFY_TIMEOUT_MS must be numeric");
  }
  const timeoutMs = Number.parseInt(timeoutCandidate, 10);
  if (timeoutMs < 60_000 || timeoutMs > 1_800_000) {
    throw new Error(
      "REMOTE_VERIFY_TIMEOUT_MS must be between 60000 and 1800000",
    );
  }

  return {
    keyPath,
    pgid: validateUnixId(
      environment.REMOTE_VERIFY_PGID,
      "REMOTE_VERIFY_PGID",
      10002,
    ),
    puid: validateUnixId(
      environment.REMOTE_VERIFY_PUID,
      "REMOTE_VERIFY_PUID",
      10001,
    ),
    root,
    target,
    timeoutMs,
  };
}

export async function runRemoteVerification(environment = process.env) {
  const config = await loadConfiguration(environment);
  const names = createResourceNames();
  const remoteTaskDirectory = `${config.root}/${names.resourceId}`;
  const localDirectory = await mkdtemp(
    join(tmpdir(), "found-made-remote-verify-"),
  );
  const archivePath = join(localDirectory, "source.tar");
  const verifierPath = join(localDirectory, "verify.sh");
  let stagingCreated = false;

  emit("remote_container_verification.started", {
    resourceId: names.resourceId,
    target: config.target,
  });

  try {
    const rootCheck = await ssh(config, ["test", "-d", config.root], 15_000, {
      acceptExitCodes: [0, 1],
      label: "check remote verification root",
    });
    if (rootCheck.code !== 0) {
      throw new Error(
        "REMOTE_VERIFY_ROOT must already exist as a remote directory",
      );
    }
    const canonical = await ssh(
      config,
      ["readlink", "-f", "--", config.root],
      15_000,
      { label: "canonicalize remote verification root" },
    );
    if (canonical.stdout.trim() !== config.root) {
      throw new Error(
        "REMOTE_VERIFY_ROOT must be canonical and must not be a symlink",
      );
    }

    const collisionCheck = await ssh(
      config,
      ["test", "-e", remoteTaskDirectory],
      15_000,
      {
        acceptExitCodes: [0, 1],
        label: "check unique remote staging directory",
      },
    );
    if (collisionCheck.code === 0) {
      throw new Error("unique remote verification directory already exists");
    }

    await ssh(
      config,
      ["mkdir", "-m", "700", "--", remoteTaskDirectory],
      15_000,
      { label: "create unique remote staging directory" },
    );
    stagingCreated = true;

    await command("tar.exe", buildArchiveArguments(archivePath), 120_000, {
      label: "create bounded verification source archive",
    });
    const archiveListing = await command(
      "tar.exe",
      ["-tf", archivePath],
      60_000,
      { label: "inspect verification source archive" },
    );
    assertSafeArchiveListing(archiveListing.stdout);

    await writeFile(
      verifierPath,
      createRemoteVerifierScript({
        pgid: config.pgid,
        puid: config.puid,
        timeoutSeconds: Math.max(45, Math.floor(config.timeoutMs / 1_000) - 10),
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    await command(
      "scp.exe",
      buildScpArguments(
        config,
        [archivePath, verifierPath],
        remoteTaskDirectory,
      ),
      120_000,
      { label: "upload verification archive and harness" },
    );

    const result = await ssh(
      config,
      ["sh", `${remoteTaskDirectory}/verify.sh`],
      config.timeoutMs,
      { label: "run isolated remote container verification" },
    );
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    emit("remote_container_verification.complete", {
      resourceId: names.resourceId,
    });
  } finally {
    if (stagingCreated) {
      await cleanupRemote(config, names, remoteTaskDirectory);
    }
    await rm(localDirectory, { force: true, recursive: true });
    emit("remote_container_verification.cleanup_complete", {
      resourceId: names.resourceId,
    });
  }
}

async function cleanupRemote(config, names, remoteTaskDirectory) {
  const cleanupScript = await ssh(
    config,
    ["test", "-f", `${remoteTaskDirectory}/verify.sh`],
    15_000,
    {
      acceptExitCodes: [0, 1],
      label: "check task cleanup harness",
    },
  ).catch(() => undefined);
  if (cleanupScript?.code === 0) {
    await sshIgnoringFailure(
      config,
      ["sh", `${remoteTaskDirectory}/verify.sh`, "--cleanup-only"],
      "run exact task cleanup harness",
    );
  }
  await sshIgnoringFailure(
    config,
    ["sudo", "-n", "docker", "rm", "--force", names.container],
    "remove exact task container",
  );
  await sshIgnoringFailure(
    config,
    ["sudo", "-n", "docker", "rm", "--force", names.invalidContainer],
    "remove exact invalid task container",
  );
  await sshIgnoringFailure(
    config,
    ["sudo", "-n", "docker", "rm", "--force", names.cleanupContainer],
    "remove exact task cleanup container",
  );
  await sshIgnoringFailure(
    config,
    ["sudo", "-n", "docker", "image", "rm", "--force", names.image],
    "remove exact task image",
  );
  await sshIgnoringFailure(
    config,
    ["rm", "-rf", "--", remoteTaskDirectory],
    "remove exact remote staging directory",
  );
}

async function sshIgnoringFailure(config, remoteArguments, label) {
  try {
    await ssh(config, remoteArguments, 30_000, { label });
  } catch (error) {
    emit("remote_container_verification.cleanup_warning", {
      label,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function ssh(config, remoteArguments, timeoutMs, options) {
  return command(
    "ssh.exe",
    buildSshArguments(config, remoteArguments),
    timeoutMs,
    options,
  );
}

function command(
  executable,
  args,
  timeoutMs,
  { acceptExitCodes = [0], label },
) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: projectRoot,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child).finally(() => {
        finish(() =>
          reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        );
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", (error) => {
      if (timedOut) return;
      finish(() =>
        reject(new Error(`${label} could not start: ${error.message}`)),
      );
    });
    child.once("close", (code) => {
      if (timedOut) return;
      finish(() => {
        const normalizedCode = code ?? -1;
        if (acceptExitCodes.includes(normalizedCode)) {
          resolvePromise({ code: normalizedCode, stderr, stdout });
        } else {
          reject(
            new Error(
              `${label} failed with exit code ${normalizedCode}: ${
                stderr || stdout || "no output"
              }`,
            ),
          );
        }
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
  return new Promise((resolvePromise) => {
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
      resolvePromise();
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
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

function remainingTime(deadline) {
  return Math.max(0, deadline - Date.now());
}

function appendBounded(current, chunk) {
  const combined = current + String(chunk);
  return combined.length <= maximumOutputCharacters
    ? combined
    : combined.slice(-maximumOutputCharacters);
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

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runRemoteVerification().catch((error) => {
    emit("remote_container_verification.failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
