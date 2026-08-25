import { describe, expect, it } from "vitest";

import type { OfflineOperation } from "#src/modules/offline/offline-queue";
import { toPersonalOfflineOperation } from "#src/platform/offline/offline-api.server";

const recipeId = "recipe-offline-1";
const clientSessionId = "11111111-1111-4111-8111-111111111111";

describe("offline API reconciliation mapping", () => {
  it("maps the first session mutation to a stable client-owned session start", () => {
    const operation = offlineOperation("cooking.ingredient-check.set", {
      checked: true,
      checkedIngredientIds: ["ingredient-one"],
      clientSessionId,
      expectedVersion: 0,
      ingredientId: "ingredient-one",
      sessionId: clientSessionId,
      targetYield: 6,
    });

    expect(toPersonalOfflineOperation(operation, 4)).toEqual({
      clientOperationId: operation.id,
      input: {
        checkedIngredientIds: ["ingredient-one"],
        clientSessionId,
        targetServings: 6,
      },
      kind: "session.start",
      recipeId,
    });
  });

  it("maps deterministic timer snapshots and normalizes complete status", () => {
    const operation = offlineOperation("cooking.timer.set", {
      clientSessionId,
      durationSeconds: 60,
      expectedVersion: 2,
      remainingSeconds: 0,
      sessionId: clientSessionId,
      state: "complete",
      targetYield: 8,
      timerId: "timer-one",
      timers: [
        {
          durationSeconds: 60,
          id: "timer-one",
          label: "Rest",
          remainingSeconds: 0,
          startedAt: null,
          status: "complete",
        },
      ],
    });

    expect(toPersonalOfflineOperation(operation, 4)).toMatchObject({
      clientOperationId: operation.id,
      expectedVersion: 2,
      input: {
        targetServings: 8,
        timers: [{ id: "timer-one", status: "completed" }],
      },
      kind: "session.update",
      recipeId,
      sessionId: clientSessionId,
    });
  });

  it("keeps personal notes outside the cooking-session version stream", () => {
    const operation = offlineOperation("cooking.note.set", {
      value: "Use less salt next time.",
    });
    expect(toPersonalOfflineOperation(operation, 4)).toEqual({
      clientOperationId: operation.id,
      fields: { note: "Use less salt next time." },
      kind: "personal.update",
      recipeId,
    });
  });
});

function offlineOperation(
  kind: OfflineOperation["kind"],
  payload: Record<string, unknown>,
): OfflineOperation {
  return {
    createdAt: "2026-07-31T20:00:00.000Z",
    id: `offline-${kind}`,
    kind,
    payload,
    recipeId,
  };
}
