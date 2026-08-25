import { useEffect, useState } from "react";

import { createClientId } from "~/client-id";

import {
  OFFLINE_MESSAGE,
  type OfflineClientMessage,
  type OfflineWorkerMessage,
} from "#src/modules/offline/offline-contract";
import type { OfflineOperation } from "#src/modules/offline/offline-queue";

const storedPartitionKey = "found-made.offline.partition";

export function OfflineCoordinator({
  partitionKey,
}: {
  partitionKey: string | null;
}) {
  const [state, setState] = useState<"offline" | "online" | "syncing">(
    "online",
  );

  useEffect(() => {
    const serviceWorker = getServiceWorkerContainer();
    if (!serviceWorker) return;
    let disposed = false;
    const updateNetwork = () =>
      setState(navigator.onLine ? "online" : "offline");
    const handleMessage = (event: MessageEvent<OfflineWorkerMessage>) => {
      if (event.data?.type !== OFFLINE_MESSAGE.syncRequired) return;
      void flushOperations(event.data.operations, setState);
    };

    updateNetwork();
    window.addEventListener("online", updateNetwork);
    window.addEventListener("offline", updateNetwork);
    serviceWorker.addEventListener("message", handleMessage);

    void serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(() => serviceWorker.ready)
      .then(async () => {
        if (disposed) return;
        const previous = window.localStorage.getItem(storedPartitionKey);
        if (previous && previous !== partitionKey) {
          await sendToWorker({
            requestId: createClientId(),
            type: OFFLINE_MESSAGE.purgeAll,
          });
        }
        if (!partitionKey) {
          window.localStorage.removeItem(storedPartitionKey);
          return;
        }
        window.localStorage.setItem(storedPartitionKey, partitionKey);
        await sendToWorker({
          partitionKey,
          requestId: createClientId(),
          type: OFFLINE_MESSAGE.authContext,
        });
        await cacheProtectedUrls(["/api/offline/library"]);
        if (navigator.onLine) await requestOfflineFlush();
      })
      .catch(() => {
        if (!disposed) setState(navigator.onLine ? "online" : "offline");
      });

    const flushOnReconnect = () => {
      setState("online");
      void requestOfflineFlush();
    };
    window.addEventListener("online", flushOnReconnect);
    return () => {
      disposed = true;
      window.removeEventListener("online", updateNetwork);
      window.removeEventListener("offline", updateNetwork);
      window.removeEventListener("online", flushOnReconnect);
      serviceWorker.removeEventListener("message", handleMessage);
    };
  }, [partitionKey]);

  if (state === "online") return null;

  return (
    <div
      aria-live="polite"
      className={`connection-status ${state}`}
      role="status"
    >
      <span aria-hidden="true" />
      {state === "offline"
        ? "Offline · cooking changes stay on this device"
        : "Syncing cooking changes"}
    </div>
  );
}

export async function cacheProtectedUrls(urls: readonly string[]) {
  return sendToWorker({
    requestId: createClientId(),
    type: OFFLINE_MESSAGE.cacheProtected,
    urls,
  });
}

export async function queueCookingOperation(operation: OfflineOperation) {
  const result = await sendToWorker({
    operation,
    requestId: createClientId(),
    type: OFFLINE_MESSAGE.queueOperation,
  });
  if (result.ok && navigator.onLine) await requestOfflineFlush();
  return result;
}

export async function requestOfflineFlush() {
  return sendToWorker({
    requestId: createClientId(),
    type: OFFLINE_MESSAGE.flushRequest,
  });
}

async function flushOperations(
  operations: readonly OfflineOperation[],
  setState: (state: "offline" | "online" | "syncing") => void,
) {
  if (!navigator.onLine || operations.length === 0) return;
  setState("syncing");
  try {
    const response = await fetch("/api/offline/operations", {
      body: JSON.stringify({ operations }),
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) throw new Error("Offline synchronization failed");
    const body = (await response.json()) as { appliedOperationIds?: unknown };
    const operationIds = Array.isArray(body.appliedOperationIds)
      ? body.appliedOperationIds.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    await sendToWorker({
      operationIds,
      requestId: createClientId(),
      type: OFFLINE_MESSAGE.flushComplete,
    });
    setState("online");
  } catch {
    setState(navigator.onLine ? "online" : "offline");
  }
}

async function sendToWorker(
  message: OfflineClientMessage,
): Promise<
  Extract<OfflineWorkerMessage, { type: typeof OFFLINE_MESSAGE.result }>
> {
  const serviceWorker = getServiceWorkerContainer();
  if (!serviceWorker) return unavailableWorkerResult(message.requestId);

  const registration = await serviceWorker.ready.catch(() => undefined);
  if (!registration) return unavailableWorkerResult(message.requestId);
  const worker = serviceWorker.controller ?? registration.active;
  if (!worker) {
    return {
      error: "Offline worker is not active",
      ok: false,
      requestId: message.requestId,
      type: OFFLINE_MESSAGE.result,
    };
  }
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      serviceWorker.removeEventListener("message", onMessage);
      resolve({
        error: "Offline worker did not respond",
        ok: false,
        requestId: message.requestId,
        type: OFFLINE_MESSAGE.result,
      });
    }, 5_000);
    const onMessage = (event: MessageEvent<OfflineWorkerMessage>) => {
      if (
        event.data?.type !== OFFLINE_MESSAGE.result ||
        event.data.requestId !== message.requestId
      ) {
        return;
      }
      window.clearTimeout(timeout);
      serviceWorker.removeEventListener("message", onMessage);
      resolve(event.data);
    };
    serviceWorker.addEventListener("message", onMessage);
    worker.postMessage(message);
  });
}

function getServiceWorkerContainer(): ServiceWorkerContainer | undefined {
  if (typeof navigator === "undefined") return undefined;
  const serviceWorker = navigator.serviceWorker as
    ServiceWorkerContainer | undefined;
  return serviceWorker && typeof serviceWorker.ready?.then === "function"
    ? serviceWorker
    : undefined;
}

function unavailableWorkerResult(
  requestId: string,
): Extract<OfflineWorkerMessage, { type: typeof OFFLINE_MESSAGE.result }> {
  return {
    error: "Offline worker is unavailable",
    ok: false,
    requestId,
    type: OFFLINE_MESSAGE.result,
  };
}
