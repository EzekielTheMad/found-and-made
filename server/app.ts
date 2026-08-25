import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createRequestHandler } from "@react-router/express";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import express from "express";
import { RouterContextProvider } from "react-router";
import sharp from "sharp";

import { appRuntimeContext } from "~/context";
import {
  createRuntime,
  getApplicationRuntime,
  initializeApplicationRuntime,
  shutdownApplicationRuntime,
} from "#src/platform/runtime.server";
import { authConfigurationFromEnv } from "#src/platform/auth/auth.server";
import { publicUrl } from "#src/platform/http/public-origin.server";
import {
  applyOfflineOperations,
  offlineLibrary,
  offlineRecipe,
} from "#src/platform/offline/offline-api.server";
import { bearerToken } from "#src/platform/mcp/found-made-mcp-handler.server";
import {
  sendWebResponse,
  toWebRequest,
} from "#src/platform/mcp/express-web-adapter.server";
import { rejectMcpTransportRequest } from "#src/platform/mcp/mcp-transport-config.server";
import {
  createHttpBaseline,
  genericHttpError,
  unknownApiRoute,
} from "./middleware/http-baseline";
import {
  configureTrustedProxy,
  createRequestProtection,
} from "./middleware/request-protection";

export const app = express();
const authConfiguration = authConfigurationFromEnv();

app.disable("x-powered-by");
configureTrustedProxy(app);
app.use(
  createHttpBaseline({
    enableHsts: authConfiguration.secureCookies,
    enableOriginIsolation: authConfiguration.secureCookies,
  }),
);
app.use(
  createRequestProtection({ publicOrigin: authConfiguration.publicOrigin }),
);

app.get("/health/live", (_request, response) => {
  response.status(200).json({ status: "live" });
});

app.get("/favicon.ico", (_request, response) => {
  response.status(204).end();
});

app.get("/health/ready", async (_request, response) => {
  try {
    await getApplicationRuntime().ready();
    response.status(200).json({ status: "ready" });
  } catch {
    response.status(503).json({ status: "unavailable" });
  }
});

app.get("/api/v1/system", (_request, response) => {
  const status = getApplicationRuntime().systemService.getStatus();
  response.status(200).json({
    installationId: status.installationId,
    name: "Found & Made",
    version: "0.1.0-alpha.0",
  });
});

let socialCard: Promise<Buffer> | undefined;
app.get("/public/assets/social-card.webp", async (_request, response) => {
  socialCard ??= sharp(
    Buffer.from(`
      <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
        <rect width="1200" height="630" fill="#f7f0e7"/>
        <rect x="56" y="56" width="1088" height="518" rx="36" fill="#24352d"/>
        <text x="112" y="274" fill="#f7f0e7" font-family="serif" font-size="92" font-weight="700">Found &amp; Made</text>
        <text x="116" y="356" fill="#d9b57b" font-family="sans-serif" font-size="38">Recipes from anywhere, made yours.</text>
      </svg>`),
  )
    .webp({ effort: 4, quality: 88 })
    .toBuffer();
  response.set({
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": "image/webp",
  });
  response.send(await socialCard);
});

app.all("/api/auth/*splat", async (request, response) => {
  await toNodeHandler(getApplicationRuntime().auth)(request, response);
});

const mcpJson = express.json({ limit: "128kb", type: "application/json" });
app.all(
  "/mcp",
  (request, response, next) => {
    const runtime = getApplicationRuntime();
    const rejection = rejectMcpTransportRequest(runtime.mcpTransportConfig, {
      ...(request.get("host") ? { host: request.get("host") } : {}),
      ...(request.get("origin") ? { origin: request.get("origin") } : {}),
      ...(request.socket.remoteAddress
        ? { remoteAddress: request.socket.remoteAddress }
        : {}),
    });
    if (rejection === "disabled") return response.status(404).end();
    if (rejection) return response.status(403).end();
    if (request.method === "POST" && !request.is("application/json")) {
      return response.status(415).end();
    }
    try {
      const authenticated = runtime.mcpService.authenticateToken(
        bearerToken(request.get("authorization")),
      );
      const rate = runtime.mcpRequestLimiter.consume(authenticated.token.id);
      if (!rate.allowed) {
        response.set({
          "Cache-Control": "no-store",
          "Retry-After": String(rate.retryAfterSeconds),
        });
        return response.status(429).end();
      }
    } catch {
      response.set({
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Bearer realm="Found & Made MCP"',
      });
      return response.status(401).end();
    }
    mcpJson(request, response, (error) => {
      if (error) return response.status(400).end();
      next();
    });
  },
  async (request, response, next) => {
    try {
      const parsedBody = request.body as unknown;
      const webRequest = toWebRequest(request, parsedBody);
      const webResponse = await getApplicationRuntime().mcpHttpHandler.fetch(
        webRequest,
        { parsedBody },
      );
      response.set("Cache-Control", "no-store");
      await sendWebResponse(webResponse, response);
    } catch (error) {
      if (!response.headersSent) next(error);
      else response.destroy(error instanceof Error ? error : undefined);
    }
  },
);

app.get("/api/media/:mediaId/:variant", async (request, response, next) => {
  try {
    const runtime = getApplicationRuntime();
    const session = await runtime.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    if (!session) return response.status(404).end();
    const principal = runtime.identityService.principalForUser(session.user.id);
    const mediaId = String(request.params.mediaId);
    const variant = mediaVariant(request.params.variant);
    runtime.mediaService.get(principal, mediaId);
    const file = runtime.mediaService.file(mediaId, variant);
    response.set({
      "Cache-Control": "private, max-age=86400, stale-while-revalidate=604800",
      "Content-Type": file.contentType,
      "X-Found-Made-Offline-Cache": "allowed",
    });
    response.sendFile(file.path, (error) => {
      if (error) next(error);
    });
  } catch {
    response.status(404).end();
  }
});

app.get("/api/offline/library", async (request, response) => {
  const principal = await apiPrincipal(request);
  if (!principal) return response.status(401).json({ status: 401 });
  try {
    const runtime = getApplicationRuntime();
    response.set("X-Found-Made-Offline-Cache", "allowed");
    response.json(
      offlineLibrary(principal, {
        cooking: runtime.cookingService,
        media: runtime.mediaService,
        recipes: runtime.recipeAccessService,
      }),
    );
  } catch {
    response.status(404).json({ status: 404 });
  }
});

app.get("/api/offline/recipes/:recipeId", async (request, response) => {
  const principal = await apiPrincipal(request);
  if (!principal) return response.status(401).json({ status: 401 });
  try {
    const runtime = getApplicationRuntime();
    response.set("X-Found-Made-Offline-Cache", "allowed");
    response.json(
      offlineRecipe(principal, String(request.params.recipeId), {
        cooking: runtime.cookingService,
        media: runtime.mediaService,
        recipes: runtime.recipeAccessService,
      }),
    );
  } catch {
    response.status(404).json({ status: 404 });
  }
});

const offlineJson = express.json({ limit: "256kb", type: "application/json" });
app.post(
  "/api/offline/operations",
  (request, response, next) => {
    offlineJson(request, response, (error) => {
      if (error) {
        response.status(400).json({ status: 400 });
        return;
      }
      next();
    });
  },
  async (request, response) => {
    const principal = await apiPrincipal(request);
    if (!principal) return response.status(401).json({ status: 401 });
    const body: unknown = request.body;
    const operations =
      body && typeof body === "object" && "operations" in body
        ? (body as { operations?: unknown }).operations
        : undefined;
    if (!Array.isArray(operations))
      return response.status(400).json({ status: 400 });
    try {
      const runtime = getApplicationRuntime();
      const appliedOperationIds = applyOfflineOperations(
        principal,
        operations,
        runtime.cookingService,
        runtime.recipeAccessService,
      );
      response.json({ appliedOperationIds });
    } catch {
      response.status(409).json({ status: 409 });
    }
  },
);

app.get("/public/media/:mediaId/:variant", (request, response, next) => {
  try {
    const variant = mediaVariant(request.params.variant);
    if (variant === "original") return response.status(404).end();
    const runtime = getApplicationRuntime();
    const file = runtime.mediaService.file(
      String(request.params.mediaId),
      variant,
    );
    if (!runtime.publishingService.getPublicRecipe(file.recipeId)) {
      return response.status(404).end();
    }
    response.set({
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": file.contentType,
    });
    response.sendFile(file.path, (error) => {
      if (error) next(error);
    });
  } catch {
    response.status(404).end();
  }
});

app.use("/api", unknownApiRoute);

app.use(
  createRequestHandler({
    build: () => import("virtual:react-router/server-build"),
    getLoadContext() {
      const context = new RouterContextProvider();
      context.set(appRuntimeContext, getApplicationRuntime());
      return context;
    },
  }),
);
app.use(genericHttpError);

export async function initializeRuntime(): Promise<void> {
  await initializeApplicationRuntime();
}

export async function shutdownRuntime(): Promise<void> {
  await shutdownApplicationRuntime();
}

export async function backupCreate() {
  const runtime = await createRuntime({ startWorker: false });
  try {
    return await runtime.backupService.createOnlineBackup();
  } finally {
    await runtime.close();
  }
}

export async function backupVerify(backupDirectory: string) {
  const runtime = await createRuntime({ startWorker: false });
  try {
    return await runtime.backupService.verify(backupDirectory);
  } finally {
    await runtime.close();
  }
}

export async function backupRestoreCold(
  backupDirectory: string,
  targetRoot: string,
) {
  const target = resolve(targetRoot);
  const configuredLiveRoot = resolve(process.env.DATA_DIR ?? ".data");
  if (target === configuredLiveRoot) {
    throw new Error(
      "Cold restore target must be a separate empty mounted volume, not DATA_DIR",
    );
  }

  const referenceRoot = await mkdtemp(
    join(tmpdir(), "found-made-restore-ref-"),
  );
  let referenceRuntime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    referenceRuntime = await createRuntime({
      dataDir: referenceRoot,
      startWorker: false,
    });
    await referenceRuntime.backupService.restore(backupDirectory, target);
    return { restored: true };
  } finally {
    await referenceRuntime?.close();
    await rm(referenceRoot, { force: true, recursive: true });
  }
}

export function createOwnerRecoveryLink(ownerEmail?: string): string {
  const recovery =
    getApplicationRuntime().recoveryService.issueServerOwnerRecovery(
      ownerEmail,
    );
  return publicUrl(`/recover/${recovery.token}`);
}

function mediaVariant(value: unknown): "original" | "social" | "web" {
  if (value === "original" || value === "social" || value === "web")
    return value;
  throw new Error("Unknown media variant");
}

async function apiPrincipal(request: express.Request) {
  const runtime = getApplicationRuntime();
  const session = await runtime.auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
  });
  return session
    ? runtime.identityService.principalForUser(session.user.id)
    : null;
}
