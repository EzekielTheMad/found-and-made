import compression from "compression";
import express from "express";

const BUILD_PATH = "./build/server/index.js";
const DEVELOPMENT = process.env.NODE_ENV === "development";
const host = process.env.HOST || "0.0.0.0";
const port = Number.parseInt(process.env.PORT || "3000", 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const outerApp = express();
outerApp.disable("x-powered-by");
outerApp.use(compression());

/**
 * @typedef {{
 *   app: import("express").Express,
 *   createOwnerRecoveryLink: (ownerEmail?: string) => string,
 *   initializeRuntime: () => Promise<void>,
 *   shutdownRuntime: () => Promise<void>
 * }} RuntimeModule
 */

/** @type {RuntimeModule} */
let runtimeModule;
/** @type {import("vite").ViteDevServer | undefined} */
let viteDevServer;

if (DEVELOPMENT) {
  const developmentServer = await import("vite").then((vite) =>
    vite.createServer({
      server: { middlewareMode: true },
    }),
  );
  viteDevServer = developmentServer;
  runtimeModule = /** @type {RuntimeModule} */ (
    await developmentServer.ssrLoadModule("./server/app.ts")
  );
  await runtimeModule.initializeRuntime();
  outerApp.use(developmentServer.middlewares);
  outerApp.use(async (request, response, next) => {
    try {
      const source = /** @type {RuntimeModule} */ (
        await developmentServer.ssrLoadModule("./server/app.ts")
      );
      return await source.app(request, response, next);
    } catch (error) {
      if (error instanceof Error) {
        developmentServer.ssrFixStacktrace(error);
      }
      next(error);
    }
  });
} else {
  runtimeModule = /** @type {RuntimeModule} */ (await import(BUILD_PATH));
  await runtimeModule.initializeRuntime();
  outerApp.use(
    "/assets",
    express.static("build/client/assets", {
      immutable: true,
      maxAge: "1y",
    }),
  );
  outerApp.use(express.static("build/client", { maxAge: "1h" }));
  outerApp.use(runtimeModule.app);
}

if (process.argv[2] === "recover-owner") {
  try {
    const url = runtimeModule.createOwnerRecoveryLink(process.argv[3]);
    console.log(JSON.stringify({ event: "owner.recovery_link_created", url }));
    await runtimeModule.shutdownRuntime();
    await viteDevServer?.close();
    process.exit(0);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "owner.recovery_link_failed",
        message: error instanceof Error ? error.message : "unknown error",
      }),
    );
    await runtimeModule.shutdownRuntime();
    await viteDevServer?.close();
    process.exit(1);
  }
}

const server = outerApp.listen(port, host, () => {
  console.log(
    JSON.stringify({
      event: "server.started",
      host,
      pid: process.pid,
      port,
      startedAt: new Date().toISOString(),
    }),
  );
});

let shuttingDown = false;

/** @param {string} signal */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(JSON.stringify({ event: "server.stopping", signal }));
  const forceTimer = setTimeout(() => process.exit(1), 10_000);
  forceTimer.unref();

  await /** @type {Promise<void>} */ (
    new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })
  );
  await runtimeModule.shutdownRuntime();
  await viteDevServer?.close();
  clearTimeout(forceTimer);
  console.log(JSON.stringify({ event: "server.stopped" }));
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown(signal).catch((error) => {
      console.error(
        JSON.stringify({
          event: "server.shutdown_failed",
          message: error instanceof Error ? error.message : "unknown error",
        }),
      );
      process.exitCode = 1;
    });
  });
}
