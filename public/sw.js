/* global IDBKeyRange, caches, clients, indexedDB, self */

"use strict";

const VERSION = "v1";
const GLOBAL_CACHE = `found-made-global-${VERSION}`;
const PROTECTED_PREFIX = `found-made-protected-${VERSION}-`;
const SHELL_ASSETS = [
  "/manifest.webmanifest",
  "/offline.html",
  "/icons/icon.svg",
  "/icons/maskable-icon.svg",
];
const OFFLINE_CACHE_PERMISSION_HEADER = "x-found-made-offline-cache";
const QUEUE_DB = "found-made-offline-v1";
const QUEUE_STORE = "operations";
const clientContexts = new Map();

const MESSAGE = {
  authContext: "FOUND_MADE_OFFLINE_AUTH_CONTEXT",
  cacheProtected: "FOUND_MADE_OFFLINE_CACHE_PROTECTED",
  clearContext: "FOUND_MADE_OFFLINE_CLEAR_CONTEXT",
  flushComplete: "FOUND_MADE_OFFLINE_FLUSH_COMPLETE",
  flushRequest: "FOUND_MADE_OFFLINE_FLUSH_REQUEST",
  purgeAll: "FOUND_MADE_OFFLINE_PURGE_ALL",
  queueOperation: "FOUND_MADE_OFFLINE_QUEUE_OPERATION",
  recoverContext: "FOUND_MADE_OFFLINE_RECOVER_CONTEXT",
  result: "FOUND_MADE_OFFLINE_RESULT",
  syncRequired: "FOUND_MADE_OFFLINE_SYNC_REQUIRED",
};

const ALLOWED_OPERATIONS = new Set([
  "cooking.note.set",
  "cooking.ingredient-check.set",
  "cooking.step-progress.set",
  "cooking.timer.set",
  "cooking.scale.set",
]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(GLOBAL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)),
      self.skipWaiting(),
    ]),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter(
              (name) =>
                (name.startsWith("found-made-global-") &&
                  name !== GLOBAL_CACHE) ||
                (name.startsWith("found-made-protected-") &&
                  !name.startsWith(PROTECTED_PREFIX)),
            )
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== "GET") {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => offlineDocument(url.pathname)),
    );
    return;
  }

  const policy = classifyRequest(url.pathname);
  if (policy === "global") {
    event.respondWith(globalAssetResponse(request));
    return;
  }

  if (policy === "protected") {
    const cacheName = clientContexts.get(event.clientId);
    event.respondWith(protectedResponse(request, cacheName));
  }
});

async function offlineDocument(path) {
  const cached = await caches.match("/offline.html");
  if (!cached) {
    return unavailableResponse("offline-shell-missing");
  }
  const headers = new Headers(cached.headers);
  headers.set("x-found-made-offline", offlineNavigationKind(path));
  return new Response(await cached.arrayBuffer(), { status: 200, headers });
}

function offlineNavigationKind(path) {
  if (path === "/") {
    return "library";
  }
  return /^\/recipes\/[A-Za-z0-9][A-Za-z0-9._:-]{7,127}\/?$/.test(path)
    ? "recipe"
    : "unavailable";
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (!isRecord(message) || typeof message.type !== "string") {
    return;
  }

  event.waitUntil(handleMessage(event, message));
});

function classifyRequest(path) {
  if (SHELL_ASSETS.includes(path) || path.startsWith("/assets/")) {
    return "global";
  }
  if (
    path === "/api/offline/library" ||
    path.startsWith("/api/offline/recipes/") ||
    path.startsWith("/api/media/")
  ) {
    return "protected";
  }
  return "network";
}

async function globalAssetResponse(request) {
  const cache = await caches.open(GLOBAL_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }

  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
  }
  return response;
}

async function protectedResponse(request, cacheName) {
  if (!cacheName) {
    try {
      return await fetch(request);
    } catch {
      return unavailableResponse("protected-context-required");
    }
  }

  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok && serverAllowsCaching(response)) {
      await cache.put(request, await markCached(response.clone()));
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached
      ? markServedFromCache(cached)
      : unavailableResponse("not-cached");
  }
}

function unavailableResponse(reason) {
  return Response.json(
    { offline: true, available: false, reason },
    {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "x-found-made-offline": "unavailable",
      },
    },
  );
}

function serverAllowsCaching(response) {
  return (
    response.headers.get(OFFLINE_CACHE_PERMISSION_HEADER)?.toLowerCase() ===
    "allowed"
  );
}

async function markCached(response) {
  const headers = new Headers(response.headers);
  headers.set("x-found-made-cached-at", new Date().toISOString());
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function markServedFromCache(response) {
  const headers = new Headers(response.headers);
  headers.set("x-found-made-offline", "cached");
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handleMessage(event, message) {
  const source = event.source;
  const clientId = source && "id" in source ? source.id : null;
  const requestId =
    typeof message.requestId === "string" ? message.requestId : "unknown";

  try {
    switch (message.type) {
      case MESSAGE.authContext: {
        requireClientId(clientId);
        if (typeof message.partitionKey !== "string") {
          throw new Error("A partition key is required.");
        }
        const nextCacheName = await protectedCacheName(message.partitionKey);
        await caches.open(nextCacheName);
        const previousCacheName = clientContexts.get(clientId);
        if (previousCacheName && previousCacheName !== nextCacheName) {
          await purgeNamespace(previousCacheName);
        }
        await purgeOtherProtectedNamespaces(nextCacheName);
        clientContexts.set(clientId, nextCacheName);
        reply(source, { type: MESSAGE.result, requestId, ok: true });
        return;
      }
      case MESSAGE.clearContext: {
        requireClientId(clientId);
        let cacheName = clientContexts.get(clientId);
        if (!cacheName) {
          const names = (await caches.keys()).filter((name) =>
            name.startsWith(PROTECTED_PREFIX),
          );
          if (names.length > 1) {
            await purgeAllProtectedData();
          } else {
            cacheName = names[0];
          }
        }
        if (cacheName) {
          await purgeNamespace(cacheName);
        }
        clientContexts.delete(clientId);
        reply(source, { type: MESSAGE.result, requestId, ok: true });
        return;
      }
      case MESSAGE.purgeAll:
        await purgeAllProtectedData();
        clientContexts.clear();
        reply(source, { type: MESSAGE.result, requestId, ok: true });
        return;
      case MESSAGE.cacheProtected: {
        requireClientId(clientId);
        const cacheName = requireContext(clientId);
        const cachedUrls = await cacheProtectedUrls(cacheName, message.urls);
        reply(source, {
          type: MESSAGE.result,
          requestId,
          ok: true,
          cachedUrls,
        });
        return;
      }
      case MESSAGE.queueOperation: {
        requireClientId(clientId);
        const cacheName = requireContext(clientId);
        const operation = parseOperation(message.operation);
        await putOperation(cacheName, operation);
        reply(source, { type: MESSAGE.result, requestId, ok: true });
        return;
      }
      case MESSAGE.recoverContext: {
        requireClientId(clientId);
        const cacheName = await recoverProtectedCacheName();
        if (!cacheName) {
          throw new Error("No offline recipes are saved for this device.");
        }
        clientContexts.set(clientId, cacheName);
        reply(source, { type: MESSAGE.result, requestId, ok: true });
        return;
      }
      case MESSAGE.flushRequest: {
        requireClientId(clientId);
        const cacheName = requireContext(clientId);
        const operations = await listOperations(cacheName);
        reply(source, { type: MESSAGE.syncRequired, operations });
        reply(source, { type: MESSAGE.result, requestId, ok: true });
        return;
      }
      case MESSAGE.flushComplete: {
        requireClientId(clientId);
        const cacheName = requireContext(clientId);
        await deleteOperations(cacheName, message.operationIds);
        reply(source, { type: MESSAGE.result, requestId, ok: true });
        return;
      }
      default:
        return;
    }
  } catch (error) {
    reply(source, {
      type: MESSAGE.result,
      requestId,
      ok: false,
      error:
        error instanceof Error ? error.message : "Offline operation failed.",
    });
  }
}

function requireClientId(clientId) {
  if (!clientId) {
    throw new Error("An active browser client is required.");
  }
}

function requireContext(clientId) {
  const cacheName = clientContexts.get(clientId);
  if (!cacheName) {
    throw new Error("Authenticate the offline context first.");
  }
  return cacheName;
}

async function protectedCacheName(partitionKey) {
  if (partitionKey.trim().length < 16) {
    throw new Error(
      "Offline partition keys must be opaque and at least 16 characters.",
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(partitionKey),
  );
  const token = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 24);
  return `${PROTECTED_PREFIX}${token}`;
}

async function cacheProtectedUrls(cacheName, value) {
  if (!Array.isArray(value) || value.length > 50) {
    throw new Error("Provide no more than 50 protected URLs.");
  }
  const cache = await caches.open(cacheName);
  const cachedUrls = [];
  for (const rawUrl of value) {
    const url = new URL(String(rawUrl), self.location.origin);
    if (
      url.origin !== self.location.origin ||
      classifyRequest(url.pathname) !== "protected"
    ) {
      throw new Error(
        "Only approved same-origin protected resources may be cached.",
      );
    }
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok || !serverAllowsCaching(response)) {
      continue;
    }
    await cache.put(url, await markCached(response.clone()));
    cachedUrls.push(url.pathname + url.search);
  }
  return cachedUrls;
}

function parseOperation(value) {
  if (!isRecord(value)) {
    throw new Error("Offline operation must be an object.");
  }
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
    throw new Error("Offline operation requires a stable idempotency ID.");
  }
  if (typeof value.kind !== "string" || !ALLOWED_OPERATIONS.has(value.kind)) {
    throw new Error("This operation cannot be queued offline.");
  }
  if (typeof value.recipeId !== "string" || !ID_PATTERN.test(value.recipeId)) {
    throw new Error("Offline operation requires a recipe ID.");
  }
  if (!isRecord(value.payload) || !validPayload(value.kind, value.payload)) {
    throw new Error("Offline operation payload is invalid.");
  }
  if (
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt))
  ) {
    throw new Error("Offline operation requires a valid creation timestamp.");
  }
  return value;
}

function validPayload(kind, payload) {
  switch (kind) {
    case "cooking.note.set":
      return typeof payload.value === "string" && payload.value.length <= 10000;
    case "cooking.ingredient-check.set":
      return (
        validSessionMetadata(payload) &&
        Array.isArray(payload.checkedIngredientIds) &&
        payload.checkedIngredientIds.every(
          (id) => typeof id === "string" && ID_PATTERN.test(id),
        ) &&
        new Set(payload.checkedIngredientIds).size ===
          payload.checkedIngredientIds.length &&
        ID_PATTERN.test(String(payload.ingredientId ?? "")) &&
        typeof payload.checked === "boolean"
      );
    case "cooking.step-progress.set":
      return (
        validSessionMetadata(payload) &&
        Number.isInteger(payload.guidedStepIndex) &&
        payload.guidedStepIndex >= 0 &&
        ID_PATTERN.test(String(payload.stepId ?? "")) &&
        ["pending", "active", "completed"].includes(
          String(payload.status ?? ""),
        )
      );
    case "cooking.timer.set":
      return (
        validSessionMetadata(payload) &&
        validTimerSnapshot(payload.timers) &&
        ID_PATTERN.test(String(payload.timerId ?? "")) &&
        positive(payload.durationSeconds) &&
        typeof payload.remainingSeconds === "number" &&
        Number.isFinite(payload.remainingSeconds) &&
        payload.remainingSeconds >= 0 &&
        ["running", "paused", "complete", "cancelled"].includes(
          String(payload.state ?? ""),
        )
      );
    case "cooking.scale.set":
      return (
        validSessionMetadata(payload) &&
        positive(payload.targetYield) &&
        payload.targetYield <= 100000
      );
    default:
      return false;
  }
}

function validTimerSnapshot(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (timer) =>
        isRecord(timer) &&
        typeof timer.id === "string" &&
        ID_PATTERN.test(timer.id) &&
        typeof timer.label === "string" &&
        timer.label.length <= 200 &&
        positive(timer.durationSeconds) &&
        typeof timer.remainingSeconds === "number" &&
        Number.isFinite(timer.remainingSeconds) &&
        timer.remainingSeconds >= 0 &&
        (timer.startedAt === undefined ||
          timer.startedAt === null ||
          (typeof timer.startedAt === "string" &&
            !Number.isNaN(Date.parse(timer.startedAt)))) &&
        typeof timer.status === "string" &&
        ["running", "paused", "complete", "cancelled"].includes(timer.status),
    )
  );
}

function validSessionMetadata(payload) {
  return (
    (payload.sessionId === null ||
      (typeof payload.sessionId === "string" &&
        ID_PATTERN.test(payload.sessionId))) &&
    typeof payload.clientSessionId === "string" &&
    ID_PATTERN.test(payload.clientSessionId) &&
    Number.isInteger(payload.expectedVersion) &&
    payload.expectedVersion >= 0
  );
}

function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reply(source, message) {
  if (source && "postMessage" in source) {
    source.postMessage(message);
  }
}

async function purgeNamespace(cacheName) {
  await Promise.all([
    caches.delete(cacheName),
    deleteNamespaceOperations(cacheName),
  ]);
}

async function recoverProtectedCacheName() {
  const names = (await caches.keys()).filter((name) =>
    name.startsWith(PROTECTED_PREFIX),
  );
  if (names.length > 1) {
    throw new Error(
      "Offline account context is ambiguous and must be re-authenticated.",
    );
  }
  return names[0] ?? null;
}

async function purgeOtherProtectedNamespaces(currentCacheName) {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter(
        (name) =>
          name.startsWith("found-made-protected-") && name !== currentCacheName,
      )
      .map((name) => purgeNamespace(name)),
  );
}

async function purgeAllProtectedData() {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith("found-made-protected-"))
      .map((name) => caches.delete(name)),
  );
  const database = await openQueueDatabase();
  await transactionComplete(database, "readwrite", (store) => store.clear());
}

function openQueueDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(QUEUE_DB, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(QUEUE_STORE)) {
        const store = database.createObjectStore(QUEUE_STORE, {
          keyPath: "key",
        });
        store.createIndex("namespace", "namespace", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Offline queue unavailable."));
  });
}

async function transactionComplete(database, mode, perform) {
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(QUEUE_STORE, mode);
    perform(transaction.objectStore(QUEUE_STORE));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ?? new Error("Offline queue transaction failed."),
      );
    transaction.onabort = () =>
      reject(
        transaction.error ?? new Error("Offline queue transaction aborted."),
      );
  });
}

async function putOperation(namespace, operation) {
  const database = await openQueueDatabase();
  await transactionComplete(database, "readwrite", (store) => {
    store.put({ key: `${namespace}:${operation.id}`, namespace, operation });
  });
}

async function listOperations(namespace) {
  const database = await openQueueDatabase();
  return await new Promise((resolve, reject) => {
    const transaction = database.transaction(QUEUE_STORE, "readonly");
    const index = transaction.objectStore(QUEUE_STORE).index("namespace");
    const request = index.getAll(IDBKeyRange.only(namespace));
    request.onsuccess = () =>
      resolve(request.result.map((entry) => entry.operation));
    request.onerror = () =>
      reject(request.error ?? new Error("Offline queue could not be read."));
  });
}

async function deleteOperations(namespace, value) {
  if (!Array.isArray(value)) {
    throw new Error("Acknowledged operation IDs must be an array.");
  }
  const database = await openQueueDatabase();
  await transactionComplete(database, "readwrite", (store) => {
    for (const id of value) {
      if (typeof id === "string" && ID_PATTERN.test(id)) {
        store.delete(`${namespace}:${id}`);
      }
    }
  });
}

async function deleteNamespaceOperations(namespace) {
  const database = await openQueueDatabase();
  await transactionComplete(database, "readwrite", (store) => {
    const index = store.index("namespace");
    const request = index.openKeyCursor(IDBKeyRange.only(namespace));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
  });
}
