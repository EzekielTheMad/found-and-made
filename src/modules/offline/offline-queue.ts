export const OFFLINE_OPERATION_KINDS = [
  "cooking.note.set",
  "cooking.ingredient-check.set",
  "cooking.step-progress.set",
  "cooking.timer.set",
  "cooking.scale.set",
] as const;

export type OfflineOperationKind = (typeof OFFLINE_OPERATION_KINDS)[number];

export interface OfflineOperation {
  readonly id: string;
  readonly kind: OfflineOperationKind;
  readonly recipeId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

const ALLOWED_KINDS = new Set<string>(OFFLINE_OPERATION_KINDS);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isValidIdentifier(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function hasValidSessionMetadata(payload: Record<string, unknown>): boolean {
  return (
    (payload.sessionId === null || isValidIdentifier(payload.sessionId)) &&
    isValidIdentifier(payload.clientSessionId) &&
    typeof payload.expectedVersion === "number" &&
    Number.isInteger(payload.expectedVersion) &&
    payload.expectedVersion >= 0
  );
}

function hasValidCheckedSnapshot(payload: Record<string, unknown>): boolean {
  return (
    Array.isArray(payload.checkedIngredientIds) &&
    payload.checkedIngredientIds.every(isValidIdentifier) &&
    new Set(payload.checkedIngredientIds).size ===
      payload.checkedIngredientIds.length
  );
}

function hasValidTimerSnapshot(payload: Record<string, unknown>): boolean {
  return (
    Array.isArray(payload.timers) &&
    payload.timers.every(
      (timer) =>
        isPlainRecord(timer) &&
        isValidIdentifier(timer.id) &&
        typeof timer.label === "string" &&
        timer.label.length <= 200 &&
        isFinitePositive(timer.durationSeconds) &&
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

function hasValidPayload(
  kind: OfflineOperationKind,
  payload: Record<string, unknown>,
): boolean {
  switch (kind) {
    case "cooking.note.set":
      return (
        typeof payload.value === "string" && payload.value.length <= 10_000
      );
    case "cooking.ingredient-check.set":
      return (
        hasValidSessionMetadata(payload) &&
        hasValidCheckedSnapshot(payload) &&
        isValidIdentifier(payload.ingredientId) &&
        typeof payload.checked === "boolean"
      );
    case "cooking.step-progress.set":
      return (
        hasValidSessionMetadata(payload) &&
        typeof payload.guidedStepIndex === "number" &&
        Number.isInteger(payload.guidedStepIndex) &&
        payload.guidedStepIndex >= 0 &&
        isValidIdentifier(payload.stepId) &&
        typeof payload.status === "string" &&
        ["pending", "active", "completed"].includes(payload.status)
      );
    case "cooking.timer.set":
      return (
        hasValidSessionMetadata(payload) &&
        hasValidTimerSnapshot(payload) &&
        isValidIdentifier(payload.timerId) &&
        isFinitePositive(payload.durationSeconds) &&
        typeof payload.remainingSeconds === "number" &&
        Number.isFinite(payload.remainingSeconds) &&
        payload.remainingSeconds >= 0 &&
        typeof payload.state === "string" &&
        ["running", "paused", "complete", "cancelled"].includes(payload.state)
      );
    case "cooking.scale.set":
      return (
        hasValidSessionMetadata(payload) &&
        isFinitePositive(payload.targetYield) &&
        payload.targetYield <= 100_000
      );
  }
}

export function parseOfflineOperation(value: unknown): OfflineOperation {
  if (!isPlainRecord(value)) {
    throw new Error("Offline operation must be an object.");
  }

  const { id, kind, recipeId, payload, createdAt } = value;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new Error("Offline operation requires a stable idempotency ID.");
  }
  if (typeof kind !== "string" || !ALLOWED_KINDS.has(kind)) {
    throw new Error("This operation cannot be queued offline.");
  }
  if (typeof recipeId !== "string" || !ID_PATTERN.test(recipeId)) {
    throw new Error("Offline operation requires a recipe ID.");
  }
  if (
    !isPlainRecord(payload) ||
    !hasValidPayload(kind as OfflineOperationKind, payload)
  ) {
    throw new Error("Offline operation payload is invalid.");
  }
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    throw new Error("Offline operation requires a valid creation timestamp.");
  }

  return {
    id,
    kind: kind as OfflineOperationKind,
    recipeId,
    payload,
    createdAt,
  };
}

export function enqueueOfflineOperation(
  queue: readonly OfflineOperation[],
  candidate: unknown,
): OfflineOperation[] {
  const operation = parseOfflineOperation(candidate);
  if (queue.some((existing) => existing.id === operation.id)) {
    return [...queue];
  }
  return [...queue, operation];
}

export function acknowledgeOfflineOperations(
  queue: readonly OfflineOperation[],
  acknowledgedIds: readonly string[],
): OfflineOperation[] {
  const acknowledged = new Set(acknowledgedIds);
  return queue.filter((operation) => !acknowledged.has(operation.id));
}
