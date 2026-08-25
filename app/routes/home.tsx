import { useEffect, useRef, useState } from "react";
import { data, Form, Link, redirect } from "react-router";

import { publicActionFailure } from "~/action-error";
import { ResponsiveDisclosure } from "~/components/responsive-disclosure";
import { appRuntimeContext } from "~/context";
import type {
  DiscoveryFilters,
  DiscoveryLayout,
  DiscoverySort,
} from "#src/modules/discovery/discovery.types";
import { systemPrincipal } from "#src/modules/identity/identity.types";

import type { Route } from "./+types/home";

export function meta() {
  return [
    { title: "Found & Made" },
    {
      name: "description",
      content: "Recipes from anywhere, made yours.",
    },
  ];
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  if (runtime.identityService.needsInitialOwner()) return redirect("/setup");
  const principal = await runtime.sessionService.principal(request);
  if (principal.kind !== "user") {
    if (!runtime.publishingService.isPublicModeEnabled()) {
      return redirect("/sign-in");
    }
    const published = runtime.publishingService
      .listPublicRecipes()
      .map((recipe) => {
        const hero = runtime.mediaService.hero(recipe.id);
        return {
          ...recipe,
          ...(hero ? { hero: { altText: hero.altText, id: hero.id } } : {}),
        };
      });
    const publishedById = new Map(
      published.map((recipe) => [recipe.id, recipe] as const),
    );
    const configuredSections = runtime.discoveryService
      .homeSections(systemPrincipal)
      .filter((section) => section.config.audience === "public")
      .map((section) => {
        const config = discoverySectionConfig(section.config);
        return {
          id: section.id,
          recipes: runtime.discoveryService
            .search(systemPrincipal, config.criteria, config.sort)
            .flatMap((result) => {
              const recipe = publishedById.get(result.id);
              return recipe ? [recipe] : [];
            }),
          title: section.title,
        };
      });
    return {
      kind: "public" as const,
      sections:
        configuredSections.length > 0
          ? configuredSections
          : [
              {
                id: "published",
                recipes: published,
                title: "Published recipes",
              },
            ],
    };
  }
  const url = new URL(request.url);
  const importBatch = importBatchKey(url.searchParams.get("importBatch"));
  const savedViews = runtime.discoveryService.listSavedViews(principal);
  const defaultView = runtime.discoveryService.defaultView(principal);
  const hasExplicitCriteria = [
    "q",
    "include",
    "exclude",
    "sort",
    "layout",
  ].some((name) => url.searchParams.has(name));
  const selectedView =
    savedViews.find((view) => view.id === url.searchParams.get("view")) ??
    (!hasExplicitCriteria && !url.searchParams.has("view")
      ? defaultView
      : undefined);
  const criteria = {
    ...(url.searchParams.has("q")
      ? { search: url.searchParams.get("q") ?? "" }
      : selectedView?.criteria.search
        ? { search: selectedView.criteria.search }
        : {}),
    includeTermIds: url.searchParams.has("include")
      ? parseIds(url.searchParams.get("include"))
      : (selectedView?.criteria.includeTermIds ?? []),
    excludeTermIds: url.searchParams.has("exclude")
      ? parseIds(url.searchParams.get("exclude"))
      : (selectedView?.criteria.excludeTermIds ?? []),
  };
  const sort = discoverySort(
    url.searchParams.get("sort") ?? selectedView?.sort,
  );
  const layout = discoveryLayout(
    url.searchParams.get("layout") ?? selectedView?.layout,
  );
  const recipeSummaries = runtime.recipeAccessService.list(principal);
  const categoryGroup = runtime.discoveryService
    .facetGroups(principal)
    .find((group) => group.slug === "recipe-type");
  const contributorNames = new Map(
    runtime.identityService
      .contributorNames(
        principal,
        recipeSummaries.flatMap((recipe) =>
          recipe.createdByUserId ? [recipe.createdByUserId] : [],
        ),
      )
      .map((user) => [user.id, user.name] as const),
  );
  const publicationStatuses = runtime.publishingService.statuses(
    recipeSummaries.map((recipe) => recipe.id),
  );
  const summaries = new Map(
    recipeSummaries.map((recipe) => [
      recipe.id,
      {
        ...recipe,
        ...(recipe.createdByUserId &&
        contributorNames.has(recipe.createdByUserId)
          ? { addedByName: contributorNames.get(recipe.createdByUserId) }
          : {}),
        publicationStatus: publicationStatuses[recipe.id] ?? "private",
      },
    ]),
  );
  const decorate = (results: readonly { id: string }[]) =>
    results.flatMap((result) => {
      const recipe = summaries.get(result.id);
      if (!recipe) return [];
      const hero = runtime.mediaService.hero(recipe.id);
      return [
        {
          ...recipe,
          ...(hero ? { hero: { altText: hero.altText, id: hero.id } } : {}),
        },
      ];
    });
  const importBatchRecipeIds = importBatch
    ? new Set(
        runtime.importService
          .list(principal)
          .filter(
            (session) =>
              session.requestKey.startsWith(
                `${principal.userId}:${importBatch}:`,
              ) && session.resultingRecipeId,
          )
          .map((session) => session.resultingRecipeId as string),
      )
    : null;
  const recipes = decorate(
    runtime.discoveryService.search(principal, criteria, sort),
  ).filter(
    (recipe) => !importBatchRecipeIds || importBatchRecipeIds.has(recipe.id),
  );
  const configuredShelves = runtime.discoveryService
    .homeSections(principal)
    .filter((section) => section.config.audience === "authenticated")
    .map((section) => {
      const config = discoverySectionConfig(section.config);
      return {
        id: section.id,
        recipes: decorate(
          runtime.discoveryService.search(
            principal,
            config.criteria,
            config.sort,
          ),
        ),
        title: section.title,
      };
    });
  const pinnedShelves = savedViews
    .filter((view) => view.pinned)
    .map((view) => ({
      id: view.id,
      recipes: decorate(
        runtime.discoveryService.search(principal, view.criteria, view.sort),
      ),
      title: view.name,
    }));
  const personalShelves = [
    {
      id: "personal-recently-viewed",
      items: runtime.cookingService.listRecentlyViewed(principal, 8),
      title: "Recently viewed",
    },
    {
      id: "personal-favorites",
      items: runtime.cookingService.listFavorites(principal, 8),
      title: "Favorites",
    },
    {
      id: "personal-recently-cooked",
      items: runtime.cookingService.listRecentlyCooked(principal, 8),
      title: "Recently cooked",
    },
  ]
    .filter((shelf) => shelf.items.length > 0)
    .map((shelf) => ({
      id: shelf.id,
      recipes: decorate(shelf.items.map((item) => ({ id: item.recipeId }))),
      title: shelf.title,
    }));
  return {
    criteria,
    defaultViewId: defaultView?.id,
    importBatch,
    kind: "private" as const,
    labels: runtime.discoveryService.labels(principal),
    layout,
    principal,
    recipes,
    savedViews,
    selectedViewId: selectedView?.id,
    shelves: [
      ...personalShelves,
      ...(configuredShelves.length > 0 ? configuredShelves : pinnedShelves),
    ],
    sort,
    status: runtime.systemService.getStatus(),
    terms: categoryGroup
      ? runtime.discoveryService.terms(principal, categoryGroup.id)
      : [],
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const form = await request.formData();
  const intent = field(form, "intent");
  try {
    if (intent === "save-view") {
      const view = runtime.discoveryService.createSavedView(principal, {
        criteria: {
          excludeTermIds: parseIds(field(form, "exclude")),
          includeTermIds: parseIds(field(form, "include")),
          search: field(form, "search"),
        },
        layout: discoveryLayout(field(form, "layout")),
        name: field(form, "name"),
        pinned: form.get("pinned") === "on",
        sort: discoverySort(field(form, "sort")),
      });
      return redirect(`/?view=${view.id}`);
    }
    if (intent === "set-default-view") {
      runtime.discoveryService.setDefaultView(
        principal,
        field(form, "viewId") || undefined,
      );
      return redirect("/");
    }
    if (intent === "configure-home") {
      const viewId = field(form, "viewId");
      const view = runtime.discoveryService
        .listSavedViews(principal)
        .find((item) => item.id === viewId);
      runtime.discoveryService.configureHomeSection(principal, {
        config: {
          audience: field(form, "audience"),
          criteria: view?.criteria ?? {},
          layout: view?.layout ?? "cards",
          sort: view?.sort ?? "recent",
          ...(view ? { viewId: view.id } : {}),
        },
        position: Number(field(form, "position")),
        title: field(form, "title"),
      });
      return redirect("/");
    }
    if (intent === "bulk-recipes") {
      const recipeIds = stringValues(form, "recipeIds");
      const bulkAction = field(form, "bulkAction");
      if (bulkAction === "trash") {
        runtime.recipeAccessService.trashMany(
          principal,
          recipeIds.map((id) => ({
            expectedVersion: Number(field(form, `version:${id}`)),
            id,
          })),
        );
        return data({
          message: `${recipeIds.length} recipes moved to the recycle bin.`,
        });
      }
      if (bulkAction === "add-tags" || bulkAction === "remove-tags") {
        runtime.discoveryService.bulkUpdateClassification(
          principal,
          recipeIds,
          {
            labelNames: [
              ...stringValues(form, "labelNames"),
              ...commaList(field(form, "labels")),
            ],
            mode: bulkAction === "add-tags" ? "add" : "remove",
            termIds: stringValues(form, "termIds"),
          },
        );
        return data({
          message: `${bulkAction === "add-tags" ? "Updated" : "Removed categories and labels from"} ${recipeIds.length} recipes.`,
        });
      }
      if (bulkAction === "publish" || bulkAction === "unpublish") {
        const count = runtime.publishingService.setPublishedMany(
          principal,
          recipeIds,
          bulkAction === "publish",
        );
        return data({
          message: `${count} recipes are now ${bulkAction === "publish" ? "public" : "private"}.`,
        });
      }
      throw new Error("Choose a supported bulk action");
    }
    return data({ error: "Unknown home action" }, { status: 400 });
  } catch (error) {
    const failure = publicActionFailure(error, "Home update failed");
    return data(
      { error: failure.message, requestId: failure.requestId },
      { status: 400 },
    );
  }
}

export default function Home({ actionData, loaderData }: Route.ComponentProps) {
  const [toolMode, setToolMode] = useState<"bulk" | "filters" | null>(null);
  if (loaderData.kind === "public") {
    return <PublicHome sections={loaderData.sections} />;
  }
  const recentShelf = loaderData.shelves.find(
    (shelf) => shelf.id === "personal-recently-viewed",
  );
  const lowerShelves = loaderData.shelves.filter(
    (shelf) => shelf.id !== "personal-recently-viewed",
  );
  return (
    <>
      <main className="page-shell">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Private cooking library</p>
            <h1>Your recipes</h1>
          </div>
          {loaderData.principal.role !== "viewer" ? (
            <Link className="button-link" to="/recipes/new">
              Add a recipe
            </Link>
          ) : null}
        </div>
        {actionData && "error" in actionData && actionData.error ? (
          <p role="alert">{actionData.error}</p>
        ) : null}
        {actionData && "message" in actionData && actionData.message ? (
          <p role="status">{actionData.message}</p>
        ) : null}
        {loaderData.importBatch ? (
          <section className="import-batch-filter" role="status">
            <span>
              Showing {loaderData.recipes.length} completed recipes from one
              import batch.
            </span>
            <Link to="/">Clear batch filter</Link>
          </section>
        ) : null}
        {recentShelf ? <RecipeShelf shelf={recentShelf} /> : null}
        <section className="discovery-tools" aria-label="Recipe discovery">
          <Form className="discovery-search" method="get">
            <div className="discovery-query-row">
              <label>
                <span className="sr-only">Search recipes</span>
                <input
                  defaultValue={loaderData.criteria.search ?? ""}
                  name="q"
                  placeholder="Search your recipes"
                  type="search"
                />
              </label>
              <button className="primary-button" type="submit">
                Search
              </button>
            </div>
            <input
              name="include"
              type="hidden"
              value={loaderData.criteria.includeTermIds.join(",")}
            />
            <input
              name="exclude"
              type="hidden"
              value={loaderData.criteria.excludeTermIds.join(",")}
            />
            {toolMode === "filters" ? (
              <details className="discovery-options" open>
                <summary>
                  Filters and display
                  <span>
                    {sortLabel(loaderData.sort)} ·{" "}
                    {layoutLabel(loaderData.layout)}
                  </span>
                </summary>
                <div className="discovery-option-grid">
                  <label>
                    Sort
                    <select defaultValue={loaderData.sort} name="sort">
                      <option value="recent">Recently updated</option>
                      <option value="created">Recently added</option>
                      <option value="title">Title</option>
                    </select>
                  </label>
                  <label>
                    Layout
                    <select defaultValue={loaderData.layout} name="layout">
                      <option value="cards">Cards</option>
                      <option value="list">List</option>
                    </select>
                  </label>
                </div>
              </details>
            ) : (
              <>
                <input name="sort" type="hidden" value={loaderData.sort} />
                <input name="layout" type="hidden" value={loaderData.layout} />
              </>
            )}
          </Form>
          <div className="library-tool-row" aria-label="Library tools">
            <button
              aria-expanded={toolMode === "filters"}
              className={toolMode === "filters" ? "primary-button" : undefined}
              onClick={() =>
                setToolMode((current) =>
                  current === "filters" ? null : "filters",
                )
              }
              type="button"
            >
              Filter
            </button>
            {loaderData.principal.role !== "viewer" &&
            loaderData.recipes.length > 0 ? (
              <button
                aria-expanded={toolMode === "bulk"}
                className={toolMode === "bulk" ? "primary-button" : undefined}
                onClick={() =>
                  setToolMode((current) => (current === "bulk" ? null : "bulk"))
                }
                type="button"
              >
                Bulk edit
              </button>
            ) : null}
          </div>
          <nav className="saved-view-row" aria-label="Saved recipe views">
            <Link
              aria-current={!loaderData.selectedViewId ? "page" : undefined}
              to="/"
            >
              All recipes
            </Link>
            {loaderData.savedViews.map((view) => (
              <Link
                aria-current={
                  loaderData.selectedViewId === view.id ? "page" : undefined
                }
                key={view.id}
                to={`/?view=${view.id}`}
              >
                {view.name}
              </Link>
            ))}
          </nav>
          {toolMode === "filters" ? (
            <ResponsiveDisclosure
              className="library-settings"
              label="Library settings"
            >
              <div className="library-settings-content">
                <Form className="default-view-form" method="post">
                  <input name="intent" type="hidden" value="set-default-view" />
                  <label>
                    Default home view
                    <select
                      defaultValue={loaderData.defaultViewId ?? ""}
                      name="viewId"
                    >
                      <option value="">All recipes</option>
                      {loaderData.savedViews.map((view) => (
                        <option key={view.id} value={view.id}>
                          {view.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit">Set default</button>
                </Form>
                {loaderData.terms.length > 0 ? (
                  <details className="facet-panel">
                    <summary>Filter by categories</summary>
                    <div className="facet-list">
                      {loaderData.terms.map((term) => (
                        <div className="facet-row" key={term.id}>
                          <span>{term.name}</span>
                          <Link
                            aria-pressed={loaderData.criteria.includeTermIds.includes(
                              term.id,
                            )}
                            role="button"
                            to={termLink(loaderData, term.id, "include")}
                          >
                            Include
                          </Link>
                          <Link
                            aria-pressed={loaderData.criteria.excludeTermIds.includes(
                              term.id,
                            )}
                            role="button"
                            to={termLink(loaderData, term.id, "exclude")}
                          >
                            Exclude
                          </Link>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
                <details>
                  <summary>Save this view</summary>
                  <Form className="inline-action-form" method="post">
                    <input name="intent" type="hidden" value="save-view" />
                    <input
                      name="search"
                      type="hidden"
                      value={loaderData.criteria.search ?? ""}
                    />
                    <input
                      name="include"
                      type="hidden"
                      value={loaderData.criteria.includeTermIds.join(",")}
                    />
                    <input
                      name="exclude"
                      type="hidden"
                      value={loaderData.criteria.excludeTermIds.join(",")}
                    />
                    <input name="sort" type="hidden" value={loaderData.sort} />
                    <input
                      name="layout"
                      type="hidden"
                      value={loaderData.layout}
                    />
                    <label>
                      View name
                      <input name="name" required />
                    </label>
                    <label>
                      <input name="pinned" type="checkbox" /> Pin on home
                    </label>
                    <button type="submit">Save view</button>
                  </Form>
                </details>
                {loaderData.principal.role === "owner" ? (
                  <details>
                    <summary>Configure a home section</summary>
                    <Form className="inline-action-form" method="post">
                      <input
                        name="intent"
                        type="hidden"
                        value="configure-home"
                      />
                      <label>
                        Section title
                        <input name="title" required />
                      </label>
                      <label>
                        Saved view
                        <select name="viewId">
                          <option value="">All recipes</option>
                          {loaderData.savedViews.map((view) => (
                            <option key={view.id} value={view.id}>
                              {view.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Audience
                        <select name="audience">
                          <option value="authenticated">
                            Authenticated home
                          </option>
                          <option value="public">Public cookbook</option>
                        </select>
                      </label>
                      <label>
                        Position
                        <input
                          defaultValue={0}
                          min={0}
                          name="position"
                          type="number"
                        />
                      </label>
                      <button type="submit">Add home section</button>
                    </Form>
                  </details>
                ) : null}
              </div>
            </ResponsiveDisclosure>
          ) : null}
        </section>
        {loaderData.recipes.length === 0 ? (
          <section className="empty-card" aria-labelledby="welcome-title">
            <p className="eyebrow">Fresh installation</p>
            <h2 id="welcome-title">Your recipes will live here.</h2>
            <p className="lede">
              Found &amp; Made turns recipes from anywhere into a private,
              durable cooking library.
            </p>
            <dl className="foundation-status">
              <div>
                <dt>Database</dt>
                <dd>Ready</dd>
              </div>
              <div>
                <dt>Installation</dt>
                <dd>{loaderData.status.installationId.slice(0, 8)}</dd>
              </div>
            </dl>
          </section>
        ) : (
          <>
            {loaderData.principal.role !== "viewer" && toolMode === "bulk" ? (
              <BulkRecipeActions
                canDelete={loaderData.principal.role === "owner"}
                canPublish={loaderData.principal.role === "owner"}
                labels={loaderData.labels}
                recipes={loaderData.recipes}
                terms={loaderData.terms}
              />
            ) : null}
            <RecipeLibrary
              key={`${loaderData.recipes.length}:${loaderData.recipes[0]?.id ?? "empty"}:${loaderData.recipes.at(-1)?.id ?? "empty"}`}
              layout={loaderData.layout}
              recipes={loaderData.recipes}
            />
          </>
        )}
        {lowerShelves.map((shelf) => (
          <RecipeShelf key={shelf.id} shelf={shelf} />
        ))}
      </main>
    </>
  );
}

type PrivateRecipeCard = Extract<
  Route.ComponentProps["loaderData"],
  { kind: "private" }
>["recipes"][number];

function RecipeLibrary({
  layout,
  recipes,
}: {
  layout: DiscoveryLayout;
  recipes: PrivateRecipeCard[];
}) {
  const [visibleCount, setVisibleCount] = useState(24);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const hasMore = visibleCount < recipes.length;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((current) => Math.min(current + 24, recipes.length));
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, recipes.length]);

  return (
    <>
      <section
        aria-label="Recipe library"
        className={
          layout === "list"
            ? "recipe-card-grid recipe-list-layout"
            : "recipe-card-grid"
        }
      >
        {recipes.slice(0, visibleCount).map((recipe) => (
          <PrivateRecipeCardLink key={recipe.id} recipe={recipe} />
        ))}
      </section>
      {hasMore ? (
        <div
          aria-label={`Loading more recipes. ${visibleCount} of ${recipes.length} shown.`}
          className="library-scroll-sentinel"
          ref={sentinelRef}
          role="status"
        >
          Loading more recipes…
        </div>
      ) : null}
    </>
  );
}

function RecipeShelf({
  shelf,
}: {
  shelf: Extract<
    Route.ComponentProps["loaderData"],
    { kind: "private" }
  >["shelves"][number];
}) {
  return (
    <section className="home-shelf">
      <h2>{shelf.title}</h2>
      {shelf.recipes.length === 0 ? (
        <p className="recipe-meta">No matching recipes in this shelf.</p>
      ) : (
        <div className="recipe-card-grid recipe-shelf-grid">
          {shelf.recipes.slice(0, 8).map((recipe) => (
            <PrivateRecipeCardLink compact key={recipe.id} recipe={recipe} />
          ))}
        </div>
      )}
    </section>
  );
}

function PrivateRecipeCardLink({
  compact = false,
  recipe,
}: {
  compact?: boolean;
  recipe: PrivateRecipeCard;
}) {
  return (
    <Link className="recipe-card" to={`/recipes/${recipe.id}`}>
      <RecipeCardPhoto hero={recipe.hero} />
      <div className="recipe-card-body">
        <div className="label-row">
          <span className="status-chip">
            {recipe.publicationStatus === "published"
              ? "Public"
              : recipe.publicationStatus === "review"
                ? "In review"
                : "Private"}
          </span>
          {!compact && recipe.variantOfId ? (
            <span className="status-chip">Variant</span>
          ) : null}
        </div>
        {compact ? <h3>{recipe.title}</h3> : <h2>{recipe.title}</h2>}
        <p className="recipe-meta">
          {recipe.yieldText}
          {compact ? "" : ` · v${recipe.version}`}
        </p>
        {recipe.addedByName ? (
          <p className="recipe-contributor">Added by {recipe.addedByName}</p>
        ) : null}
      </div>
    </Link>
  );
}

function RecipeCardPhoto({ hero }: { hero?: { altText: string; id: string } }) {
  const [failed, setFailed] = useState(false);
  if (!hero || failed) {
    return (
      <div className="recipe-photo-placeholder" aria-hidden="true">
        <span>{failed ? "Photo unavailable" : "Recipe photo"}</span>
      </div>
    );
  }
  return (
    <img
      alt={hero.altText}
      className="recipe-card-photo"
      decoding="async"
      loading="lazy"
      onError={() => setFailed(true)}
      src={`/api/media/${hero.id}/web`}
    />
  );
}

function BulkRecipeActions({
  canDelete,
  canPublish,
  labels,
  recipes,
  terms,
}: {
  canDelete: boolean;
  canPublish: boolean;
  labels: Array<{ id: string; name: string }>;
  recipes: Array<{ id: string; title: string; version: number }>;
  terms: Array<{ id: string; name: string }>;
}) {
  const [bulkAction, setBulkAction] = useState<
    "add-tags" | "publish" | "remove-tags" | "trash" | "unpublish"
  >("add-tags");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const allSelected = selected.size === recipes.length;
  const tagAction = bulkAction === "add-tags" || bulkAction === "remove-tags";
  return (
    <Form
      className="bulk-recipe-form"
      method="post"
      onSubmit={(event) => {
        const confirmation =
          bulkAction === "trash"
            ? `Move ${selected.size} selected recipes to the recycle bin?`
            : bulkAction === "publish"
              ? `Make ${selected.size} selected recipes visible in the public cookbook?`
              : null;
        if (confirmation && !confirm(confirmation)) {
          event.preventDefault();
        }
      }}
    >
      <input name="intent" type="hidden" value="bulk-recipes" />
      {recipes
        .filter((recipe) => selected.has(recipe.id))
        .map((recipe) => (
          <input
            key={recipe.id}
            name={`version:${recipe.id}`}
            type="hidden"
            value={recipe.version}
          />
        ))}
      <div className="bulk-recipe-heading">
        <div>
          <p className="eyebrow">Bulk library actions</p>
          <strong>{selected.size} selected</strong>
        </div>
        <button
          type="button"
          onClick={() =>
            setSelected(
              allSelected
                ? new Set()
                : new Set(recipes.map((recipe) => recipe.id)),
            )
          }
        >
          {allSelected ? "Clear selection" : "Select all shown"}
        </button>
      </div>
      <details className="bulk-recipe-picker">
        <summary>Select individual recipes</summary>
        <div className="bulk-recipe-checklist">
          {recipes.map((recipe) => (
            <label key={recipe.id}>
              <input
                checked={selected.has(recipe.id)}
                name="recipeIds"
                onChange={() =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(recipe.id)) next.delete(recipe.id);
                    else next.add(recipe.id);
                    return next;
                  })
                }
                type="checkbox"
                value={recipe.id}
              />{" "}
              {recipe.title}
            </label>
          ))}
        </div>
      </details>
      <div className="bulk-recipe-controls">
        <label>
          Bulk action
          <select
            name="bulkAction"
            onChange={(event) =>
              setBulkAction(event.currentTarget.value as typeof bulkAction)
            }
            value={bulkAction}
          >
            <option value="add-tags">Add categories and labels</option>
            <option value="remove-tags">Remove categories and labels</option>
            {canPublish ? (
              <>
                <option value="publish">Make public</option>
                <option value="unpublish">Make private</option>
              </>
            ) : null}
            {canDelete ? (
              <option value="trash">Move to recycle bin</option>
            ) : null}
          </select>
        </label>
        {tagAction ? (
          <>
            {terms.length > 0 ? (
              <details>
                <summary>Categories</summary>
                <div className="bulk-tag-checklist">
                  {terms.map((term) => (
                    <label key={term.id}>
                      <input name="termIds" type="checkbox" value={term.id} />{" "}
                      {term.name}
                    </label>
                  ))}
                </div>
              </details>
            ) : null}
            {labels.length > 0 ? (
              <details>
                <summary>Existing labels</summary>
                <div className="bulk-tag-checklist">
                  {labels.map((label) => (
                    <label key={label.id}>
                      <input
                        name="labelNames"
                        type="checkbox"
                        value={label.name}
                      />{" "}
                      {label.name}
                    </label>
                  ))}
                </div>
              </details>
            ) : null}
            <label>
              {bulkAction === "add-tags"
                ? "New labels, comma separated"
                : "Other labels to remove, comma separated"}
              <input name="labels" />
            </label>
          </>
        ) : bulkAction === "trash" ? (
          <p className="recipe-meta">
            Recipes remain recoverable and will not block a clean re-import.
          </p>
        ) : (
          <p className="recipe-meta">
            {bulkAction === "publish"
              ? "Selected recipes will appear in the public cookbook while public mode is enabled."
              : "Selected recipes will be removed from the public cookbook but remain in your private library."}
          </p>
        )}
        <button
          className={
            bulkAction === "trash" ? "danger-button" : "primary-button"
          }
          disabled={selected.size === 0}
          type="submit"
        >
          {bulkAction === "trash"
            ? `Move ${selected.size} to recycle bin`
            : bulkAction === "publish"
              ? `Make ${selected.size} public`
              : bulkAction === "unpublish"
                ? `Make ${selected.size} private`
                : `${bulkAction === "add-tags" ? "Add to" : "Remove from"} ${selected.size} recipes`}
        </button>
      </div>
    </Form>
  );
}

function PublicHome({
  sections,
}: {
  sections: Array<{
    id: string;
    recipes: Array<{
      hero?: { altText: string; id: string };
      id: string;
      title: string;
      updatedAt: string;
      yieldText: string;
    }>;
    title: string;
  }>;
}) {
  return (
    <>
      <main className="page-shell">
        <div className="page-heading public-heading">
          <div>
            <p className="eyebrow">Public cookbook</p>
            <h1>Recipes from anywhere, made yours.</h1>
            <p className="lede">
              A curated shelf of recipes explicitly shared by this household.
            </p>
          </div>
        </div>
        {sections.every((section) => section.recipes.length === 0) ? (
          <section className="empty-card">
            <h2>No published recipes yet.</h2>
            <p>This public cookbook is ready for its first shared recipe.</p>
          </section>
        ) : (
          sections.map((section) => (
            <section className="home-shelf" key={section.id}>
              <h2>{section.title}</h2>
              <div className="recipe-card-grid">
                {section.recipes.map((recipe) => (
                  <Link
                    className="recipe-card"
                    key={recipe.id}
                    to={`/public/recipes/${recipe.id}`}
                  >
                    {recipe.hero ? (
                      <img
                        alt={recipe.hero.altText}
                        className="recipe-card-photo"
                        src={`/public/media/${recipe.hero.id}/web`}
                      />
                    ) : (
                      <div
                        className="recipe-photo-placeholder"
                        aria-hidden="true"
                      >
                        <span>Found &amp; Made</span>
                      </div>
                    )}
                    <div className="recipe-card-body">
                      <h3>{recipe.title}</h3>
                      <p className="recipe-meta">{recipe.yieldText}</p>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          ))
        )}
      </main>
    </>
  );
}

function discoverySectionConfig(config: Record<string, unknown>): {
  criteria: DiscoveryFilters;
  layout: DiscoveryLayout;
  sort: DiscoverySort;
} {
  const criteriaValue = config.criteria;
  const criteria =
    criteriaValue && typeof criteriaValue === "object"
      ? (criteriaValue as DiscoveryFilters)
      : {};
  return {
    criteria,
    layout: discoveryLayout(
      typeof config.layout === "string" ? config.layout : undefined,
    ),
    sort: discoverySort(
      typeof config.sort === "string" ? config.sort : undefined,
    ),
  };
}

function parseIds(value: string | null): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function discoverySort(value: string | null | undefined): DiscoverySort {
  return value === "created" || value === "title" ? value : "recent";
}

function discoveryLayout(value: string | null | undefined): DiscoveryLayout {
  return value === "list" ? "list" : "cards";
}

function sortLabel(sort: DiscoverySort): string {
  if (sort === "created") return "Recently added";
  if (sort === "title") return "Title";
  return "Recently updated";
}

function layoutLabel(layout: DiscoveryLayout): string {
  return layout === "list" ? "List" : "Cards";
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function stringValues(form: FormData, name: string): string[] {
  return [
    ...new Set(
      form
        .getAll(name)
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function commaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function importBatchKey(value: string | null): string | null {
  if (!value || value.length > 200 || !/^[a-zA-Z0-9:._-]+$/.test(value)) {
    return null;
  }
  return value;
}

function termLink(
  state: {
    criteria: {
      excludeTermIds: readonly string[];
      includeTermIds: readonly string[];
      search?: string;
    };
    layout: DiscoveryLayout;
    sort: DiscoverySort;
  },
  termId: string,
  mode: "exclude" | "include",
): string {
  const include = new Set(state.criteria.includeTermIds);
  const exclude = new Set(state.criteria.excludeTermIds);
  const selected = mode === "include" ? include : exclude;
  const opposite = mode === "include" ? exclude : include;
  if (selected.has(termId)) selected.delete(termId);
  else {
    selected.add(termId);
    opposite.delete(termId);
  }
  const params = new URLSearchParams({
    layout: state.layout,
    sort: state.sort,
  });
  if (state.criteria.search) params.set("q", state.criteria.search);
  if (include.size) params.set("include", [...include].join(","));
  if (exclude.size) params.set("exclude", [...exclude].join(","));
  return `/?${params.toString()}`;
}
