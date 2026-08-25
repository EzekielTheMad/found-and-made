export type PersonalRating = 1 | 2 | 3 | 4 | 5;

export interface PersonalRecipeState {
  cookedCount: number;
  favorite: boolean;
  lastCookedAt?: string;
  lastViewedAt?: string;
  note: string;
  rating?: PersonalRating;
  recipeId: string;
  updatedAt?: string;
  version: number;
}

export interface PersonalRecipeFields {
  favorite?: boolean;
  note?: string;
  rating?: PersonalRating | null;
}

export interface PersonalRecipeListItem extends PersonalRecipeState {
  recipeUpdatedAt: string;
  title: string;
}

export interface PersonalAdjustment {
  createdAt: string;
  id: string;
  note: string;
  recipeId: string;
}

export interface CookingHistoryEntry {
  adjustment?: PersonalAdjustment;
  cookedAt: string;
  id: string;
  recipeId: string;
  title: string;
}

export type CookingSessionStatus = "abandoned" | "active" | "completed";
export type CookingTimerStatus =
  "cancelled" | "completed" | "paused" | "running";

export interface CookingTimer {
  durationSeconds: number;
  id: string;
  label: string;
  remainingSeconds?: number;
  startedAt?: string;
  status: CookingTimerStatus;
}

export interface DerivedCookingTimer extends CookingTimer {
  remainingSeconds: number;
}

export interface CookingSession {
  checkedIngredientIds: string[];
  completedAt?: string;
  createdAt: string;
  guidedStepIndex: number;
  id: string;
  recipeId: string;
  status: CookingSessionStatus;
  targetServings: number;
  timers: DerivedCookingTimer[];
  updatedAt: string;
  version: number;
}

export interface StartCookingSessionInput {
  checkedIngredientIds?: readonly string[];
  clientSessionId?: string;
  guidedStepIndex?: number;
  targetServings: number;
  timers?: readonly CookingTimer[];
}

export interface UpdateCookingSessionInput {
  checkedIngredientIds?: readonly string[];
  guidedStepIndex?: number;
  status?: CookingSessionStatus;
  targetServings?: number;
  timers?: readonly CookingTimer[];
}

export interface PersonalRecipeSummary {
  activeSession?: CookingSession;
  adjustments: PersonalAdjustment[];
  recentHistory: CookingHistoryEntry[];
  state: PersonalRecipeState;
}

interface OfflineOperationBase {
  clientOperationId: string;
  recipeId: string;
}

export type PersonalOfflineOperation =
  | (OfflineOperationBase & {
      expectedVersion?: number;
      fields: PersonalRecipeFields;
      kind: "personal.update";
    })
  | (OfflineOperationBase & { kind: "view.record" })
  | (OfflineOperationBase & {
      adjustment?: string;
      kind: "cooked.record";
    })
  | (OfflineOperationBase & { kind: "adjustment.record"; note: string })
  | (OfflineOperationBase & {
      input: StartCookingSessionInput;
      kind: "session.start";
    })
  | (OfflineOperationBase & {
      expectedVersion: number;
      input: UpdateCookingSessionInput;
      kind: "session.update";
      sessionId: string;
    });

export type PersonalOfflineOperationValue =
  | CookingHistoryEntry
  | CookingSession
  | PersonalAdjustment
  | PersonalRecipeState;

export interface PersonalOfflineOperationResult {
  applied: boolean;
  clientOperationId: string;
  result: PersonalOfflineOperationValue;
}

export class PersonalStateVersionConflictError extends Error {
  readonly code = "personal_state_conflict";

  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Personal state version conflict: expected ${expectedVersion}, found ${actualVersion}`,
    );
    this.name = "PersonalStateVersionConflictError";
  }
}

export class CookingSessionVersionConflictError extends Error {
  readonly code = "cooking_session_conflict";

  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Cooking session version conflict: expected ${expectedVersion}, found ${actualVersion}`,
    );
    this.name = "CookingSessionVersionConflictError";
  }
}

export class OfflineOperationConflictError extends Error {
  readonly code = "offline_operation_conflict";

  constructor(readonly clientOperationId: string) {
    super(
      `Offline operation ${clientOperationId} was reused with different data`,
    );
    this.name = "OfflineOperationConflictError";
  }
}
