import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import {
  createServer as createHttpsServer,
  request as httpsRequest,
} from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generate } from "selfsigned";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = await mkdtemp(join(tmpdir(), "found-made-https-proxy-"));
const CLEANUP_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 2_000;
let backend;
let proxy;
let verificationError;

try {
  const backendPort = await availablePort();
  const certificates = await ephemeralCertificates();
  proxy = createHttpsServer(
    { cert: certificates.server.cert, key: certificates.server.private },
    (request, response) => {
      const forwarded = httpRequest(
        {
          headers: {
            ...request.headers,
            connection: "close",
            host: `127.0.0.1:${backendPort}`,
            "x-forwarded-for": "203.0.113.10",
            "x-forwarded-host": request.headers.host,
            "x-forwarded-proto": "https",
          },
          host: "127.0.0.1",
          method: request.method,
          path: request.url,
          port: backendPort,
        },
        (upstream) => {
          response.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(response);
        },
      );
      forwarded.setTimeout(REQUEST_TIMEOUT_MS, () =>
        forwarded.destroy(new Error("HTTPS proxy upstream timed out")),
      );
      forwarded.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.pipe(forwarded);
    },
  );
  await listen(proxy);
  const proxyAddress = proxy.address();
  assert(
    proxyAddress && typeof proxyAddress !== "string",
    "HTTPS proxy did not bind an ephemeral port",
  );
  const publicOrigin = `https://localhost:${proxyAddress.port}`;

  backend = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      PORT: String(backendPort),
      PUBLIC_ORIGIN: publicOrigin,
      TRUSTED_PROXY_RANGES: "127.0.0.0/8,::1/128",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const backendOutput = [];
  const backendErrors = [];
  backend.stdout.setEncoding("utf8");
  backend.stderr.setEncoding("utf8");
  backend.stdout.on("data", (chunk) => backendOutput.push(chunk));
  backend.stderr.on("data", (chunk) => backendErrors.push(chunk));

  process.stdout.write(
    `${JSON.stringify({
      backendPid: backend.pid,
      backendPort,
      event: "https_proxy_verification.started",
      proxyPort: proxyAddress.port,
    })}\n`,
  );

  await waitForReady({
    backendErrors,
    backendOutput,
    ca: certificates.ca.cert,
    port: proxyAddress.port,
  });

  const setupBody = new URLSearchParams({
    email: "https-owner@example.test",
    name: "HTTPS Owner",
    password: "https verification password",
  }).toString();
  const setup = await throughProxy({
    body: setupBody,
    ca: certificates.ca.cert,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: publicOrigin,
      "sec-fetch-site": "same-origin",
    },
    method: "POST",
    path: "/setup",
    port: proxyAddress.port,
  });
  assert(
    setup.status === 302 && setup.headers.location === "/",
    "HTTPS setup mutation did not succeed through the trusted proxy",
  );
  const setCookies = arrayHeader(setup.headers["set-cookie"]);
  assert(
    setCookies.some(
      (cookie) =>
        /;\s*Secure/i.test(cookie) &&
        /;\s*HttpOnly/i.test(cookie) &&
        /;\s*SameSite=Lax/i.test(cookie),
    ),
    "HTTPS setup did not issue a Secure, HttpOnly, SameSite=Lax cookie",
  );
  const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");

  const privatePreview = await throughProxy({
    ca: certificates.ca.cert,
    path: "/public/recipes/unknown-recipe",
    port: proxyAddress.port,
  });
  assert(privatePreview.status === 200, "private preview did not render");
  assert(
    privatePreview.headers["strict-transport-security"]?.includes(
      "max-age=31536000",
    ),
    "HTTPS topology did not enable HSTS",
  );
  assert(
    privatePreview.body.includes(
      `<link rel="canonical" href="${publicOrigin}/public/recipes/unknown-recipe"`,
    ) &&
      privatePreview.body.includes(
        `property="og:url" content="${publicOrigin}/public/recipes/unknown-recipe"`,
      ),
    "canonical and Open Graph URLs were not pinned to PUBLIC_ORIGIN",
  );

  const blocked = await throughProxy({
    ca: certificates.ca.cert,
    headers: {
      cookie,
      origin: "https://attacker.example.test",
      "sec-fetch-site": "cross-site",
    },
    method: "POST",
    path: "/sign-out",
    port: proxyAddress.port,
  });
  assert(
    blocked.status === 403 &&
      blocked.body.includes("Cross-site request blocked"),
    "cross-origin mutation was not rejected through HTTPS",
  );

  const signedOut = await throughProxy({
    ca: certificates.ca.cert,
    headers: {
      cookie,
      origin: publicOrigin,
      "sec-fetch-site": "same-origin",
    },
    method: "POST",
    path: "/sign-out",
    port: proxyAddress.port,
  });
  assert(
    signedOut.status === 302 && signedOut.headers.location === "/sign-in",
    "same-origin authenticated mutation failed through HTTPS",
  );

  let rateLimited = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const signIn = await throughProxy({
      body: "email=missing%40example.test&password=incorrect-password",
      ca: certificates.ca.cert,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: publicOrigin,
        "sec-fetch-site": "same-origin",
        "x-forwarded-for": `198.51.100.${attempt + 1}`,
      },
      method: "POST",
      path: "/sign-in",
      port: proxyAddress.port,
    });
    if (signIn.status === 429) {
      rateLimited = true;
      break;
    }
  }
  assert(
    rateLimited,
    "proxy did not overwrite spoofed forwarding headers before rate limiting",
  );

  process.stdout.write(
    `${JSON.stringify({
      canonicalOrigin: true,
      csrfRejection: true,
      event: "https_proxy_verification.complete",
      forwardedIdentity: true,
      secureCookie: true,
      trustedTls: true,
    })}\n`,
  );
} catch (error) {
  verificationError = error;
}

const cleanupErrors = [];
try {
  if (backend) await stopBackend(backend);
} catch (error) {
  cleanupErrors.push(error);
}
try {
  if (proxy?.listening) await closeServer(proxy);
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
    "HTTPS proxy verification cleanup failed",
  );
  if (verificationError)
    throw new AggregateError(
      [verificationError, cleanupError],
      "HTTPS proxy verification and cleanup failed",
    );
  throw cleanupError;
}
if (verificationError) throw verificationError;

async function ephemeralCertificates() {
  const now = new Date();
  const notAfterDate = new Date(now.getTime() + 60 * 60 * 1000);
  const ca = await generate(
    [{ name: "commonName", value: "Found and Made Ephemeral Test CA" }],
    {
      algorithm: "sha256",
      extensions: [
        { cA: true, name: "basicConstraints" },
        {
          digitalSignature: true,
          keyCertSign: true,
          name: "keyUsage",
        },
      ],
      notAfterDate,
      notBeforeDate: new Date(now.getTime() - 60_000),
    },
  );
  const server = await generate([{ name: "commonName", value: "localhost" }], {
    algorithm: "sha256",
    ca: { cert: ca.cert, key: ca.private },
    extensions: [
      { cA: false, name: "basicConstraints" },
      { digitalSignature: true, keyEncipherment: true, name: "keyUsage" },
      { name: "extKeyUsage", serverAuth: true },
      {
        altNames: [
          { type: 2, value: "localhost" },
          { ip: "127.0.0.1", type: 7 },
        ],
        name: "subjectAltName",
      },
    ],
    notAfterDate,
    notBeforeDate: new Date(now.getTime() - 60_000),
  });
  return { ca, server };
}

async function waitForReady({ backendErrors, backendOutput, ca, port }) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (backend.exitCode !== null || backend.signalCode !== null) {
      throw new Error(
        `backend exited before HTTPS readiness\nstdout:\n${backendOutput.join("")}\nstderr:\n${backendErrors.join("")}`,
      );
    }
    try {
      const response = await throughProxy({ ca, path: "/health/ready", port });
      if (response.status === 200) return;
    } catch {
      // The backend may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("backend did not become ready through the HTTPS proxy");
}

function throughProxy({
  body = "",
  ca,
  headers = {},
  method = "GET",
  path,
  port,
}) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        ca,
        headers: {
          ...headers,
          ...(body ? { "content-length": Buffer.byteLength(body) } : {}),
        },
        host: "localhost",
        method,
        path,
        port,
        rejectUnauthorized: true,
        servername: "localhost",
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            status: response.statusCode ?? 0,
          }),
        );
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () =>
      request.destroy(new Error("HTTPS verification request timed out")),
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function availablePort() {
  const server = await import("node:net").then(({ createServer }) =>
    createServer(),
  );
  server.unref();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(
    address && typeof address !== "string",
    "failed to reserve backend port",
  );
  const port = address.port;
  await closeServer(server);
  return port;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function closeServer(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function stopBackend(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  const completed = await Promise.race([
    exit.then(() => true),
    new Promise((resolve) =>
      setTimeout(() => resolve(false), CLEANUP_TIMEOUT_MS),
    ),
  ]);
  if (completed) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: CLEANUP_TIMEOUT_MS,
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

function arrayHeader(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
