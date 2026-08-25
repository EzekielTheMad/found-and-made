import { useEffect, useMemo, useRef, useState } from "react";
import { data, Form, Link, redirect } from "react-router";

import {
  cacheProtectedUrls,
  queueCookingOperation,
} from "~/components/offline-coordinator";
import { createClientId } from "~/client-id";
import { appRuntimeContext } from "~/context";
import type { OfflineOperationKind } from "#src/modules/offline/offline-queue";
import { projectRecipe } from "#src/modules/recipes/recipe.projections";
import type {
  ProjectedIngredient,
  RecipeStep,
} from "#src/modules/recipes/recipe.types";
import type { MediaAsset } from "#src/modules/media/media.types";

import type { Route } from "./+types/recipe-detail";

type ViewMode = "classic" | "grid" | "guided";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.recipe.title ?? "Recipe"} · Found & Made` }];
}

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const recipe = runtime.recipeAccessService.get(
    principal,
    requiredRecipeId(params.recipeId),
  );
  const addedBy = recipe.createdByUserId
    ? runtime.identityService.contributorNames(principal, [
        recipe.createdByUserId,
      ])[0]
    : undefined;
  runtime.cookingService.recordView(principal, recipe.id);
  return {
    addedByName: addedBy?.name,
    assets: runtime.mediaService.list(principal, recipe.id),
    hero: runtime.mediaService.hero(recipe.id),
    personal: runtime.cookingService.getForRecipe(principal, recipe.id),
    principal,
    publicMode: runtime.publishingService.isPublicModeEnabled(),
    publicationStatus: runtime.publishingService.status(recipe.id),
    recipe,
  };
}

export async function action({ context, params, request }: Route.ActionArgs) {
  const recipeId = requiredRecipeId(params.recipeId);
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const service = runtime.recipeAccessService;
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "toggle-favorite") {
    const current = runtime.cookingService.getForRecipe(principal, recipeId);
    runtime.cookingService.upsertPersonalFields(principal, recipeId, {
      favorite: !current.state.favorite,
    });
    return redirect(`/recipes/${recipeId}`);
  }
  if (intent === "save-personal") {
    const note = form.get("note");
    const rating = form.get("rating");
    runtime.cookingService.upsertPersonalFields(principal, recipeId, {
      note: typeof note === "string" ? note : "",
      rating:
        typeof rating === "string" && rating
          ? (Number(rating) as 1 | 2 | 3 | 4 | 5)
          : null,
    });
    return redirect(`/recipes/${recipeId}`);
  }
  if (intent === "record-cooked") {
    const adjustment = form.get("adjustment");
    const summary = runtime.cookingService.getForRecipe(principal, recipeId);
    runtime.cookingService.recordCooked(
      principal,
      recipeId,
      typeof adjustment === "string" && adjustment.trim()
        ? { adjustment: adjustment.trim() }
        : undefined,
    );
    if (summary.activeSession) {
      runtime.cookingService.updateCookingSession(
        principal,
        summary.activeSession.id,
        { status: "completed" },
        { expectedVersion: summary.activeSession.version },
      );
    }
    return redirect(`/recipes/${recipeId}`);
  }
  if (intent === "save-variant") {
    const targetYield = Number(form.get("targetYield"));
    const title = form.get("title");
    if (typeof title !== "string" || !title.trim())
      return data({ error: "Variant title is required" }, { status: 400 });
    const variant = service.saveVariant(
      principal,
      recipeId,
      targetYield,
      title,
    );
    return redirect(`/recipes/${variant.id}`);
  }
  if (intent === "trash") {
    const version = Number(form.get("version"));
    service.trash(principal, recipeId, version);
    return redirect("/");
  }
  if (intent === "request-review") {
    runtime.publishingService.requestReview(principal, recipeId);
    return redirect(`/recipes/${recipeId}`);
  }
  if (intent === "publish") {
    runtime.publishingService.publish(principal, recipeId);
    return redirect(`/recipes/${recipeId}`);
  }
  if (intent === "unpublish") {
    runtime.publishingService.unpublish(principal, recipeId);
    return redirect(`/recipes/${recipeId}`);
  }
  return data({ error: "Unknown recipe action" }, { status: 400 });
}

export default function RecipeDetail({ loaderData }: Route.ComponentProps) {
  const { principal, recipe } = loaderData;
  const activeSession = loaderData.personal.activeSession;
  const [targetYield, setTargetYield] = useState(
    activeSession?.targetServings ?? recipe.baseYield,
  );
  const [view, setView] = useState<ViewMode>("classic");
  const [showOriginal, setShowOriginal] = useState(false);
  const [unitPreference, setUnitPreference] = useState<"as-written" | "metric">(
    "as-written",
  );
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      (activeSession?.checkedIngredientIds ?? []).map((id) => [id, true]),
    ),
  );
  const [guidedIndex, setGuidedIndex] = useState(
    activeSession?.guidedStepIndex ?? 0,
  );
  const [personalNote, setPersonalNote] = useState(
    loaderData.personal.state.note,
  );
  const [timers, setTimers] = useState<ClientTimer[]>(() =>
    (activeSession?.timers ?? []).map((timer) => ({
      durationSeconds: timer.durationSeconds,
      id: timer.id,
      label: timer.label,
      remainingSeconds: timer.remainingSeconds,
      startedAt: timer.status === "running" ? new Date().toISOString() : null,
      status: timer.status === "completed" ? "complete" : timer.status,
    })),
  );
  const sessionRef = useRef({
    id: activeSession?.id ?? "",
    version: activeSession?.version ?? 0,
  });
  const projection = useMemo(
    () => projectRecipe(recipe, targetYield, unitPreference),
    [recipe, targetYield, unitPreference],
  );
  const factor = projection.factor.numerator / projection.factor.denominator;

  useEffect(() => {
    const urls = [
      `/api/offline/recipes/${recipe.id}`,
      ...loaderData.assets.map((asset) => `/api/media/${asset.id}/web`),
    ];
    const timer = window.setTimeout(() => {
      void cacheProtectedUrls(urls).then((result) => {
        if (!result.ok) {
          window.setTimeout(() => void cacheProtectedUrls(urls), 750);
        }
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [loaderData.assets, recipe.id]);

  useEffect(() => {
    if (view !== "guided" || !("wakeLock" in navigator)) return;
    let released = false;
    let sentinel: { release(): Promise<void> } | undefined;
    void (
      navigator as Navigator & {
        wakeLock: {
          request(type: "screen"): Promise<{ release(): Promise<void> }>;
        };
      }
    ).wakeLock
      .request("screen")
      .then((value) => {
        if (released) void value.release();
        else sentinel = value;
      })
      .catch(() => undefined);
    return () => {
      released = true;
      if (sentinel) void sentinel.release();
    };
  }, [view]);

  const queueSessionChange = (
    kind: Exclude<OfflineOperationKind, "cooking.note.set">,
    payload: Record<string, unknown>,
  ) => {
    if (!sessionRef.current.id) sessionRef.current.id = createClientId();
    const operation = {
      createdAt: new Date().toISOString(),
      id: createClientId(),
      kind,
      payload: {
        ...payload,
        clientSessionId: sessionRef.current.id,
        expectedVersion: sessionRef.current.version,
        sessionId: sessionRef.current.id,
      },
      recipeId: recipe.id,
    } as const;
    sessionRef.current.version += 1;
    void queueCookingOperation(operation);
  };

  const persistTargetYield = (value: number) =>
    queueSessionChange("cooking.scale.set", { targetYield: value });

  const toggleIngredient = (ingredientId: string) => {
    setChecked((current) => {
      const next = { ...current, [ingredientId]: !current[ingredientId] };
      queueSessionChange("cooking.ingredient-check.set", {
        checked: Boolean(next[ingredientId]),
        checkedIngredientIds: Object.entries(next)
          .filter(([, value]) => value)
          .map(([id]) => id),
        ingredientId,
        targetYield,
      });
      return next;
    });
  };

  const changeGuidedIndex = (index: number) => {
    setGuidedIndex(index);
    const step = projection.guided[index];
    if (step) {
      queueSessionChange("cooking.step-progress.set", {
        guidedStepIndex: index,
        status: "active",
        stepId: step.id,
        targetYield,
      });
    }
  };

  const updateTimers = (next: ClientTimer[], changed: ClientTimer) => {
    setTimers(next);
    queueSessionChange("cooking.timer.set", {
      durationSeconds: changed.durationSeconds,
      remainingSeconds: timerRemaining(changed),
      startedAt: changed.startedAt,
      state: changed.status,
      targetYield,
      timerId: changed.id,
      timers: next.map((timer) => ({
        durationSeconds: timer.durationSeconds,
        id: timer.id,
        label: timer.label,
        remainingSeconds: timerRemaining(timer),
        startedAt: timer.startedAt,
        status: timer.status,
      })),
    });
  };

  return (
    <>
      <main className="recipe-shell">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <Link to="/">Library</Link>
          <span aria-hidden="true">/</span>
          <span>{recipe.title}</span>
        </nav>
        {loaderData.hero ? (
          <img
            alt={loaderData.hero.altText}
            className="recipe-hero"
            src={`/api/media/${loaderData.hero.id}/web`}
          />
        ) : null}
        {loaderData.assets.some((asset) => asset.role === "gallery") ? (
          <section className="media-gallery" aria-label="Recipe gallery">
            {loaderData.assets
              .filter((asset) => asset.role === "gallery")
              .map((asset) => (
                <RecipePhoto asset={asset} key={asset.id} />
              ))}
          </section>
        ) : null}
        <div className="recipe-title-row">
          <div>
            <div className="label-row">
              {recipe.variantOfId ? (
                <span className="label-chip accent-chip">Variant</span>
              ) : (
                <span className="label-chip accent-chip">Recipe</span>
              )}
              {recipe.allergens.map((allergen) => (
                <span className="label-chip" key={allergen.name}>
                  {allergen.name}
                  {allergen.confirmed ? "" : " · review"}
                </span>
              ))}
            </div>
            <h1>{recipe.title}</h1>
            <p className="recipe-meta">
              Original yield {recipe.yieldText} · version {recipe.version}
            </p>
            <dl className="recipe-provenance">
              {recipe.creatorName ? (
                <div>
                  <dt>Recipe creator</dt>
                  <dd>{recipe.creatorName}</dd>
                </div>
              ) : null}
              {loaderData.addedByName ? (
                <div>
                  <dt>Added by</dt>
                  <dd>{loaderData.addedByName}</dd>
                </div>
              ) : null}
              <div>
                <dt>Visibility</dt>
                <dd>
                  {loaderData.publicationStatus === "published"
                    ? "Public"
                    : loaderData.publicationStatus === "review"
                      ? "Awaiting review"
                      : "Private"}
                </dd>
              </div>
              <div>
                <dt>Added</dt>
                <dd>
                  <time dateTime={recipe.createdAt}>
                    {new Date(recipe.createdAt).toLocaleDateString()}
                  </time>
                </dd>
              </div>
            </dl>
            {recipe.source.originalUrl ? (
              <p className="source-line">
                Source:{" "}
                <a href={recipe.source.originalUrl} rel="noreferrer">
                  {new URL(recipe.source.originalUrl).hostname}
                </a>
              </p>
            ) : null}
          </div>
          <div className="page-action-row" aria-label="Recipe actions">
            {principal.role !== "viewer" ? (
              <Link
                className="primary-button"
                to={`/recipes/${recipe.id}/edit`}
              >
                Edit recipe
              </Link>
            ) : null}
            {principal.role !== "viewer" ? (
              <Link
                className="primary-button"
                to={`/recipes/${recipe.id}/media`}
              >
                Photos
              </Link>
            ) : null}
            {principal.role !== "viewer" ? (
              <Link
                className="primary-button"
                to={`/recipes/${recipe.id}/classification`}
              >
                Classify
              </Link>
            ) : null}
            <Link
              className="primary-button"
              to={`/cookbooks?recipe=${recipe.id}`}
            >
              Print
            </Link>
          </div>
        </div>

        {recipe.sharedNotes ? (
          <section
            aria-labelledby="shared-notes-title"
            className="shared-recipe-notes"
          >
            <p className="eyebrow">Shared with this cookbook</p>
            <h2 id="shared-notes-title">Recipe notes</h2>
            <p>{recipe.sharedNotes}</p>
          </section>
        ) : null}

        <section className="scaler-card" aria-labelledby="scaler-title">
          <div>
            <p className="eyebrow" id="scaler-title">
              Serving scaler
            </p>
            <div className="scaler-controls">
              <button
                aria-label="Decrease servings"
                onClick={() => {
                  const next = Math.max(1, targetYield - 1);
                  setTargetYield(next);
                  persistTargetYield(next);
                }}
                type="button"
              >
                −
              </button>
              <label>
                <span className="sr-only">Target servings</span>
                <input
                  aria-label="Target servings"
                  inputMode="decimal"
                  min="1"
                  onChange={(event) =>
                    setTargetYield(Math.max(1, Number(event.target.value)))
                  }
                  onBlur={() => persistTargetYield(targetYield)}
                  step="1"
                  type="number"
                  value={targetYield}
                />
              </label>
              <button
                aria-label="Increase servings"
                onClick={() => {
                  const next = targetYield + 1;
                  setTargetYield(next);
                  persistTargetYield(next);
                }}
                type="button"
              >
                +
              </button>
              <span className="factor-label">×{factor.toFixed(2)}</span>
            </div>
          </div>
          <label className="slider-label">
            <span>1</span>
            <input
              aria-label="Serving slider"
              max="24"
              min="1"
              onChange={(event) => setTargetYield(Number(event.target.value))}
              onPointerUp={() => persistTargetYield(targetYield)}
              type="range"
              value={targetYield}
            />
            <span>24</span>
          </label>
          <div className="scaler-options">
            <label>
              <input
                checked={showOriginal}
                onChange={(event) => setShowOriginal(event.target.checked)}
                type="checkbox"
              />
              Show original quantities
            </label>
            <label>
              Units
              <select
                onChange={(event) =>
                  setUnitPreference(
                    event.target.value as "as-written" | "metric",
                  )
                }
                value={unitPreference}
              >
                <option value="as-written">As written</option>
                <option value="metric">Prefer metric when supplied</option>
              </select>
            </label>
          </div>
          <p className="warning-line">
            <span aria-hidden="true">⚠</span> Times, temperatures, pan sizes,
            appliance settings, and package counts do not scale.
          </p>
        </section>

        <div className="view-switcher" aria-label="Recipe view">
          {(["classic", "guided", "grid"] as const).map((mode) => (
            <button
              aria-pressed={view === mode}
              className={view === mode ? "active" : ""}
              key={mode}
              onClick={() => setView(mode)}
              type="button"
            >
              {mode === "grid"
                ? "Merge Grid"
                : mode[0]?.toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>

        <CookingTimers onChange={updateTimers} timers={timers} />

        {projection.subRecipes.length > 0 ? (
          <section className="subrecipe-strip" aria-label="Linked sub-recipes">
            <p className="eyebrow">Prepare alongside</p>
            {projection.subRecipes.map((subRecipe) => (
              <Link to={`/recipes/${subRecipe.recipeId}`} key={subRecipe.id}>
                <strong>{subRecipe.title}</strong>
                <span>
                  {subRecipe.displayRequiredYield} required · authored for{" "}
                  {subRecipe.authoredYield}
                </span>
              </Link>
            ))}
          </section>
        ) : null}

        {view === "classic" ? (
          <ClassicView
            assets={loaderData.assets}
            checked={checked}
            components={projection.classic}
            onToggle={(ingredientId) => toggleIngredient(ingredientId)}
            showOriginal={showOriginal}
          />
        ) : null}
        {view === "guided" ? (
          <GuidedView
            assets={loaderData.assets}
            index={guidedIndex}
            onIndex={changeGuidedIndex}
            showOriginal={showOriginal}
            steps={projection.guided}
          />
        ) : null}
        {view === "grid" ? (
          <MergeGridView
            actions={projection.mergeGrid.actions}
            rows={projection.mergeGrid.rows}
            showOriginal={showOriginal}
          />
        ) : null}

        <section className="recipe-actions" aria-label="Recipe actions">
          {principal.role !== "viewer" ? (
            <details>
              <summary className="primary-button">Save scaled variant</summary>
              <Form className="inline-action-form" method="post">
                <input name="intent" type="hidden" value="save-variant" />
                <input name="targetYield" type="hidden" value={targetYield} />
                <label>
                  Variant title
                  <input
                    defaultValue={`${recipe.title} for ${targetYield}`}
                    name="title"
                    required
                  />
                </label>
                <button className="primary-button" type="submit">
                  Save independent variant
                </button>
              </Form>
            </details>
          ) : null}
          {principal.role === "editor" ? (
            <Form method="post">
              <input name="intent" type="hidden" value="request-review" />
              <button type="submit">Request publication review</button>
            </Form>
          ) : null}
          {principal.role === "owner" ? (
            <Form method="post">
              <input
                name="intent"
                type="hidden"
                value={
                  loaderData.publicationStatus === "published"
                    ? "unpublish"
                    : "publish"
                }
              />
              <button type="submit">
                {loaderData.publicationStatus === "published"
                  ? "Unpublish recipe"
                  : "Publish recipe"}
              </button>
            </Form>
          ) : null}
          {loaderData.publicMode &&
          loaderData.publicationStatus === "published" ? (
            <Link to={`/public/recipes/${recipe.id}`}>View public page</Link>
          ) : null}
          {principal.role === "owner" ? (
            <Form
              method="post"
              onSubmit={(event) => {
                if (!confirm("Move this recipe to the recycle bin?"))
                  event.preventDefault();
              }}
            >
              <input name="intent" type="hidden" value="trash" />
              <input name="version" type="hidden" value={recipe.version} />
              <button className="danger-button" type="submit">
                Move to recycle bin
              </button>
            </Form>
          ) : null}
        </section>

        <section
          className="personal-cooking-card"
          aria-labelledby="personal-title"
        >
          <div className="personal-heading">
            <div>
              <p className="eyebrow">Private to you</p>
              <h2 id="personal-title">My cooking notes</h2>
            </div>
            <Form method="post">
              <input name="intent" type="hidden" value="toggle-favorite" />
              <button
                aria-pressed={loaderData.personal.state.favorite}
                type="submit"
              >
                {loaderData.personal.state.favorite
                  ? "★ Favorited"
                  : "☆ Favorite"}
              </button>
            </Form>
          </div>
          <Form className="personal-fields" method="post">
            <input name="intent" type="hidden" value="save-personal" />
            <label>
              Personal note
              <textarea
                name="note"
                onChange={(event) => setPersonalNote(event.target.value)}
                rows={4}
                value={personalNote}
              />
            </label>
            <label>
              My rating
              <select
                defaultValue={String(loaderData.personal.state.rating ?? "")}
                name="rating"
              >
                <option value="">Not rated</option>
                {[1, 2, 3, 4, 5].map((rating) => (
                  <option key={rating} value={rating}>
                    {rating} star{rating === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
            </label>
            <div className="personal-buttons">
              <button type="submit">Save personal details</button>
              <button
                onClick={() =>
                  void queueCookingOperation({
                    createdAt: new Date().toISOString(),
                    id: createClientId(),
                    kind: "cooking.note.set",
                    payload: { value: personalNote },
                    recipeId: recipe.id,
                  })
                }
                type="button"
              >
                Save note for offline sync
              </button>
            </div>
          </Form>
          <Form className="personal-fields" method="post">
            <input name="intent" type="hidden" value="record-cooked" />
            <label>
              Adjustment made this time
              <input name="adjustment" placeholder="Optional: what changed?" />
            </label>
            <button className="primary-button" type="submit">
              Made this · record cook
            </button>
          </Form>
          {loaderData.personal.state.cookedCount > 0 ? (
            <p className="recipe-meta">
              Made {loaderData.personal.state.cookedCount} time(s)
              {loaderData.personal.state.lastCookedAt
                ? ` · last ${new Date(loaderData.personal.state.lastCookedAt).toLocaleDateString()}`
                : ""}
            </p>
          ) : null}
        </section>
      </main>
    </>
  );
}

interface ClientTimer {
  durationSeconds: number;
  id: string;
  label: string;
  remainingSeconds: number;
  startedAt: string | null;
  status: "cancelled" | "complete" | "paused" | "running";
}

function CookingTimers({
  onChange,
  timers,
}: {
  onChange: (timers: ClientTimer[], changed: ClientTimer) => void;
  timers: ClientTimer[];
}) {
  const [minutes, setMinutes] = useState(5);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!timers.some((timer) => timer.status === "running")) return;
    const interval = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => window.clearInterval(interval);
  }, [timers]);

  const replace = (changed: ClientTimer) =>
    onChange(
      timers.map((timer) => (timer.id === changed.id ? changed : timer)),
      changed,
    );

  return (
    <section className="cooking-timers" aria-labelledby="timers-title">
      <div className="personal-heading">
        <div>
          <p className="eyebrow">Cooking mode</p>
          <h2 id="timers-title">Timers</h2>
        </div>
        <div className="timer-create">
          <label>
            Minutes
            <input
              min={0.1}
              onChange={(event) => setMinutes(Number(event.target.value))}
              step={0.1}
              type="number"
              value={minutes}
            />
          </label>
          <button
            onClick={() => {
              const durationSeconds = Math.max(1, Math.round(minutes * 60));
              const timer: ClientTimer = {
                durationSeconds,
                id: createClientId(),
                label: "Cooking timer",
                remainingSeconds: durationSeconds,
                startedAt: new Date().toISOString(),
                status: "running",
              };
              onChange([...timers, timer], timer);
            }}
            type="button"
          >
            Start timer
          </button>
        </div>
      </div>
      {timers.length === 0 ? (
        <p className="recipe-meta">No active timers.</p>
      ) : (
        <div className="timer-list">
          {timers.map((timer) => {
            const remaining = timerRemaining(timer);
            const complete = remaining === 0 || timer.status === "complete";
            return (
              <article className="timer-row" key={timer.id}>
                <div>
                  <strong>{timer.label}</strong>
                  <output aria-live={complete ? "polite" : "off"}>
                    {complete ? "Complete" : formatClock(remaining)}
                  </output>
                </div>
                <div>
                  <button
                    disabled={complete || timer.status === "cancelled"}
                    onClick={() => {
                      const running = timer.status === "running";
                      replace({
                        ...timer,
                        remainingSeconds: remaining,
                        startedAt: running ? null : new Date().toISOString(),
                        status: running ? "paused" : "running",
                      });
                    }}
                    type="button"
                  >
                    {timer.status === "running" ? "Pause" : "Resume"}
                  </button>
                  <button
                    onClick={() =>
                      replace({
                        ...timer,
                        remainingSeconds: 0,
                        startedAt: null,
                        status: "cancelled",
                      })
                    }
                    type="button"
                  >
                    Cancel
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function timerRemaining(timer: ClientTimer): number {
  if (timer.status !== "running" || !timer.startedAt)
    return Math.max(0, Math.round(timer.remainingSeconds));
  const elapsed = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(timer.startedAt)) / 1000),
  );
  return Math.max(0, Math.round(timer.remainingSeconds) - elapsed);
}

function formatClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function ClassicView({
  assets,
  checked,
  components,
  onToggle,
  showOriginal,
}: {
  assets: MediaAsset[];
  checked: Record<string, boolean>;
  components: ReturnType<typeof projectRecipe>["classic"];
  onToggle: (ingredientId: string) => void;
  showOriginal: boolean;
}) {
  let completedSteps = 0;
  const stepGroups = components.map((component) => {
    const startAt = completedSteps;
    completedSteps += component.steps.length;
    return { component, startAt };
  });

  return (
    <section className="classic-layout" aria-label="Classic recipe view">
      <aside className="ingredients-card">
        <p className="eyebrow">Ingredients</p>
        {components.map((component) => (
          <div className="ingredient-group" key={component.id}>
            <h2>{component.name}</h2>
            {assets
              .filter(
                (asset) =>
                  asset.role === "component" &&
                  asset.componentId === component.id,
              )
              .map((asset) => (
                <RecipePhoto asset={asset} key={asset.id} />
              ))}
            {component.ingredients.map((ingredient) => (
              <IngredientRow
                checked={Boolean(checked[ingredient.id])}
                ingredient={ingredient}
                key={ingredient.id}
                onToggle={() => onToggle(ingredient.id)}
                showOriginal={showOriginal}
              />
            ))}
          </div>
        ))}
      </aside>
      <div className="steps-list">
        {stepGroups.map(({ component, startAt }) =>
          component.steps.length > 0 ? (
            <section
              aria-labelledby={`steps-${component.id}`}
              className="step-group"
              key={component.id}
            >
              <h2 id={`steps-${component.id}`}>{component.name}</h2>
              <div className="component-steps">
                {component.steps.map((step, index) => (
                  <article className="step-card" key={step.id}>
                    <div className="step-number">{startAt + index + 1}</div>
                    <div>
                      <p>{step.instruction}</p>
                      <StepMetadata step={step} />
                      {assets
                        .filter(
                          (asset) =>
                            asset.role === "step" && asset.stepId === step.id,
                        )
                        .map((asset) => (
                          <RecipePhoto asset={asset} key={asset.id} />
                        ))}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null,
        )}
      </div>
    </section>
  );
}

function GuidedView({
  assets,
  index,
  onIndex,
  showOriginal,
  steps,
}: {
  assets: MediaAsset[];
  index: number;
  onIndex: (index: number) => void;
  showOriginal: boolean;
  steps: ReturnType<typeof projectRecipe>["guided"];
}) {
  const step = steps[index];
  if (!step) return null;
  return (
    <section className="guided-card" aria-label="Guided recipe view">
      <div
        className="progress-cells"
        aria-label={`Step ${index + 1} of ${steps.length}`}
        aria-valuemax={steps.length}
        aria-valuemin={1}
        aria-valuenow={index + 1}
        role="progressbar"
      >
        {steps.map((item, itemIndex) => (
          <span
            className={itemIndex <= index ? "complete" : ""}
            key={item.id}
          />
        ))}
      </div>
      <p className="eyebrow">
        Step {index + 1} of {steps.length} · {step.action}
      </p>
      <h2>{step.instruction}</h2>
      <StepMetadata step={step} />
      {assets
        .filter((asset) => asset.role === "step" && asset.stepId === step.id)
        .map((asset) => (
          <RecipePhoto asset={asset} key={asset.id} />
        ))}
      {step.ingredients.length > 0 ? (
        <div className="for-step">
          <p className="eyebrow">For this step</p>
          {step.ingredients.map((ingredient) => (
            <IngredientRow
              checked={false}
              ingredient={ingredient}
              key={ingredient.id}
              showOriginal={showOriginal}
            />
          ))}
        </div>
      ) : null}
      <div className="guided-buttons">
        <button
          disabled={index === 0}
          onClick={() => onIndex(index - 1)}
          type="button"
        >
          Previous
        </button>
        <button
          className="primary-button"
          onClick={() => onIndex(Math.min(steps.length - 1, index + 1))}
          type="button"
        >
          {index === steps.length - 1 ? "Mark as cooked ✓" : "Next step"}
        </button>
      </div>
    </section>
  );
}

function MergeGridView({
  actions,
  rows,
  showOriginal,
}: {
  actions: string[];
  rows: ReturnType<typeof projectRecipe>["mergeGrid"]["rows"];
  showOriginal: boolean;
}) {
  return (
    <section
      className="merge-grid-wrap"
      aria-label="Ingredient flow merge grid"
    >
      <table className="merge-grid">
        <thead>
          <tr>
            <th scope="col">Ingredient</th>
            {actions.map((action) => (
              <th key={action} scope="col">
                {action}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.ingredient.id}>
              <th scope="row">
                <span className="quantity">
                  {showOriginal
                    ? row.ingredient.originalDisplayQuantity
                    : row.ingredient.displayQuantity}
                </span>{" "}
                {row.ingredient.name}
              </th>
              {actions.map((action) => (
                <td
                  className={
                    row.cells.some((cell) => cell.action === action)
                      ? "active-cell"
                      : ""
                  }
                  data-action={action}
                  key={action}
                >
                  {row.cells.some((cell) => cell.action === action) ? (
                    <span aria-label={`Used during ${action}`}>●</span>
                  ) : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function IngredientRow({
  checked,
  ingredient,
  onToggle,
  showOriginal,
}: {
  checked: boolean;
  ingredient: ProjectedIngredient;
  onToggle?: () => void;
  showOriginal: boolean;
}) {
  return (
    <button
      aria-pressed={checked}
      className={`ingredient-row ${checked ? "checked" : ""}`}
      onClick={onToggle}
      type="button"
    >
      <span aria-hidden="true" className="check-box">
        {checked ? "✓" : ""}
      </span>
      <span>
        <span className="quantity">
          {showOriginal
            ? ingredient.originalDisplayQuantity
            : ingredient.displayQuantity}
        </span>{" "}
        <span className="ingredient-name">{ingredient.name}</span>
        {ingredient.requirement !== "required" ? (
          <span className="requirement-label">{ingredient.requirement}</span>
        ) : null}
        {ingredient.guidance ? (
          <small className="ingredient-guidance">⚠ {ingredient.guidance}</small>
        ) : null}
      </span>
    </button>
  );
}

function StepMetadata({ step }: { step: RecipeStep }) {
  return (
    <div className="step-metadata">
      {step.time ? <span>Time {step.time}</span> : null}
      {step.temperature ? <span>Temp {step.temperature}</span> : null}
      {step.panGuidance ? <span>{step.panGuidance}</span> : null}
      {step.packageGuidance ? <span>{step.packageGuidance}</span> : null}
    </div>
  );
}

function RecipePhoto({ asset }: { asset: MediaAsset }) {
  return (
    <figure className="recipe-inline-photo">
      <img alt={asset.altText} src={`/api/media/${asset.id}/web`} />
      {asset.caption ? <figcaption>{asset.caption}</figcaption> : null}
    </figure>
  );
}

function requiredRecipeId(value: string | undefined): string {
  if (!value) throw new Error("Recipe ID is required");
  return value;
}
