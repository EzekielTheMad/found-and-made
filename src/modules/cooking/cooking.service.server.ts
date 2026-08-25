import { createHash, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { AuthorizationPolicy } from "../identity/authorization.policy";
import { AuthorizationError, type Principal } from "../identity/identity.types";
import type { RecipeAggregate } from "../recipes/recipe.types";
import type { RecipeAccessService } from "../recipes/recipe-access.service.server";
import {
  CookingSessionVersionConflictError,
  type CookingHistoryEntry,
  type CookingSession,
  type CookingSessionStatus,
  type CookingTimer,
  type DerivedCookingTimer,
  OfflineOperationConflictError,
  type PersonalAdjustment,
  type PersonalOfflineOperation,
  type PersonalOfflineOperationResult,
  type PersonalOfflineOperationValue,
  type PersonalRating,
  type PersonalRecipeFields,
  type PersonalRecipeListItem,
  type PersonalRecipeState,
  type PersonalRecipeSummary,
  PersonalStateVersionConflictError,
  type StartCookingSessionInput,
  type UpdateCookingSessionInput,
} from "./cooking.types";

const MAX_NOTE_LENGTH = 20_000;
const MAX_ADJUSTMENT_LENGTH = 2_000;
const MAX_TIMER_SECONDS = 7 * 24 * 60 * 60;

interface PersonalStateRow {
  cookedCount: number;
  favorite: 0 | 1;
  lastCookedAt: string | null;
  lastViewedAt: string | null;
  note: string;
  rating: number | null;
  recipeId: string;
  updatedAt: string;
  version: number;
}

interface PersonalListRow extends PersonalStateRow {
  recipeUpdatedAt: string;
  title: string;
}

interface AdjustmentRow {
  createdAt: string;
  id: string;
  note: string;
  recipeId: string;
}

interface HistoryRow {
  adjustmentCreatedAt: string | null;
  adjustmentId: string | null;
  adjustmentNote: string | null;
  cookedAt: string;
  id: string;
  recipeId: string;
  title: string;
}

interface CookingSessionRow {
  checkedIngredientIds: string;
  completedAt: string | null;
  createdAt: string;
  guidedStepIndex: number;
  id: string;
  recipeId: string;
  status: CookingSessionStatus;
  targetServings: number;
  timers: string;
  updatedAt: string;
  version: number;
}

interface StoredOperationRow {
  operationHash: string;
  result: string;
}

export class CookingService {
  private readonly policy = new AuthorizationPolicy();

  constructor(
    private readonly sqlite: Database.Database,
    private readonly recipeAccess: RecipeAccessService,
  ) {}

  getForRecipe(
    principal: Principal,
    recipeId: string,
    now = new Date(),
  ): PersonalRecipeSummary {
    const userId = this.userId(principal);
    this.recipe(principal, recipeId);
    const activeRow = this.sqlite
      .prepare(
        `SELECT id, recipe_id AS recipeId, status,
          target_servings AS targetServings,
          checked_ingredient_ids AS checkedIngredientIds,
          guided_step_index AS guidedStepIndex, timers, version,
          created_at AS createdAt, updated_at AS updatedAt,
          completed_at AS completedAt
         FROM cooking_sessions
         WHERE user_id = ? AND recipe_id = ? AND status = 'active'
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(userId, recipeId) as CookingSessionRow | undefined;
    return {
      ...(activeRow ? { activeSession: toSession(activeRow, now) } : {}),
      adjustments: this.adjustmentRows(userId, recipeId, 20),
      recentHistory: this.historyRows(userId, 20, recipeId),
      state: this.stateFor(userId, recipeId),
    };
  }

  summary(
    principal: Principal,
    recipeId: string,
    now = new Date(),
  ): PersonalRecipeSummary {
    return this.getForRecipe(principal, recipeId, now);
  }

  listFavorites(principal: Principal, limit = 50): PersonalRecipeListItem[] {
    const userId = this.userId(principal);
    return this.listState(
      userId,
      "state.favorite = 1",
      "state.updated_at DESC, recipe.title COLLATE NOCASE",
      limit,
    );
  }

  listRecentlyViewed(
    principal: Principal,
    limit = 20,
  ): PersonalRecipeListItem[] {
    const userId = this.userId(principal);
    return this.listState(
      userId,
      "state.last_viewed_at IS NOT NULL",
      "state.last_viewed_at DESC",
      limit,
    );
  }

  listRecentlyCooked(
    principal: Principal,
    limit = 20,
  ): PersonalRecipeListItem[] {
    const userId = this.userId(principal);
    return this.listState(
      userId,
      "state.last_cooked_at IS NOT NULL",
      "state.last_cooked_at DESC",
      limit,
    );
  }

  listCookingHistory(
    principal: Principal,
    options: { limit?: number; recipeId?: string } = {},
  ): CookingHistoryEntry[] {
    const userId = this.userId(principal);
    if (options.recipeId) this.recipe(principal, options.recipeId);
    return this.historyRows(
      userId,
      validLimit(options.limit ?? 50),
      options.recipeId,
    );
  }

  listAdjustments(
    principal: Principal,
    recipeId: string,
    limit = 50,
  ): PersonalAdjustment[] {
    const userId = this.userId(principal);
    this.recipe(principal, recipeId);
    return this.adjustmentRows(userId, recipeId, validLimit(limit));
  }

  upsertPersonalFields(
    principal: Principal,
    recipeId: string,
    fields: PersonalRecipeFields,
    options: { expectedVersion?: number; now?: Date } = {},
  ): PersonalRecipeState {
    const userId = this.userId(principal);
    this.recipe(principal, recipeId);
    return this.sqlite.transaction(() =>
      this.writePersonalFields(
        userId,
        recipeId,
        fields,
        options.expectedVersion,
        options.now ?? new Date(),
      ),
    )();
  }

  recordView(
    principal: Principal,
    recipeId: string,
    now = new Date(),
  ): PersonalRecipeState {
    const userId = this.userId(principal);
    this.recipe(principal, recipeId);
    return this.sqlite.transaction(() =>
      this.touchState(userId, recipeId, "view", now),
    )();
  }

  recordCooked(
    principal: Principal,
    recipeId: string,
    input: { adjustment?: string } = {},
    now = new Date(),
  ): CookingHistoryEntry {
    const userId = this.userId(principal);
    const recipe = this.recipe(principal, recipeId);
    return this.sqlite.transaction(() => {
      const adjustment = input.adjustment
        ? this.insertAdjustment(userId, recipeId, input.adjustment, now)
        : undefined;
      const id = randomUUID();
      this.sqlite
        .prepare(
          `INSERT INTO cooking_history
           (id, user_id, recipe_id, adjustment_id, cooked_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, userId, recipeId, adjustment?.id ?? null, now.toISOString());
      this.touchState(userId, recipeId, "cooked", now);
      return {
        ...(adjustment ? { adjustment } : {}),
        cookedAt: now.toISOString(),
        id,
        recipeId,
        title: recipe.title,
      };
    })();
  }

  recordAdjustment(
    principal: Principal,
    recipeId: string,
    note: string,
    now = new Date(),
  ): PersonalAdjustment {
    const userId = this.userId(principal);
    this.recipe(principal, recipeId);
    return this.sqlite.transaction(() =>
      this.insertAdjustment(userId, recipeId, note, now),
    )();
  }

  startCookingSession(
    principal: Principal,
    recipeId: string,
    input: StartCookingSessionInput,
    now = new Date(),
  ): CookingSession {
    const userId = this.userId(principal);
    const recipe = this.recipe(principal, recipeId);
    const normalized = normalizeSessionInput(recipe, input);
    const id = input.clientSessionId
      ? validClientSessionId(input.clientSessionId)
      : randomUUID();
    const collision = this.sqlite
      .prepare("SELECT 1 FROM cooking_sessions WHERE id = ?")
      .get(id);
    if (collision) throw new Error("Cooking session identifier already exists");
    const timestamp = now.toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO cooking_sessions
         (id, user_id, recipe_id, status, target_servings,
          checked_ingredient_ids, guided_step_index, timers, version,
          created_at, updated_at, completed_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, 1, ?, ?, NULL)`,
      )
      .run(
        id,
        userId,
        recipeId,
        normalized.targetServings,
        JSON.stringify(normalized.checkedIngredientIds),
        normalized.guidedStepIndex,
        JSON.stringify(normalized.timers),
        timestamp,
        timestamp,
      );
    return this.sessionFor(userId, id, now);
  }

  getCookingSession(
    principal: Principal,
    sessionId: string,
    now = new Date(),
  ): CookingSession {
    const userId = this.userId(principal);
    const session = this.sessionFor(userId, sessionId, now);
    this.recipe(principal, session.recipeId);
    return session;
  }

  updateCookingSession(
    principal: Principal,
    sessionId: string,
    input: UpdateCookingSessionInput,
    options: { expectedVersion: number; now?: Date },
  ): CookingSession {
    const userId = this.userId(principal);
    return this.sqlite.transaction(() =>
      this.writeSession(
        principal,
        userId,
        sessionId,
        input,
        options.expectedVersion,
        options.now ?? new Date(),
      ),
    )();
  }

  applyOfflineOperation(
    principal: Principal,
    operation: PersonalOfflineOperation,
    now = new Date(),
  ): PersonalOfflineOperationResult {
    const userId = this.userId(principal);
    validOperationId(operation.clientOperationId);
    const operationHash = createHash("sha256")
      .update(stableStringify(operation))
      .digest("hex");

    return this.sqlite.transaction(() => {
      const previous = this.sqlite
        .prepare(
          `SELECT operation_hash AS operationHash, result
           FROM personal_state_operations
           WHERE user_id = ? AND client_operation_id = ?`,
        )
        .get(userId, operation.clientOperationId) as
        StoredOperationRow | undefined;
      if (previous) {
        if (previous.operationHash !== operationHash) {
          throw new OfflineOperationConflictError(operation.clientOperationId);
        }
        return {
          applied: false,
          clientOperationId: operation.clientOperationId,
          result: JSON.parse(previous.result) as PersonalOfflineOperationValue,
        };
      }

      const result = this.applyOperation(principal, operation, now);
      this.sqlite
        .prepare(
          `INSERT INTO personal_state_operations
           (user_id, client_operation_id, recipe_id, operation_hash, result, applied_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          userId,
          operation.clientOperationId,
          operation.recipeId,
          operationHash,
          JSON.stringify(result),
          now.toISOString(),
        );
      return {
        applied: true,
        clientOperationId: operation.clientOperationId,
        result,
      };
    })();
  }

  private applyOperation(
    principal: Principal,
    operation: PersonalOfflineOperation,
    now: Date,
  ): PersonalOfflineOperationValue {
    switch (operation.kind) {
      case "personal.update":
        return this.upsertPersonalFields(
          principal,
          operation.recipeId,
          operation.fields,
          {
            expectedVersion: this.stateFor(
              this.userId(principal),
              operation.recipeId,
            ).version,
            now,
          },
        );
      case "view.record":
        return this.recordView(principal, operation.recipeId, now);
      case "cooked.record":
        return this.recordCooked(
          principal,
          operation.recipeId,
          operation.adjustment
            ? { adjustment: operation.adjustment }
            : undefined,
          now,
        );
      case "adjustment.record":
        return this.recordAdjustment(
          principal,
          operation.recipeId,
          operation.note,
          now,
        );
      case "session.start":
        return this.startCookingSession(
          principal,
          operation.recipeId,
          operation.input,
          now,
        );
      case "session.update": {
        const current = this.sessionFor(
          this.userId(principal),
          operation.sessionId,
          now,
        );
        if (current.recipeId !== operation.recipeId) {
          throw new Error("Cooking session does not belong to this recipe");
        }
        return this.updateCookingSession(
          principal,
          operation.sessionId,
          operation.input,
          { expectedVersion: current.version, now },
        );
      }
    }
  }

  private writePersonalFields(
    userId: string,
    recipeId: string,
    fields: PersonalRecipeFields,
    expectedVersion: number | undefined,
    now: Date,
  ): PersonalRecipeState {
    const current = this.stateRow(userId, recipeId);
    const actualVersion = current?.version ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== actualVersion) {
      throw new PersonalStateVersionConflictError(
        expectedVersion,
        actualVersion,
      );
    }
    const note =
      fields.note === undefined
        ? (current?.note ?? "")
        : validNote(fields.note, MAX_NOTE_LENGTH, "Personal note");
    if (fields.favorite !== undefined && typeof fields.favorite !== "boolean") {
      throw new Error("Favorite must be a boolean");
    }
    const rating =
      fields.rating === undefined ? (current?.rating ?? null) : fields.rating;
    validRating(rating);
    const favorite = fields.favorite ?? Boolean(current?.favorite);
    const timestamp = now.toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO personal_recipe_states
         (user_id, recipe_id, favorite, note, rating, last_viewed_at,
          last_cooked_at, cooked_count, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, recipe_id) DO UPDATE SET
          favorite = excluded.favorite,
          note = excluded.note,
          rating = excluded.rating,
          version = excluded.version,
          updated_at = excluded.updated_at`,
      )
      .run(
        userId,
        recipeId,
        favorite ? 1 : 0,
        note,
        rating,
        current?.lastViewedAt ?? null,
        current?.lastCookedAt ?? null,
        current?.cookedCount ?? 0,
        actualVersion + 1,
        timestamp,
        timestamp,
      );
    return this.stateFor(userId, recipeId);
  }

  private touchState(
    userId: string,
    recipeId: string,
    kind: "cooked" | "view",
    now: Date,
  ): PersonalRecipeState {
    const current = this.stateRow(userId, recipeId);
    const timestamp = now.toISOString();
    const state = {
      cookedCount: (current?.cookedCount ?? 0) + (kind === "cooked" ? 1 : 0),
      favorite: Boolean(current?.favorite),
      lastCookedAt:
        kind === "cooked" ? timestamp : (current?.lastCookedAt ?? null),
      lastViewedAt:
        kind === "view" ? timestamp : (current?.lastViewedAt ?? null),
      note: current?.note ?? "",
      rating: current?.rating ?? null,
      version: (current?.version ?? 0) + 1,
    };
    this.sqlite
      .prepare(
        `INSERT INTO personal_recipe_states
         (user_id, recipe_id, favorite, note, rating, last_viewed_at,
          last_cooked_at, cooked_count, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, recipe_id) DO UPDATE SET
          last_viewed_at = excluded.last_viewed_at,
          last_cooked_at = excluded.last_cooked_at,
          cooked_count = excluded.cooked_count,
          version = excluded.version,
          updated_at = excluded.updated_at`,
      )
      .run(
        userId,
        recipeId,
        state.favorite ? 1 : 0,
        state.note,
        state.rating,
        state.lastViewedAt,
        state.lastCookedAt,
        state.cookedCount,
        state.version,
        timestamp,
        timestamp,
      );
    return this.stateFor(userId, recipeId);
  }

  private insertAdjustment(
    userId: string,
    recipeId: string,
    note: string,
    now: Date,
  ): PersonalAdjustment {
    const value = validNote(note, MAX_ADJUSTMENT_LENGTH, "Adjustment");
    if (!value) throw new Error("Adjustment cannot be empty");
    const adjustment = {
      createdAt: now.toISOString(),
      id: randomUUID(),
      note: value,
      recipeId,
    };
    this.sqlite
      .prepare(
        `INSERT INTO personal_adjustments
         (id, user_id, recipe_id, note, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        adjustment.id,
        userId,
        recipeId,
        adjustment.note,
        adjustment.createdAt,
      );
    return adjustment;
  }

  private writeSession(
    principal: Principal,
    userId: string,
    sessionId: string,
    input: UpdateCookingSessionInput,
    expectedVersion: number,
    now: Date,
  ): CookingSession {
    const row = this.sessionRow(userId, sessionId);
    if (!row) throw new Error("Cooking session not found");
    if (row.version !== expectedVersion) {
      throw new CookingSessionVersionConflictError(
        expectedVersion,
        row.version,
      );
    }
    const recipe = this.recipe(principal, row.recipeId);
    const currentTimers = parseTimers(row.timers);
    const normalized = normalizeSessionInput(recipe, {
      checkedIngredientIds:
        input.checkedIngredientIds ??
        parseStringArray(row.checkedIngredientIds),
      guidedStepIndex: input.guidedStepIndex ?? row.guidedStepIndex,
      targetServings: input.targetServings ?? row.targetServings,
      timers: input.timers ?? currentTimers,
    });
    const status = input.status ?? row.status;
    if (!(["active", "completed", "abandoned"] as const).includes(status)) {
      throw new Error("Cooking session status is invalid");
    }
    const completedAt =
      status === "active" ? null : (row.completedAt ?? now.toISOString());
    const result = this.sqlite
      .prepare(
        `UPDATE cooking_sessions SET
          status = ?, target_servings = ?, checked_ingredient_ids = ?,
          guided_step_index = ?, timers = ?, version = version + 1,
          updated_at = ?, completed_at = ?
         WHERE id = ? AND user_id = ? AND version = ?`,
      )
      .run(
        status,
        normalized.targetServings,
        JSON.stringify(normalized.checkedIngredientIds),
        normalized.guidedStepIndex,
        JSON.stringify(normalized.timers),
        now.toISOString(),
        completedAt,
        sessionId,
        userId,
        expectedVersion,
      );
    if (result.changes !== 1) {
      const actual = this.sessionRow(userId, sessionId)?.version;
      if (actual === undefined) throw new Error("Cooking session not found");
      throw new CookingSessionVersionConflictError(expectedVersion, actual);
    }
    return this.sessionFor(userId, sessionId, now);
  }

  private listState(
    userId: string,
    where: string,
    orderBy: string,
    limit: number,
  ): PersonalRecipeListItem[] {
    const rows = this.sqlite
      .prepare(
        `SELECT state.recipe_id AS recipeId, state.favorite,
          state.note, state.rating, state.last_viewed_at AS lastViewedAt,
          state.last_cooked_at AS lastCookedAt,
          state.cooked_count AS cookedCount, state.version,
          state.updated_at AS updatedAt, recipe.title,
          recipe.updated_at AS recipeUpdatedAt
         FROM personal_recipe_states state
         JOIN recipes recipe ON recipe.id = state.recipe_id
         WHERE state.user_id = ? AND recipe.deleted_at IS NULL AND ${where}
         ORDER BY ${orderBy} LIMIT ?`,
      )
      .all(userId, validLimit(limit)) as PersonalListRow[];
    return rows.map((row) => ({
      ...toState(row),
      recipeUpdatedAt: row.recipeUpdatedAt,
      title: row.title,
    }));
  }

  private adjustmentRows(
    userId: string,
    recipeId: string,
    limit: number,
  ): PersonalAdjustment[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id, recipe_id AS recipeId, note, created_at AS createdAt
         FROM personal_adjustments
         WHERE user_id = ? AND recipe_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(userId, recipeId, validLimit(limit)) as AdjustmentRow[];
    return rows;
  }

  private historyRows(
    userId: string,
    limit: number,
    recipeId?: string,
  ): CookingHistoryEntry[] {
    const recipeFilter = recipeId ? "AND history.recipe_id = ?" : "";
    const parameters = recipeId
      ? [userId, recipeId, validLimit(limit)]
      : [userId, validLimit(limit)];
    const rows = this.sqlite
      .prepare(
        `SELECT history.id, history.recipe_id AS recipeId,
          history.cooked_at AS cookedAt, recipe.title,
          adjustment.id AS adjustmentId,
          adjustment.note AS adjustmentNote,
          adjustment.created_at AS adjustmentCreatedAt
         FROM cooking_history history
         JOIN recipes recipe ON recipe.id = history.recipe_id
         LEFT JOIN personal_adjustments adjustment
           ON adjustment.id = history.adjustment_id
           AND adjustment.user_id = history.user_id
         WHERE history.user_id = ? AND recipe.deleted_at IS NULL ${recipeFilter}
         ORDER BY history.cooked_at DESC, history.id DESC LIMIT ?`,
      )
      .all(...parameters) as HistoryRow[];
    return rows.map((row) => ({
      ...(row.adjustmentId && row.adjustmentCreatedAt && row.adjustmentNote
        ? {
            adjustment: {
              createdAt: row.adjustmentCreatedAt,
              id: row.adjustmentId,
              note: row.adjustmentNote,
              recipeId: row.recipeId,
            },
          }
        : {}),
      cookedAt: row.cookedAt,
      id: row.id,
      recipeId: row.recipeId,
      title: row.title,
    }));
  }

  private stateFor(userId: string, recipeId: string): PersonalRecipeState {
    const row = this.stateRow(userId, recipeId);
    return row
      ? toState(row)
      : {
          cookedCount: 0,
          favorite: false,
          note: "",
          recipeId,
          version: 0,
        };
  }

  private stateRow(
    userId: string,
    recipeId: string,
  ): PersonalStateRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT recipe_id AS recipeId, favorite, note, rating,
          last_viewed_at AS lastViewedAt, last_cooked_at AS lastCookedAt,
          cooked_count AS cookedCount, version, updated_at AS updatedAt
         FROM personal_recipe_states WHERE user_id = ? AND recipe_id = ?`,
      )
      .get(userId, recipeId) as PersonalStateRow | undefined;
  }

  private sessionFor(
    userId: string,
    sessionId: string,
    now: Date,
  ): CookingSession {
    const row = this.sessionRow(userId, sessionId);
    if (!row) throw new Error("Cooking session not found");
    return toSession(row, now);
  }

  private sessionRow(
    userId: string,
    sessionId: string,
  ): CookingSessionRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT id, recipe_id AS recipeId, status,
          target_servings AS targetServings,
          checked_ingredient_ids AS checkedIngredientIds,
          guided_step_index AS guidedStepIndex, timers, version,
          created_at AS createdAt, updated_at AS updatedAt,
          completed_at AS completedAt
         FROM cooking_sessions WHERE id = ? AND user_id = ?`,
      )
      .get(sessionId, userId) as CookingSessionRow | undefined;
  }

  private recipe(principal: Principal, recipeId: string): RecipeAggregate {
    return this.recipeAccess.get(principal, recipeId);
  }

  private userId(principal: Principal): string {
    this.policy.require(principal, "user-data:manage");
    if (principal.kind !== "user") {
      throw new AuthorizationError(
        "Personal cooking data requires a user account",
      );
    }
    return principal.userId;
  }
}

function toState(row: PersonalStateRow): PersonalRecipeState {
  return {
    cookedCount: row.cookedCount,
    favorite: Boolean(row.favorite),
    ...(row.lastCookedAt ? { lastCookedAt: row.lastCookedAt } : {}),
    ...(row.lastViewedAt ? { lastViewedAt: row.lastViewedAt } : {}),
    note: row.note,
    ...(row.rating === null ? {} : { rating: row.rating as PersonalRating }),
    recipeId: row.recipeId,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

function toSession(row: CookingSessionRow, now: Date): CookingSession {
  return {
    checkedIngredientIds: parseStringArray(row.checkedIngredientIds),
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    createdAt: row.createdAt,
    guidedStepIndex: row.guidedStepIndex,
    id: row.id,
    recipeId: row.recipeId,
    status: row.status,
    targetServings: row.targetServings,
    timers: parseTimers(row.timers).map((timer) => deriveTimer(timer, now)),
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

export function deriveTimer(
  timer: CookingTimer,
  now = new Date(),
): DerivedCookingTimer {
  const normalized = normalizeTimer(timer);
  if (normalized.status === "completed" || normalized.status === "cancelled") {
    return { ...normalized, remainingSeconds: 0 };
  }
  if (normalized.status === "paused") {
    return {
      ...normalized,
      remainingSeconds: normalized.remainingSeconds ?? 0,
    };
  }
  const elapsed = Math.max(
    0,
    Math.floor(
      (now.getTime() - new Date(normalized.startedAt ?? 0).getTime()) / 1000,
    ),
  );
  const remainingSeconds = Math.max(0, normalized.durationSeconds - elapsed);
  return {
    ...normalized,
    remainingSeconds,
    status: remainingSeconds === 0 ? "completed" : "running",
  };
}

function normalizeSessionInput(
  recipe: RecipeAggregate,
  input: StartCookingSessionInput,
): {
  checkedIngredientIds: string[];
  guidedStepIndex: number;
  targetServings: number;
  timers: CookingTimer[];
} {
  if (!Number.isFinite(input.targetServings) || input.targetServings <= 0) {
    throw new Error("Target servings must be a positive number");
  }
  const guidedStepIndex = input.guidedStepIndex ?? 0;
  if (
    !Number.isInteger(guidedStepIndex) ||
    guidedStepIndex < 0 ||
    guidedStepIndex > recipe.steps.length
  ) {
    throw new Error("Guided step is outside this recipe");
  }
  const availableIngredients = new Set(
    recipe.ingredients.map((ingredient) => ingredient.id),
  );
  const checkedIngredientIds = [...new Set(input.checkedIngredientIds ?? [])];
  if (checkedIngredientIds.some((id) => !availableIngredients.has(id))) {
    throw new Error("Ingredient check-off is outside this recipe");
  }
  const timers = (input.timers ?? []).map(normalizeTimer);
  if (new Set(timers.map((timer) => timer.id)).size !== timers.length) {
    throw new Error("Timer identifiers must be unique within a session");
  }
  return {
    checkedIngredientIds,
    guidedStepIndex,
    targetServings: input.targetServings,
    timers,
  };
}

function normalizeTimer(timer: CookingTimer): CookingTimer {
  const id = timer.id.trim();
  if (!id || id.length > 200) throw new Error("Timer identifier is invalid");
  const label = timer.label.trim();
  if (!label || label.length > 120) throw new Error("Timer label is invalid");
  if (
    !Number.isInteger(timer.durationSeconds) ||
    timer.durationSeconds <= 0 ||
    timer.durationSeconds > MAX_TIMER_SECONDS
  ) {
    throw new Error("Timer duration is invalid");
  }
  if (timer.status === "running") {
    if (!timer.startedAt || Number.isNaN(new Date(timer.startedAt).getTime())) {
      throw new Error("A running timer requires a valid start time");
    }
    return {
      durationSeconds: timer.durationSeconds,
      id,
      label,
      startedAt: new Date(timer.startedAt).toISOString(),
      status: "running",
    };
  }
  if (timer.status === "paused") {
    if (
      !Number.isInteger(timer.remainingSeconds) ||
      (timer.remainingSeconds ?? -1) < 0 ||
      (timer.remainingSeconds ?? 0) > timer.durationSeconds
    ) {
      throw new Error("A paused timer requires valid remaining seconds");
    }
    return {
      durationSeconds: timer.durationSeconds,
      id,
      label,
      remainingSeconds: timer.remainingSeconds,
      status: "paused",
    };
  }
  if (timer.status !== "completed" && timer.status !== "cancelled") {
    throw new Error("Timer status is invalid");
  }
  return {
    durationSeconds: timer.durationSeconds,
    id,
    label,
    status: timer.status,
  };
}

function parseTimers(value: string): CookingTimer[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed))
    throw new Error("Stored cooking timers are invalid");
  return parsed.map((timer) => normalizeTimer(timer as CookingTimer));
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Stored ingredient check-offs are invalid");
  }
  const values: string[] = [];
  for (const item of parsed as unknown[]) {
    if (typeof item !== "string") {
      throw new Error("Stored ingredient check-offs are invalid");
    }
    values.push(item);
  }
  return [...new Set(values)];
}

function validRating(
  value: number | null,
): asserts value is PersonalRating | null {
  if (value !== null && (!Number.isInteger(value) || value < 1 || value > 5)) {
    throw new Error("Personal rating must be a whole number from 1 through 5");
  }
}

function validNote(value: string, maximum: number, label: string): string {
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new Error(`${label} must be at most ${maximum} characters`);
  }
  return normalized;
}

function validLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("List limit must be a whole number from 1 through 100");
  }
  return value;
}

function validOperationId(value: string): void {
  if (!value.trim() || value.length > 200) {
    throw new Error("Client operation identifier is invalid");
  }
}

function validClientSessionId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      normalized,
    )
  ) {
    throw new Error("Client cooking session identifier must be a UUID");
  }
  return normalized;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
