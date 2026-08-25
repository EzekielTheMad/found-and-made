import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CookingService } from "#src/modules/cooking/cooking.service.server";
import {
  CookingSessionVersionConflictError,
  OfflineOperationConflictError,
  PersonalStateVersionConflictError,
} from "#src/modules/cooking/cooking.types";
import {
  anonymousPrincipal,
  systemPrincipal,
} from "#src/modules/identity/identity.types";
import { createRuntime, type AppRuntime } from "#src/platform/runtime.server";
import { fourServingRecipe } from "../fixtures/four-serving-recipe";

const owner = { kind: "user", role: "owner", userId: "owner-user" } as const;
const editor = {
  kind: "user",
  role: "editor",
  userId: "editor-user",
} as const;
const viewer = {
  kind: "user",
  role: "viewer",
  userId: "viewer-user",
} as const;
const secondViewer = {
  kind: "user",
  role: "viewer",
  userId: "second-viewer-user",
} as const;

describe("cooking and personal-state application service", () => {
  const cleanup: Array<{ directory: string; runtime: AppRuntime }> = [];

  afterEach(async () => {
    for (const item of cleanup.splice(0)) {
      await item.runtime.close();
      await rm(item.directory, { force: true, recursive: true });
    }
  });

  it("lets every app role manage only its own personal recipe state", async () => {
    const { cooking, recipeId } = await fixture();

    for (const [index, principal] of [owner, editor, viewer].entries()) {
      const state = cooking.upsertPersonalFields(principal, recipeId, {
        favorite: true,
        note: `${principal.role} private note`,
        rating: (index + 3) as 3 | 4 | 5,
      });
      expect(state).toMatchObject({
        favorite: true,
        note: `${principal.role} private note`,
        rating: index + 3,
        version: 1,
      });
      expect(cooking.listFavorites(principal)).toHaveLength(1);
    }

    expect(cooking.getForRecipe(secondViewer, recipeId).state).toEqual({
      cookedCount: 0,
      favorite: false,
      note: "",
      recipeId,
      version: 0,
    });
    expect(cooking.listFavorites(secondViewer)).toEqual([]);
    expect(cooking.getForRecipe(owner, recipeId).state.note).toBe(
      "owner private note",
    );
    expect(cooking.getForRecipe(editor, recipeId).state.note).toBe(
      "editor private note",
    );
    expect(() => cooking.getForRecipe(anonymousPrincipal, recipeId)).toThrow(
      "authorized",
    );
    expect(() => cooking.getForRecipe(systemPrincipal, recipeId)).toThrow(
      "requires a user account",
    );
    expect(() =>
      cooking.getForRecipe(
        { kind: "service", scopes: ["recipes:read"], subject: "mcp" },
        recipeId,
      ),
    ).toThrow("authorized");
  });

  it("reconciles client operations idempotently and rejects divergent or stale replay", async () => {
    const { cooking, recipeId } = await fixture();
    const now = new Date("2026-07-31T18:00:00.000Z");
    const operation = {
      clientOperationId: "offline-favorite-1",
      expectedVersion: 0,
      fields: { favorite: true, note: "Works offline" },
      kind: "personal.update",
      recipeId,
    } as const;

    const first = cooking.applyOfflineOperation(viewer, operation, now);
    const replay = cooking.applyOfflineOperation(
      viewer,
      { ...operation, fields: { note: "Works offline", favorite: true } },
      new Date("2026-07-31T19:00:00.000Z"),
    );
    expect(first).toMatchObject({ applied: true });
    expect(replay).toMatchObject({ applied: false, result: { version: 1 } });
    expect(cooking.getForRecipe(viewer, recipeId).state.version).toBe(1);

    expect(() =>
      cooking.applyOfflineOperation(viewer, {
        ...operation,
        fields: { favorite: false },
      }),
    ).toThrow(OfflineOperationConflictError);
    expect(() =>
      cooking.upsertPersonalFields(
        viewer,
        recipeId,
        { favorite: false },
        { expectedVersion: 0 },
      ),
    ).toThrow(PersonalStateVersionConflictError);

    cooking.applyOfflineOperation(viewer, {
      clientOperationId: "device-a-personal-1",
      expectedVersion: 1,
      fields: { rating: 4 },
      kind: "personal.update",
      recipeId,
    });
    cooking.applyOfflineOperation(viewer, {
      clientOperationId: "device-b-personal-1",
      expectedVersion: 1,
      fields: { note: "Device B note" },
      kind: "personal.update",
      recipeId,
    });
    expect(cooking.getForRecipe(viewer, recipeId).state).toMatchObject({
      favorite: true,
      note: "Device B note",
      rating: 4,
      version: 3,
    });

    const cookedOperation = {
      adjustment: "Added extra basil",
      clientOperationId: "offline-cooked-1",
      kind: "cooked.record",
      recipeId,
    } as const;
    cooking.applyOfflineOperation(viewer, cookedOperation, now);
    cooking.applyOfflineOperation(viewer, cookedOperation, now);
    expect(cooking.listCookingHistory(viewer)).toHaveLength(1);
    expect(cooking.getForRecipe(viewer, recipeId).state.cookedCount).toBe(1);

    const clientSessionId = "11111111-1111-4111-8111-111111111111";
    const startOperation = {
      clientOperationId: "offline-session-start-1",
      input: { clientSessionId, targetServings: 4 },
      kind: "session.start",
      recipeId,
    } as const;
    const sessionStart = cooking.applyOfflineOperation(
      viewer,
      startOperation,
      now,
    );
    const sessionStartReplay = cooking.applyOfflineOperation(
      viewer,
      startOperation,
      now,
    );
    expect(sessionStart).toMatchObject({
      applied: true,
      result: { id: clientSessionId, version: 1 },
    });
    expect(sessionStartReplay).toMatchObject({
      applied: false,
      result: { id: clientSessionId, version: 1 },
    });
    const sessionOperation = {
      clientOperationId: "offline-session-1",
      expectedVersion: 1,
      input: { checkedIngredientIds: ["onion"], guidedStepIndex: 1 },
      kind: "session.update",
      recipeId,
      sessionId: clientSessionId,
    } as const;
    cooking.applyOfflineOperation(viewer, sessionOperation, now);
    cooking.applyOfflineOperation(viewer, sessionOperation, now);
    cooking.applyOfflineOperation(viewer, {
      clientOperationId: "device-b-session-1",
      expectedVersion: 1,
      input: { guidedStepIndex: 2 },
      kind: "session.update",
      recipeId,
      sessionId: clientSessionId,
    });
    expect(cooking.getCookingSession(viewer, clientSessionId)).toMatchObject({
      checkedIngredientIds: ["onion"],
      guidedStepIndex: 2,
      version: 3,
    });

    const otherUser = cooking.applyOfflineOperation(
      secondViewer,
      operation,
      now,
    );
    expect(otherUser.applied).toBe(true);
    expect(cooking.getForRecipe(secondViewer, recipeId).state.version).toBe(1);
  });

  it("derives running timers from persisted timestamps across reloads and versions session updates", async () => {
    const { cooking, recipeId } = await fixture();
    const startedAt = new Date("2026-07-31T18:00:00.000Z");
    const session = cooking.startCookingSession(
      viewer,
      recipeId,
      {
        targetServings: 6,
        timers: [
          {
            durationSeconds: 120,
            id: "simmer",
            label: "Simmer sauce",
            startedAt: startedAt.toISOString(),
            status: "running",
          },
          {
            durationSeconds: 60,
            id: "rest",
            label: "Rest",
            remainingSeconds: 40,
            status: "paused",
          },
          {
            durationSeconds: 30,
            id: "discarded",
            label: "Discarded timer",
            status: "cancelled",
          },
        ],
      },
      startedAt,
    );
    expect(session.timers.map((timer) => timer.remainingSeconds)).toEqual([
      120, 40, 0,
    ]);

    const afterThirtySeconds = cooking.getCookingSession(
      viewer,
      session.id,
      new Date("2026-07-31T18:00:30.900Z"),
    );
    expect(afterThirtySeconds.timers).toMatchObject([
      { remainingSeconds: 90, status: "running" },
      { remainingSeconds: 40, status: "paused" },
      { remainingSeconds: 0, status: "cancelled" },
    ]);

    const updated = cooking.updateCookingSession(
      viewer,
      session.id,
      { checkedIngredientIds: ["onion"], guidedStepIndex: 2 },
      {
        expectedVersion: 1,
        now: new Date("2026-07-31T18:00:45.000Z"),
      },
    );
    expect(updated).toMatchObject({
      checkedIngredientIds: ["onion"],
      guidedStepIndex: 2,
      version: 2,
    });
    expect(updated.timers[0]).toMatchObject({ remainingSeconds: 75 });
    expect(
      cooking.getCookingSession(
        viewer,
        session.id,
        new Date("2026-07-31T18:02:01.000Z"),
      ).timers[0],
    ).toMatchObject({ remainingSeconds: 0, status: "completed" });

    expect(() =>
      cooking.updateCookingSession(
        viewer,
        session.id,
        { guidedStepIndex: 3 },
        { expectedVersion: 1 },
      ),
    ).toThrow(CookingSessionVersionConflictError);
    expect(() => cooking.getCookingSession(secondViewer, session.id)).toThrow(
      "not found",
    );
  });

  it("validates ratings and maintains private recent, cooked, adjustment, and history views", async () => {
    const { cooking, recipeId, runtime } = await fixture();
    const secondRecipe = runtime.recipeService.create(
      fourServingRecipe({
        id: "weeknight-lasagna",
        source: { originalUrl: "https://example.test/weeknight" },
        title: "Weeknight Lasagna",
      }),
      { allowDuplicate: true },
    );

    expect(() =>
      cooking.upsertPersonalFields(viewer, recipeId, { rating: 0 as never }),
    ).toThrow("1 through 5");
    expect(() =>
      cooking.upsertPersonalFields(viewer, recipeId, { rating: 6 as never }),
    ).toThrow("1 through 5");
    const rated = cooking.upsertPersonalFields(viewer, recipeId, { rating: 5 });
    expect(rated.rating).toBe(5);
    expect(
      cooking.upsertPersonalFields(
        viewer,
        recipeId,
        { rating: null },
        { expectedVersion: rated.version },
      ).rating,
    ).toBeUndefined();

    cooking.recordView(viewer, recipeId, new Date("2026-07-31T16:00:00.000Z"));
    cooking.recordView(
      viewer,
      secondRecipe.id,
      new Date("2026-07-31T17:00:00.000Z"),
    );
    cooking.recordCooked(
      viewer,
      recipeId,
      { adjustment: "Added more basil" },
      new Date("2026-07-31T18:00:00.000Z"),
    );
    cooking.recordCooked(
      viewer,
      recipeId,
      {},
      new Date("2026-07-31T19:00:00.000Z"),
    );
    cooking.recordAdjustment(
      viewer,
      recipeId,
      "Use a deeper baking dish",
      new Date("2026-07-31T20:00:00.000Z"),
    );

    expect(
      cooking.listRecentlyViewed(viewer).map((item) => item.recipeId),
    ).toEqual([secondRecipe.id, recipeId]);
    expect(cooking.listRecentlyCooked(viewer)).toMatchObject([
      { cookedCount: 2, recipeId },
    ]);
    expect(cooking.listCookingHistory(viewer)).toMatchObject([
      { cookedAt: "2026-07-31T19:00:00.000Z", recipeId },
      {
        adjustment: { note: "Added more basil" },
        cookedAt: "2026-07-31T18:00:00.000Z",
        recipeId,
      },
    ]);
    expect(cooking.listAdjustments(viewer, recipeId)).toMatchObject([
      { note: "Use a deeper baking dish" },
      { note: "Added more basil" },
    ]);
    expect(cooking.listCookingHistory(secondViewer)).toEqual([]);
    expect(cooking.listAdjustments(secondViewer, recipeId)).toEqual([]);
  });

  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "found-made-cooking-"));
    const runtime = await createRuntime({
      dataDir: directory,
      startWorker: false,
    });
    cleanup.push({ directory, runtime });
    const timestamp = "2026-07-31T00:00:00.000Z";
    const insertUser = runtime.database.sqlite.prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?)`,
    );
    const insertRole = runtime.database.sqlite.prepare(
      `INSERT INTO app_users (user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const principal of [owner, editor, viewer, secondViewer]) {
      insertUser.run(
        principal.userId,
        principal.userId,
        `${principal.userId}@example.test`,
        timestamp,
        timestamp,
      );
      insertRole.run(principal.userId, principal.role, timestamp, timestamp);
    }
    const recipe = runtime.recipeService.create(fourServingRecipe());
    return {
      cooking: new CookingService(
        runtime.database.sqlite,
        runtime.recipeAccessService,
      ),
      recipeId: recipe.id,
      runtime,
    };
  }
});
