import { describe, expect, it } from "vitest";

import {
  acknowledgeOfflineOperations,
  enqueueOfflineOperation,
  parseOfflineOperation,
  type OfflineOperation,
} from "#src/modules/offline/offline-queue";

const baseOperation: OfflineOperation = {
  id: "operation-12345678",
  kind: "cooking.ingredient-check.set",
  recipeId: "recipe-12345678",
  payload: {
    ingredientId: "ingredient-12345678",
    checked: true,
    checkedIngredientIds: ["ingredient-12345678"],
    sessionId: null,
    clientSessionId: "client-session-12345678",
    expectedVersion: 0,
  },
  createdAt: "2026-07-31T12:00:00.000Z",
};

describe("offline cooking operation queue", () => {
  it("accepts only personal cooking-state operation shapes", () => {
    expect(parseOfflineOperation(baseOperation)).toEqual(baseOperation);
    expect(
      parseOfflineOperation({
        ...baseOperation,
        id: "operation-87654321",
        kind: "cooking.note.set",
        payload: { value: "Use less salt next time." },
      }),
    ).toMatchObject({ kind: "cooking.note.set" });
    expect(
      parseOfflineOperation({
        ...baseOperation,
        id: "operation-step-12345678",
        kind: "cooking.step-progress.set",
        payload: {
          stepId: "step-12345678",
          status: "active",
          guidedStepIndex: 1,
          sessionId: "session-12345678",
          clientSessionId: "client-session-12345678",
          expectedVersion: 2,
        },
      }),
    ).toMatchObject({ kind: "cooking.step-progress.set" });
    expect(
      parseOfflineOperation({
        ...baseOperation,
        id: "operation-timer-12345678",
        kind: "cooking.timer.set",
        payload: {
          timerId: "timer-12345678",
          durationSeconds: 300,
          remainingSeconds: 240,
          state: "running",
          timers: [
            {
              id: "timer-12345678",
              label: "Pasta",
              durationSeconds: 300,
              remainingSeconds: 240,
              startedAt: "2026-07-31T12:00:00.000Z",
              status: "running",
            },
          ],
          sessionId: "session-12345678",
          clientSessionId: "client-session-12345678",
          expectedVersion: 3,
        },
      }),
    ).toMatchObject({ kind: "cooking.timer.set" });
  });

  it.each([
    "recipe.edit",
    "import.start",
    "publishing.publish",
    "admin.user.update",
  ])("rejects disallowed %s work", (kind) => {
    expect(() => parseOfflineOperation({ ...baseOperation, kind })).toThrow(
      "cannot be queued",
    );
  });

  it("requires stable idempotency IDs and de-duplicates retries", () => {
    expect(() => parseOfflineOperation({ ...baseOperation, id: "x" })).toThrow(
      "idempotency",
    );
    expect(enqueueOfflineOperation([baseOperation], baseOperation)).toEqual([
      baseOperation,
    ]);
  });

  it("requires deterministic cooking-session reconciliation metadata", () => {
    expect(() =>
      parseOfflineOperation({
        ...baseOperation,
        payload: { ingredientId: "ingredient-12345678", checked: true },
      }),
    ).toThrow("payload is invalid");
  });

  it("requires the stable full snapshot used to replay a delta", () => {
    expect(() =>
      parseOfflineOperation({
        ...baseOperation,
        payload: {
          ...baseOperation.payload,
          checkedIngredientIds: undefined,
        },
      }),
    ).toThrow("payload is invalid");
  });

  it("removes only operations explicitly acknowledged by the online app", () => {
    const second = { ...baseOperation, id: "operation-87654321" };
    expect(
      acknowledgeOfflineOperations([baseOperation, second], [baseOperation.id]),
    ).toEqual([second]);
  });
});
