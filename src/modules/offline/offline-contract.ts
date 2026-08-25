import type { OfflineOperation } from "./offline-queue";

export const OFFLINE_MESSAGE = {
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
} as const;

export type OfflineClientMessage =
  | {
      readonly type: typeof OFFLINE_MESSAGE.authContext;
      readonly requestId: string;
      readonly partitionKey: string;
    }
  | {
      readonly type: typeof OFFLINE_MESSAGE.cacheProtected;
      readonly requestId: string;
      readonly urls: readonly string[];
    }
  | {
      readonly type: typeof OFFLINE_MESSAGE.clearContext;
      readonly requestId: string;
    }
  | {
      readonly type: typeof OFFLINE_MESSAGE.flushComplete;
      readonly requestId: string;
      readonly operationIds: readonly string[];
    }
  | {
      readonly type: typeof OFFLINE_MESSAGE.flushRequest;
      readonly requestId: string;
    }
  | {
      readonly type: typeof OFFLINE_MESSAGE.purgeAll;
      readonly requestId: string;
    }
  | {
      readonly type: typeof OFFLINE_MESSAGE.queueOperation;
      readonly requestId: string;
      readonly operation: OfflineOperation;
    }
  | {
      readonly type: typeof OFFLINE_MESSAGE.recoverContext;
      readonly requestId: string;
    };

export type OfflineWorkerMessage =
  | {
      readonly type: typeof OFFLINE_MESSAGE.result;
      readonly requestId: string;
      readonly ok: boolean;
      readonly error?: string;
      readonly cachedUrls?: readonly string[];
    }
  | {
      readonly type: typeof OFFLINE_MESSAGE.syncRequired;
      readonly operations: readonly OfflineOperation[];
    };
