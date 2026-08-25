import { randomUUID } from "node:crypto";

import {
  type DragEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { data, Form, redirect } from "react-router";

import {
  arrangePrintOutline,
  type PrintOutlineArrangement,
} from "#src/modules/printing/outline-organizer";
import type {
  PrintColorMode,
  PrintLayout,
  PrintOutlineItem,
  PrintPageSize,
  PrintVisualStyle,
} from "#src/modules/printing/printing.types";
import type { PrintSelectionSource } from "#src/modules/printing/print-selection.service.server";
import { publicActionFailure } from "~/action-error";
import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/cookbooks";

const layouts: ReadonlyArray<{
  bestFor: string;
  description: string;
  label: string;
  value: PrintLayout;
}> = [
  {
    bestFor: "Short, simple recipes",
    description: "A denser recipe card that uses fewer pages.",
    label: "Compact card",
    value: "compact-card",
  },
  {
    bestFor: "Narrative and baking recipes",
    description: "Ingredients first, followed by an easy-to-read method.",
    label: "Classic",
    value: "classic-single-column",
  },
  {
    bestFor: "Most family cookbooks",
    description: "Ingredients beside the method for quick scanning.",
    label: "Two-column",
    value: "classic-two-column",
  },
  {
    bestFor: "Cooking at the counter",
    description: "Each step calls out the ingredients it uses.",
    label: "Guided steps",
    value: "step-linked",
  },
  {
    bestFor: "Complex, staged recipes",
    description: "A landscape table maps ingredients to every step.",
    label: "Ingredient map",
    value: "landscape-merge-grid",
  },
];

const visualStyles = [
  {
    description: "Warm serif headings, generous photos, and classic rules.",
    label: "Heirloom",
    value: "heirloom",
  },
  {
    description: "Crisp blocks and strong hierarchy for a contemporary book.",
    label: "Modern",
    value: "modern",
  },
  {
    description: "Quiet typography and more white space with less decoration.",
    label: "Minimal",
    value: "minimal",
  },
] as const;

export function meta() {
  return [{ title: "Cookbook builder · Found & Made" }];
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const url = new URL(request.url);
  const collections = runtime.printingService.listCollections(principal);
  const selectedId = url.searchParams.get("collection") ?? collections[0]?.id;
  const selected = selectedId
    ? runtime.printingService.getCollection(principal, selectedId)
    : undefined;
  const jobId = url.searchParams.get("job");
  const job = jobId
    ? runtime.printingService.getPrintJob(principal, jobId)
    : undefined;
  let diagnostics: Awaited<
    ReturnType<typeof runtime.printGenerationService.diagnostics>
  > = [];
  let pagePlan:
    | Awaited<ReturnType<typeof runtime.printGenerationService.pagePlan>>
    | undefined;
  let previewRecipes: Array<{
    ingredients: string[];
    layout: PrintLayout;
    recipeId: string;
    steps: string[];
    targetServings: number;
    title: string;
  }> = [];

  if (selected?.profileId) {
    const printRequest = runtime.printGenerationService.collectionRequest(
      principal,
      selected.id,
    );
    pagePlan = await runtime.printGenerationService.pagePlan(
      principal,
      printRequest,
    );
    diagnostics = pagePlan.diagnostics;
    previewRecipes = printRequest.selections.map((selection) => {
      const recipe = runtime.recipeAccessService.get(
        principal,
        selection.recipeId,
      );
      const projection = runtime.recipeAccessService.project(
        principal,
        selection.recipeId,
        selection.targetServings,
      );
      return {
        ingredients: projection.classic
          .flatMap((component) => component.ingredients)
          .map(
            (ingredient) => `${ingredient.displayQuantity} ${ingredient.name}`,
          ),
        layout: selection.layout,
        recipeId: recipe.id,
        steps: projection.guided.map((step) => step.instruction),
        targetServings: selection.targetServings,
        title: recipe.title,
      };
    });
  }

  const recipes = runtime.recipeAccessService.list(principal);
  const categoryGroup = runtime.discoveryService
    .facetGroups(principal)
    .find((item) => item.slug === "recipe-type");
  const categoryTerms = categoryGroup
    ? runtime.discoveryService.terms(principal, categoryGroup.id)
    : [];
  const categoryById = new Map(categoryTerms.map((term) => [term.id, term]));
  const selectedRecipeIds = new Set(
    selected?.outline.flatMap((item) =>
      item.type === "recipe" ? [item.recipeId] : [],
    ) ?? [],
  );
  const recipeCategories = Object.fromEntries(
    recipes
      .filter((recipe) => selectedRecipeIds.has(recipe.id))
      .map((recipe) => {
        const category = runtime.discoveryService
          .recipeClassification(principal, recipe.id)
          .termIds.map((termId) => categoryById.get(termId))
          .filter((term) => term !== undefined)
          .sort(
            (left, right) =>
              left.position - right.position ||
              left.name.localeCompare(right.name),
          )[0];
        return [
          recipe.id,
          category
            ? {
                id: category.id,
                name: category.name,
                position: category.position,
              }
            : null,
        ];
      }),
  );

  return {
    collections,
    builderView:
      url.searchParams.get("view") === "design" ? "design" : "recipes",
    diagnostics,
    discoveryCollections: runtime.discoveryService.collections(principal),
    categoryTerms,
    job,
    labels: runtime.discoveryService.labels(principal),
    layouts,
    preselectedRecipeId: url.searchParams.get("recipe"),
    previewRecipes,
    pagePlan,
    profiles: runtime.printingService.listProfiles(principal),
    recipeCategories,
    recipes,
    savedViews: runtime.discoveryService.listSavedViews(principal),
    selected,
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const form = await request.formData();

  try {
    switch (field(form, "intent")) {
      case "create-profile": {
        runtime.printingService.createProfile(principal, {
          config: {
            colorMode: colorMode(field(form, "colorMode")),
            defaultLayout: printLayout(field(form, "defaultLayout")),
            duplex: checked(form, "duplex"),
            includeMetadata: checked(form, "includeMetadata"),
            includePhotos: checked(form, "includePhotos"),
            marginsMm: {
              bottom: positiveNumber(form, "marginBottom"),
              left: positiveNumber(form, "marginLeft"),
              right: positiveNumber(form, "marginRight"),
              top: positiveNumber(form, "marginTop"),
            },
            pageSize: pageSize(field(form, "pageSize")),
            typography: {
              bodyFontSizePt: positiveNumber(form, "bodyFontSize"),
              fontFamily: field(form, "fontFamily"),
              headingFontSizePt: positiveNumber(form, "headingFontSize"),
            },
            visualStyle: visualStyle(field(form, "visualStyle")),
          },
          name: field(form, "name"),
        });
        return redirect("/cookbooks");
      }
      case "create-collection": {
        const profileId =
          field(form, "profileId") ||
          runtime.printingService.createProfile(principal, {
            config: {
              colorMode: colorMode(field(form, "colorMode") || "color"),
              defaultLayout: "classic-single-column",
              duplex: false,
              includeMetadata: true,
              includePhotos: true,
              marginsMm: {
                bottom: 12.7,
                left: 12.7,
                right: 12.7,
                top: 12.7,
              },
              pageSize: "letter",
              typography: {
                bodyFontSizePt: 10,
                fontFamily: "Helvetica",
                headingFontSizePt: 18,
              },
              visualStyle: visualStyle(
                field(form, "visualStyle") || "heirloom",
              ),
            },
            name: `${field(form, "name") || "Family cookbook"} style`,
          }).id;
        const source = selectionSource(form);
        const recipeIds = runtime.printSelectionService.resolve(
          principal,
          source,
        );
        if (recipeIds.length === 0) {
          throw new Error("That source contains no printable recipes");
        }
        const name = field(form, "name");
        const sectionTitle = field(form, "sectionTitle");
        const outline: PrintOutlineItem[] = [
          { id: randomUUID(), title: name, type: "cover" },
          ...(sectionTitle
            ? [
                {
                  id: randomUUID(),
                  title: sectionTitle,
                  type: "section" as const,
                },
              ]
            : []),
          ...recipeIds.map((recipeId) => ({
            id: randomUUID(),
            recipeId,
            type: "recipe" as const,
          })),
        ];
        const collection = runtime.printingService.createCollection(principal, {
          description: field(form, "description"),
          globalLayout: printLayout(field(form, "globalLayout")),
          name,
          numberingMode: checked(form, "fixedEdition") ? "fixed" : "modular",
          outline,
          profileId,
        });
        return redirect(`/cookbooks?collection=${collection.id}`);
      }
      case "save-collection": {
        const collection = runtime.printingService.getCollection(
          principal,
          field(form, "collectionId"),
        );
        const outline = collection.outline
          .filter((item) => !checked(form, `remove:${item.id}`))
          .map((item) => updateOutlineItem(item, form))
          .sort(
            (left, right) =>
              (numberOr(form, `position:${left.id}`, 0) ?? 0) -
              (numberOr(form, `position:${right.id}`, 0) ?? 0),
          );
        const updated = runtime.printingService.updateCollection(
          principal,
          collection.id,
          {
            description: field(form, "description"),
            globalLayout: printLayout(field(form, "globalLayout")),
            name: field(form, "name"),
            numberingMode: checked(form, "fixedEdition") ? "fixed" : "modular",
            outline,
            profileId: field(form, "profileId"),
          },
          { expectedVersion: wholeNumber(form, "version") },
        );
        return redirect(`/cookbooks?collection=${updated.id}`);
      }
      case "rename-collection": {
        const collection = runtime.printingService.getCollection(
          principal,
          field(form, "collectionId"),
        );
        const name = field(form, "name");
        const updated = runtime.printingService.updateCollection(
          principal,
          collection.id,
          {
            name,
            outline: collection.outline.map((item) =>
              item.type === "cover" ? { ...item, title: name } : item,
            ),
          },
          { expectedVersion: wholeNumber(form, "version") },
        );
        return redirect(`/cookbooks?collection=${updated.id}&view=recipes`);
      }
      case "duplicate-collection": {
        const duplicate = runtime.printingService.duplicateCollection(
          principal,
          field(form, "collectionId"),
        );
        return redirect(`/cookbooks?collection=${duplicate.id}&view=recipes`);
      }
      case "delete-collection": {
        const collectionId = field(form, "collectionId");
        runtime.printingService.deleteCollection(principal, collectionId, {
          expectedVersion: wholeNumber(form, "version"),
        });
        const next = runtime.printingService.listCollections(principal)[0];
        return redirect(
          next ? `/cookbooks?collection=${next.id}` : "/cookbooks",
        );
      }
      case "save-outline": {
        const collection = runtime.printingService.getCollection(
          principal,
          field(form, "collectionId"),
        );
        const outline = collection.outline
          .filter((item) => !checked(form, `remove:${item.id}`))
          .map((item) => updateOutlineItem(item, form))
          .sort(
            (left, right) =>
              (numberOr(form, `position:${left.id}`, 0) ?? 0) -
              (numberOr(form, `position:${right.id}`, 0) ?? 0),
          );
        const updated = runtime.printingService.updateCollection(
          principal,
          collection.id,
          { outline },
          { expectedVersion: wholeNumber(form, "version") },
        );
        return redirect(
          `/cookbooks?collection=${updated.id}&view=recipes#outline`,
        );
      }
      case "save-design": {
        const collection = runtime.printingService.getCollection(
          principal,
          field(form, "collectionId"),
        );
        const name = field(form, "name");
        const description = field(form, "description");
        const profile = runtime.printingService.getProfile(
          principal,
          field(form, "profileId"),
        );
        if (collection.version !== wholeNumber(form, "collectionVersion")) {
          throw new Error(
            "This cookbook changed. Reload before saving design changes.",
          );
        }
        if (profile.version !== wholeNumber(form, "profileVersion")) {
          throw new Error(
            "This page style changed. Reload before saving design changes.",
          );
        }
        runtime.printingService.updateProfile(
          principal,
          profile.id,
          {
            config: {
              ...profile.config,
              colorMode: colorMode(field(form, "colorMode")),
              visualStyle: visualStyle(field(form, "visualStyle")),
            },
          },
          { expectedVersion: profile.version },
        );
        const updated = runtime.printingService.updateCollection(
          principal,
          collection.id,
          {
            description,
            globalLayout: printLayout(field(form, "globalLayout")),
            name,
            numberingMode: checked(form, "fixedEdition") ? "fixed" : "modular",
            outline: collection.outline.map((item) =>
              item.type === "cover"
                ? {
                    id: item.id,
                    ...(description ? { subtitle: description } : {}),
                    title: name,
                    type: "cover",
                  }
                : item,
            ),
            profileId: profile.id,
          },
          { expectedVersion: collection.version },
        );
        return redirect(
          `/cookbooks?collection=${updated.id}&view=design#design-panel`,
        );
      }
      case "organize-collection": {
        const collection = runtime.printingService.getCollection(
          principal,
          field(form, "collectionId"),
        );
        const recipeSummaries = new Map(
          runtime.recipeAccessService
            .list(principal)
            .map((recipe) => [recipe.id, recipe]),
        );
        const categoryGroup = runtime.discoveryService
          .facetGroups(principal)
          .find((item) => item.slug === "recipe-type");
        const categoryTerms = categoryGroup
          ? runtime.discoveryService.terms(principal, categoryGroup.id)
          : [];
        const categoryById = new Map(
          categoryTerms.map((term) => [term.id, term]),
        );
        const metadata = collection.outline.flatMap((item) => {
          if (item.type !== "recipe") return [];
          const recipe = recipeSummaries.get(item.recipeId);
          if (!recipe) return [];
          const category = runtime.discoveryService
            .recipeClassification(principal, recipe.id)
            .termIds.map((termId) => categoryById.get(termId))
            .filter((term) => term !== undefined)
            .sort(
              (left, right) =>
                left.position - right.position ||
                left.name.localeCompare(right.name),
            )[0];
          return [
            {
              ...(category
                ? {
                    category: {
                      id: category.id,
                      name: category.name,
                      position: category.position,
                    },
                  }
                : {}),
              recipeId: recipe.id,
              title: recipe.title,
              updatedAt: recipe.updatedAt,
            },
          ];
        });
        const updated = runtime.printingService.updateCollection(
          principal,
          collection.id,
          {
            outline: arrangePrintOutline(
              collection.outline,
              metadata,
              outlineArrangement(field(form, "arrangement")),
              randomUUID,
            ),
          },
          { expectedVersion: wholeNumber(form, "version") },
        );
        return redirect(`/cookbooks?collection=${updated.id}#outline`);
      }
      case "update-profile": {
        const collectionId = field(form, "collectionId");
        const profile = runtime.printingService.getProfile(
          principal,
          field(form, "profileId"),
        );
        runtime.printingService.updateProfile(
          principal,
          profile.id,
          {
            config: {
              ...profile.config,
              colorMode: colorMode(field(form, "colorMode")),
              visualStyle: visualStyle(field(form, "visualStyle")),
            },
          },
          { expectedVersion: wholeNumber(form, "profileVersion") },
        );
        return redirect(`/cookbooks?collection=${collectionId}#appearance`);
      }
      case "add-outline-item": {
        const collection = runtime.printingService.getCollection(
          principal,
          field(form, "collectionId"),
        );
        const item = newOutlineItem(form);
        const updated = runtime.printingService.updateCollection(
          principal,
          collection.id,
          { outline: [...collection.outline, item] },
          { expectedVersion: collection.version },
        );
        return redirect(`/cookbooks?collection=${updated.id}`);
      }
      case "generate-pdf": {
        const collectionId = field(form, "collectionId");
        const builderView =
          field(form, "builderView") === "design" ? "design" : "recipes";
        const job = runtime.printingService.createPrintJob(principal, {
          collectionId,
          idempotencyKey: randomUUID(),
        });
        const generated = await runtime.printGenerationService.generate(
          principal,
          job.id,
        );
        return redirect(
          `/cookbooks?collection=${collectionId}&job=${generated.job.id}&view=${builderView}#pdf-ready`,
        );
      }
      default:
        return data({ error: "Unknown cookbook action" }, { status: 400 });
    }
  } catch (error) {
    const failure = publicActionFailure(error, "Cookbook action failed");
    return data(
      { error: failure.message, requestId: failure.requestId },
      { status: 400 },
    );
  }
}

export default function Cookbooks({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  const selected = loaderData.selected;
  const selectedProfile = loaderData.profiles.find(
    (profile) => profile.id === selected?.profileId,
  );
  const [newBookSource, setNewBookSource] = useState(
    loaderData.preselectedRecipeId
      ? `recipe:${loaderData.preselectedRecipeId}`
      : "search:",
  );
  return (
    <>
      <main className="page-shell cookbook-shell">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Make a cookbook</p>
            <h1>Cookbook builder</h1>
            <p>
              Pick recipes, arrange the pages, and download a print-ready PDF.
            </p>
          </div>
        </div>
        {actionData?.error ? <p role="alert">{actionData.error}</p> : null}
        {loaderData.job?.status === "completed" ? (
          <PdfReadyNotice job={loaderData.job} />
        ) : null}

        {!selected ? (
          <section
            className="print-profile-panel"
            aria-labelledby="profiles-title"
          >
            <div>
              <p className="eyebrow">Optional settings</p>
              <h2 id="profiles-title">Page style</h2>
              <p>
                {loaderData.profiles.length
                  ? loaderData.profiles
                      .map((profile) => profile.name)
                      .join(", ")
                  : "A balanced Letter-size style will be created automatically."}
              </p>
            </div>
            <details>
              <summary>Create a custom page style</summary>
              <Form className="print-profile-form" method="post">
                <input name="intent" type="hidden" value="create-profile" />
                <label>
                  Profile name
                  <input defaultValue="Family Letter" name="name" required />
                </label>
                <label>
                  Page size
                  <select defaultValue="letter" name="pageSize">
                    <option value="letter">Letter</option>
                    <option value="a4">A4</option>
                    <option value="half-letter">Half-Letter</option>
                  </select>
                </label>
                <label>
                  Default layout
                  <LayoutSelect
                    name="defaultLayout"
                    value="classic-single-column"
                  />
                </label>
                <label>
                  Visual style
                  <select defaultValue="heirloom" name="visualStyle">
                    {visualStyles.map((style) => (
                      <option key={style.value} value={style.value}>
                        {style.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Print treatment
                  <select defaultValue="color" name="colorMode">
                    <option value="color">Color</option>
                    <option value="black-and-white">Black and white</option>
                  </select>
                </label>
                <label>
                  Font family
                  <input defaultValue="Helvetica" name="fontFamily" required />
                </label>
                <label>
                  Body size (pt)
                  <input
                    defaultValue="10"
                    min="7"
                    name="bodyFontSize"
                    type="number"
                  />
                </label>
                <label>
                  Heading size (pt)
                  <input
                    defaultValue="18"
                    min="10"
                    name="headingFontSize"
                    type="number"
                  />
                </label>
                {(["Top", "Right", "Bottom", "Left"] as const).map((side) => (
                  <label key={side}>
                    {side} margin (mm)
                    <input
                      defaultValue="12.7"
                      min="5"
                      name={`margin${side}`}
                      step="0.1"
                      type="number"
                    />
                  </label>
                ))}
                <label className="compact-check">
                  <input defaultChecked name="includePhotos" type="checkbox" />
                  Include photos
                </label>
                <label className="compact-check">
                  <input
                    defaultChecked
                    name="includeMetadata"
                    type="checkbox"
                  />
                  Include metadata
                </label>
                <label className="compact-check">
                  <input name="duplex" type="checkbox" />
                  Duplex-aware margins
                </label>
                <button type="submit">Save profile</button>
              </Form>
            </details>
          </section>
        ) : null}

        <div
          className={
            selected
              ? "cookbook-workspace"
              : "cookbook-workspace cookbook-workspace-new"
          }
        >
          <aside className="cookbook-list" aria-labelledby="collections-title">
            <div className="cookbook-list-copy">
              <p className="eyebrow">Your cookbooks</p>
              <h2 id="collections-title">Saved books</h2>
            </div>
            <nav aria-label="Print collections">
              {loaderData.collections.map((collection) => (
                <a
                  aria-current={
                    collection.id === selected?.id ? "page" : undefined
                  }
                  href={`/cookbooks?collection=${collection.id}`}
                  key={collection.id}
                >
                  {collection.name}
                </a>
              ))}
            </nav>
            <details open={!selected}>
              <summary>Start a new cookbook</summary>
              <Form className="stacked-form" method="post">
                <input name="intent" type="hidden" value="create-collection" />
                <h3 className="cookbook-step">1. Name your cookbook</h3>
                <label>
                  Cookbook title
                  <input name="name" required />
                </label>
                <label>
                  Description
                  <textarea name="description" />
                </label>
                <label>
                  Saved page style (optional)
                  <select defaultValue="" name="profileId">
                    <option value="">Use the choices below</option>
                    {loaderData.profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                </label>
                <fieldset className="choice-fieldset">
                  <legend>Visual style</legend>
                  <div className="style-choice-grid">
                    {visualStyles.map((style) => (
                      <label className="style-choice" key={style.value}>
                        <input
                          defaultChecked={style.value === "heirloom"}
                          name="visualStyle"
                          type="radio"
                          value={style.value}
                        />
                        <span
                          aria-hidden="true"
                          className={`style-swatch style-${style.value}`}
                        >
                          <i />
                          <i />
                          <i />
                        </span>
                        <strong>{style.label}</strong>
                        <small>{style.description}</small>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="choice-fieldset">
                  <legend>Print treatment</legend>
                  <div className="print-treatment-grid">
                    <label className="treatment-choice">
                      <input
                        defaultChecked
                        name="colorMode"
                        type="radio"
                        value="color"
                      />
                      <span>
                        <strong>Color</strong>
                        <small>
                          Forest and tan accents with full-color photos.
                        </small>
                      </span>
                    </label>
                    <label className="treatment-choice">
                      <input
                        name="colorMode"
                        type="radio"
                        value="black-and-white"
                      />
                      <span>
                        <strong>Black &amp; white</strong>
                        <small>
                          Grayscale photos and ink-friendly contrast.
                        </small>
                      </span>
                    </label>
                  </div>
                </fieldset>
                <h3 className="cookbook-step">2. Choose recipes</h3>
                <label>
                  Recipe source
                  <select
                    name="sourceRef"
                    onChange={(event) =>
                      setNewBookSource(event.currentTarget.value)
                    }
                    value={newBookSource}
                  >
                    <option value="search:">Search query below</option>
                    <optgroup label="Individual recipe">
                      {loaderData.recipes.map((recipe) => (
                        <option key={recipe.id} value={`recipe:${recipe.id}`}>
                          {recipe.title}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Saved view">
                      {loaderData.savedViews.map((view) => (
                        <option key={view.id} value={`saved_view:${view.id}`}>
                          {view.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Discovery collection">
                      {loaderData.discoveryCollections.map((collection) => (
                        <option
                          key={collection.id}
                          value={`collection:${collection.id}`}
                        >
                          {collection.title}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Label">
                      {loaderData.labels.map((label) => (
                        <option key={label.id} value={`label:${label.name}`}>
                          {label.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Category">
                      {loaderData.categoryTerms.map((term) => (
                        <option key={term.id} value={`facet:${term.id}`}>
                          {term.name}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </label>
                {newBookSource === "search:" ? (
                  <label>
                    Search query
                    <input name="search" placeholder="onion, soup, holiday…" />
                  </label>
                ) : null}
                <label>
                  First section title
                  <input defaultValue="Recipes" name="sectionTitle" />
                </label>
                <h3 className="cookbook-step">3. Choose the page layout</h3>
                <LayoutChoices name="globalLayout" value="classic-two-column" />
                <label className="compact-check">
                  <input name="fixedEdition" type="checkbox" />
                  Fixed edition with page numbers
                </label>
                <button className="primary-button" type="submit">
                  Create cookbook
                </button>
              </Form>
            </details>
          </aside>

          {selected ? (
            <CookbookEditor
              key={`${selected.id}-${selected.version}-${selectedProfile?.version ?? 0}`}
              loaderData={loaderData}
              selected={selected}
              selectedProfile={selectedProfile}
            />
          ) : null}
        </div>
      </main>
    </>
  );
}

function CookbookEditor({
  loaderData,
  selected,
  selectedProfile,
}: {
  loaderData: Route.ComponentProps["loaderData"];
  selected: NonNullable<Route.ComponentProps["loaderData"]["selected"]>;
  selectedProfile:
    Route.ComponentProps["loaderData"]["profiles"][number] | undefined;
}) {
  const [activeTab, setActiveTab] = useState<"design" | "recipes">(
    loaderData.builderView === "design" ? "design" : "recipes",
  );
  const initialProfile = selectedProfile ?? loaderData.profiles[0];
  const [draftName, setDraftName] = useState(selected.name);
  const [draftDescription, setDraftDescription] = useState(
    selected.description,
  );
  const [draftProfileId, setDraftProfileId] = useState(
    initialProfile?.id ?? "",
  );
  const [draftLayout, setDraftLayout] = useState(selected.globalLayout);
  const [draftFixed, setDraftFixed] = useState(
    selected.numberingMode === "fixed",
  );
  const [draftVisualStyle, setDraftVisualStyle] = useState<PrintVisualStyle>(
    initialProfile?.config.visualStyle ?? "heirloom",
  );
  const [draftColorMode, setDraftColorMode] = useState<PrintColorMode>(
    initialProfile?.config.colorMode ?? "color",
  );
  const draftProfile = loaderData.profiles.find(
    (profile) => profile.id === draftProfileId,
  );
  const sections = useMemo(
    () => sectionPreviewPages(selected.outline, loaderData.recipes),
    [loaderData.recipes, selected.outline],
  );
  const recipeOutlineItems = useMemo(
    () =>
      selected.outline.filter(
        (item): item is Extract<PrintOutlineItem, { type: "recipe" }> =>
          item.type === "recipe",
      ),
    [selected.outline],
  );
  const recipePreviews = useMemo(
    () =>
      loaderData.previewRecipes
        .map((recipe, index) => ({
          ...recipe,
          layout: recipeOutlineItems[index]?.layoutOverride ?? draftLayout,
        }))
        .slice(0, 4),
    [draftLayout, loaderData.previewRecipes, recipeOutlineItems],
  );

  function chooseProfile(profileId: string) {
    setDraftProfileId(profileId);
    const profile = loaderData.profiles.find((item) => item.id === profileId);
    if (!profile) return;
    setDraftVisualStyle(profile.config.visualStyle ?? "heirloom");
    setDraftColorMode(profile.config.colorMode ?? "color");
  }

  return (
    <>
      <div className="cookbook-editor-tabs">
        <div aria-label="Cookbook editor" role="tablist">
          <button
            aria-controls="recipes-panel"
            aria-selected={activeTab === "recipes"}
            id="recipes-tab"
            onClick={() => setActiveTab("recipes")}
            role="tab"
            type="button"
          >
            Recipes &amp; sections
            <small>Choose, group, and order the book</small>
          </button>
          <button
            aria-controls="design-panel"
            aria-selected={activeTab === "design"}
            id="design-tab"
            onClick={() => setActiveTab("design")}
            role="tab"
            type="button"
          >
            Design &amp; layout
            <small>Set the book style and preview it live</small>
          </button>
        </div>
        <div className="cookbook-editor-actions">
          <details className="cookbook-management">
            <summary>Manage cookbook</summary>
            <div className="cookbook-management-panel">
              <Form className="stacked-form" method="post">
                <input name="intent" type="hidden" value="rename-collection" />
                <input name="collectionId" type="hidden" value={selected.id} />
                <input name="version" type="hidden" value={selected.version} />
                <label>
                  New cookbook name
                  <input defaultValue={selected.name} name="name" required />
                </label>
                <button type="submit">Rename cookbook</button>
              </Form>
              <Form method="post">
                <input
                  name="intent"
                  type="hidden"
                  value="duplicate-collection"
                />
                <input name="collectionId" type="hidden" value={selected.id} />
                <button type="submit">Make a copy</button>
              </Form>
              <details className="cookbook-delete-confirmation">
                <summary>Delete cookbook</summary>
                <p>
                  This removes only the cookbook outline. Your recipes and
                  generated PDFs stay available.
                </p>
                <Form method="post">
                  <input
                    name="intent"
                    type="hidden"
                    value="delete-collection"
                  />
                  <input
                    name="collectionId"
                    type="hidden"
                    value={selected.id}
                  />
                  <input
                    name="version"
                    type="hidden"
                    value={selected.version}
                  />
                  <button className="danger-button" type="submit">
                    Delete cookbook permanently
                  </button>
                </Form>
              </details>
            </div>
          </details>
          <Form method="post">
            <input name="intent" type="hidden" value="generate-pdf" />
            <input name="collectionId" type="hidden" value={selected.id} />
            <input name="builderView" type="hidden" value={activeTab} />
            <button className="primary-button" type="submit">
              Generate print-ready PDF
            </button>
          </Form>
        </div>
      </div>

      {activeTab === "recipes" ? (
        <section
          aria-labelledby="outline-title"
          aria-live="polite"
          className="cookbook-outline cookbook-outline-wide"
          id="recipes-panel"
          role="tabpanel"
          tabIndex={0}
        >
          <OutlineBuilder
            categories={loaderData.recipeCategories}
            recipes={loaderData.recipes}
            savedPagePlan={loaderData.pagePlan}
            selected={selected}
          />
          <Form className="add-outline-form" method="post">
            <input name="intent" type="hidden" value="add-outline-item" />
            <input name="collectionId" type="hidden" value={selected.id} />
            <label>
              Add
              <select name="itemType">
                <option value="section">Section</option>
                <option value="divider">Divider</option>
                <option value="notes">Notes page</option>
                <option value="recipe">Recipe</option>
              </select>
            </label>
            <label>
              Title
              <input name="title" placeholder="Section or notes title" />
            </label>
            <label>
              Recipe
              <select name="recipeId">
                <option value="">Not a recipe item</option>
                {loaderData.recipes.map((recipe) => (
                  <option key={recipe.id} value={recipe.id}>
                    {recipe.title}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">Add to outline</button>
          </Form>
        </section>
      ) : (
        <>
          <section
            aria-labelledby="design-title"
            className="cookbook-design"
            id="design-panel"
            role="tabpanel"
            tabIndex={0}
          >
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Book design</p>
                <h2 id="design-title">Details, style, and page defaults</h2>
                <p className="muted-copy">
                  Changes appear in the preview immediately. Save once the book
                  looks right to recalculate its exact page plan.
                </p>
              </div>
            </div>
            {draftProfile ? (
              <Form className="design-form" method="post">
                <input name="intent" type="hidden" value="save-design" />
                <input name="collectionId" type="hidden" value={selected.id} />
                <input
                  name="collectionVersion"
                  type="hidden"
                  value={selected.version}
                />
                <input
                  name="profileVersion"
                  type="hidden"
                  value={draftProfile.version}
                />
                <div className="design-section">
                  <p className="eyebrow">Book identity</p>
                  <div className="design-grid">
                    <label>
                      Cookbook name
                      <input
                        name="name"
                        onChange={(event) => setDraftName(event.target.value)}
                        required
                        value={draftName}
                      />
                    </label>
                    <label>
                      Saved page style
                      <select
                        name="profileId"
                        onChange={(event) => chooseProfile(event.target.value)}
                        value={draftProfileId}
                      >
                        {loaderData.profiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="design-description">
                      Description or subtitle
                      <textarea
                        name="description"
                        onChange={(event) =>
                          setDraftDescription(event.target.value)
                        }
                        value={draftDescription}
                      />
                    </label>
                    <label className="compact-check design-numbering">
                      <input
                        checked={draftFixed}
                        name="fixedEdition"
                        onChange={(event) =>
                          setDraftFixed(event.target.checked)
                        }
                        type="checkbox"
                      />
                      Add page numbers for a fixed edition
                    </label>
                  </div>
                </div>
                <div className="design-section">
                  <p className="eyebrow">Recipe page system</p>
                  <LayoutChoices
                    name="globalLayout"
                    onChange={setDraftLayout}
                    value={draftLayout}
                  />
                </div>
                <div className="design-section">
                  <p className="eyebrow">Look and feel</p>
                  <AppearanceChoices
                    colorMode={draftColorMode}
                    onColorModeChange={setDraftColorMode}
                    onVisualStyleChange={setDraftVisualStyle}
                    visualStyle={draftVisualStyle}
                  />
                </div>
                <div className="design-save-bar">
                  <span>
                    Saving updates the exact page count, continuation pages, and
                    print notes.
                  </span>
                  <button className="primary-button" type="submit">
                    Save design &amp; recalculate
                  </button>
                </div>
              </Form>
            ) : (
              <p role="alert">
                Create a page style before changing this cookbook design.
              </p>
            )}
          </section>

          <aside className="cookbook-preview" aria-labelledby="preview-title">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Live preview</p>
                <h2 id="preview-title">Your cookbook pages</h2>
                <p className="preview-count">
                  Cover, section contents, and representative recipe pages
                </p>
              </div>
            </div>
            {loaderData.diagnostics.length ? (
              <details className="fit-diagnostics">
                <summary>
                  {loaderData.diagnostics.length} saved print notes
                </summary>
                {loaderData.diagnostics.map((diagnostic) => (
                  <p
                    key={`${diagnostic.code}-${diagnostic.recipeId ?? "book"}`}
                  >
                    <strong>{diagnostic.message}</strong>{" "}
                    {diagnostic.remediation}
                  </p>
                ))}
              </details>
            ) : (
              <p className="fit-ok">The saved design has no print warnings.</p>
            )}
            <div aria-label="Live cookbook preview" className="print-spread">
              <PreviewPage
                colorMode={draftColorMode}
                visualStyle={draftVisualStyle}
              >
                <div className="preview-cover">
                  <small>
                    {draftFixed ? "Fixed edition" : "Living cookbook"}
                  </small>
                  <h3>{draftName || "Untitled cookbook"}</h3>
                  {draftDescription ? <p>{draftDescription}</p> : null}
                  <span>Found &amp; Made</span>
                </div>
              </PreviewPage>
              {sections.flatMap((section) =>
                chunkSectionEntries(section.entries).map((entries, index) => (
                  <PreviewPage
                    colorMode={draftColorMode}
                    key={`${section.id}-${index}`}
                    visualStyle={draftVisualStyle}
                  >
                    <div className="preview-section-page">
                      <small>
                        {index === 0 ? "Section" : "Section continued"}
                      </small>
                      <h3>{section.title}</h3>
                      {index === 0 && section.subtitle ? (
                        <p>{section.subtitle}</p>
                      ) : null}
                      <h4>Recipes in this section</h4>
                      {entries.length ? (
                        <ol
                          className="section-preview-list"
                          start={index * 12 + 1}
                        >
                          {entries.map((title, entryIndex) => (
                            <li key={`${title}-${entryIndex}`}>{title}</li>
                          ))}
                        </ol>
                      ) : (
                        <p>This section does not contain recipes yet.</p>
                      )}
                    </div>
                  </PreviewPage>
                )),
              )}
              {recipePreviews.map((recipe, index) => (
                <PreviewPage
                  colorMode={draftColorMode}
                  key={`${recipe.recipeId}-${index}`}
                  layout={recipe.layout}
                  visualStyle={draftVisualStyle}
                >
                  <small>{layoutLabel(recipe.layout)}</small>
                  <h3>{recipe.title}</h3>
                  <p>Serves {recipe.targetServings}</p>
                  <div>
                    <h4>Ingredients</h4>
                    <ul>
                      {recipe.ingredients.slice(0, 7).map((ingredient) => (
                        <li key={ingredient}>{ingredient}</li>
                      ))}
                    </ul>
                    <h4>Method</h4>
                    <ol>
                      {recipe.steps.slice(0, 4).map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                  </div>
                </PreviewPage>
              ))}
            </div>
            <p className="muted-copy">
              Every recipe remains in the generated PDF. Long recipes and long
              section lists continue onto additional pages automatically.
            </p>
          </aside>
        </>
      )}
    </>
  );
}

function PreviewPage({
  children,
  colorMode,
  layout,
  visualStyle,
}: {
  children: ReactNode;
  colorMode: PrintColorMode;
  layout?: PrintLayout;
  visualStyle: PrintVisualStyle;
}) {
  return (
    <article
      className={`print-page preview-style-${visualStyle} ${
        colorMode === "black-and-white" ? "preview-black-and-white" : ""
      } ${layout ? `print-${layout}` : ""}`}
    >
      {children}
    </article>
  );
}

function sectionPreviewPages(
  outline: readonly PrintOutlineItem[],
  recipes: Route.ComponentProps["loaderData"]["recipes"],
) {
  const titleById = new Map(recipes.map((recipe) => [recipe.id, recipe.title]));
  const sections: Array<{
    entries: string[];
    id: string;
    subtitle?: string;
    title: string;
  }> = [];
  let current: (typeof sections)[number] | undefined;
  for (const item of outline) {
    if (item.type === "section") {
      current = {
        entries: [],
        id: item.id,
        ...(item.subtitle ? { subtitle: item.subtitle } : {}),
        title: item.title,
      };
      sections.push(current);
    } else if (item.type === "cover" || item.type === "divider") {
      current = undefined;
    } else if (item.type === "recipe" && current) {
      current.entries.push(titleById.get(item.recipeId) ?? "Untitled recipe");
    }
  }
  return sections;
}

function chunkSectionEntries(entries: readonly string[]): string[][] {
  if (entries.length === 0) return [[]];
  const chunks: string[][] = [];
  for (let index = 0; index < entries.length; index += 12) {
    chunks.push(entries.slice(index, index + 12));
  }
  return chunks;
}

function OutlineBuilder({
  categories,
  recipes,
  savedPagePlan,
  selected,
}: {
  categories: Route.ComponentProps["loaderData"]["recipeCategories"];
  recipes: Route.ComponentProps["loaderData"]["recipes"];
  savedPagePlan: Route.ComponentProps["loaderData"]["pagePlan"];
  selected: NonNullable<Route.ComponentProps["loaderData"]["selected"]>;
}) {
  const [items, setItems] = useState<PrintOutlineItem[]>(selected.outline);
  const [draggedId, setDraggedId] = useState<string>();
  const [announcement, setAnnouncement] = useState("");

  const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const recipeCount = items.filter((item) => item.type === "recipe").length;
  const sectionCount = items.filter((item) => item.type === "section").length;
  const savedSpanByItemId = new Map(
    savedPagePlan?.outlinePageSpans.flatMap((span) => {
      const item = selected.outline[span.itemIndex];
      return item ? [[item.id, span] as const] : [];
    }) ?? [],
  );
  const continuationPageCount =
    savedPagePlan?.outlinePageSpans.reduce(
      (total, span) => total + Math.max(0, span.pageCount - 1),
      0,
    ) ?? 0;
  const bindingSpacerCount =
    savedPagePlan?.outlinePageSpans.reduce(
      (total, span) => total + span.leadingBlankPages,
      0,
    ) ?? 0;
  const firstMovableIndex = Math.max(
    0,
    items.findIndex((item) => item.type !== "cover"),
  );

  function moveItem(itemId: string, requestedIndex: number) {
    const from = items.findIndex((item) => item.id === itemId);
    if (from < 0 || items[from]?.type === "cover") return;
    const to = Math.min(
      items.length - 1,
      Math.max(firstMovableIndex, requestedIndex),
    );
    if (from === to) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    setItems(next);
    setAnnouncement(
      `${outlineItemLabel(moved, recipeById.get(moved.type === "recipe" ? moved.recipeId : "")?.title)} moved to position ${to + 1}.`,
    );
  }

  function startDrag(event: DragEvent<HTMLButtonElement>, itemId: string) {
    setDraggedId(itemId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", itemId);
  }

  function dropItem(event: DragEvent<HTMLLIElement>, targetIndex: number) {
    event.preventDefault();
    const sourceId =
      draggedId || event.dataTransfer.getData("text/plain") || undefined;
    if (sourceId) moveItem(sourceId, targetIndex);
    setDraggedId(undefined);
  }

  return (
    <>
      <div className="panel-heading cookbook-outline-heading">
        <div>
          <p className="eyebrow">Book outline</p>
          <h2 id="outline-title">{selected.name}</h2>
          <p className="outline-summary">
            {recipeCount} {recipeCount === 1 ? "recipe" : "recipes"} ·{" "}
            {sectionCount} {sectionCount === 1 ? "section" : "sections"} ·{" "}
            {savedPagePlan?.pageCount ?? items.length} total pages
          </p>
          {savedPagePlan ? (
            <p className="outline-page-plan-note">
              Saved page plan: {continuationPageCount} content continuation{" "}
              {continuationPageCount === 1 ? "page" : "pages"}
              {bindingSpacerCount > 0
                ? ` and ${bindingSpacerCount} duplex binding ${bindingSpacerCount === 1 ? "spacer" : "spacers"}`
                : ""}
              . Save changes to recalculate.
            </p>
          ) : null}
        </div>
      </div>

      <div className="outline-organizer">
        <div>
          <p className="eyebrow">Quick arrange</p>
          <h3>Start with a useful order</h3>
          <p>
            Apply a preset, then drag pages or use the arrow buttons to make it
            yours. Category order uses each recipe&apos;s first category.
          </p>
        </div>
        <Form className="arrangement-form" method="post">
          <input name="intent" type="hidden" value="organize-collection" />
          <input name="collectionId" type="hidden" value={selected.id} />
          <input name="version" type="hidden" value={selected.version} />
          <label>
            Arrange recipes by
            <select defaultValue="category" name="arrangement">
              <option value="category">Category, then A–Z</option>
              <option value="title-asc">Title, A–Z</option>
              <option value="title-desc">Title, Z–A</option>
              <option value="recent">Recently updated</option>
            </select>
          </label>
          <button type="submit">Apply arrangement</button>
        </Form>
      </div>

      <Form className="outline-form" method="post">
        <input name="intent" type="hidden" value="save-outline" />
        <input name="collectionId" type="hidden" value={selected.id} />
        <input name="version" type="hidden" value={selected.version} />
        <p className="drag-instructions">
          Custom order: drag any page by its handle, or use Move up and Move
          down. The cover stays first.
        </p>
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
        <ol className="outline-items" aria-label="Cookbook pages">
          {items.map((item, index) => {
            const recipe =
              item.type === "recipe"
                ? recipeById.get(item.recipeId)
                : undefined;
            const label = outlineItemLabel(item, recipe?.title);
            const category =
              item.type === "recipe" ? categories[item.recipeId] : undefined;
            const movable = item.type !== "cover";
            const savedSpan = savedSpanByItemId.get(item.id);
            return (
              <li
                className={draggedId === item.id ? "is-dragging" : undefined}
                key={item.id}
                onDragOver={(event) => {
                  if (movable) event.preventDefault();
                }}
                onDrop={(event) => {
                  if (movable) dropItem(event, index);
                }}
              >
                <input
                  name={`position:${item.id}`}
                  readOnly
                  type="hidden"
                  value={index}
                />
                <div className="outline-item-row">
                  <button
                    aria-label={
                      movable
                        ? `Drag ${label} to a new position`
                        : "The cover is fixed in the first position"
                    }
                    className="drag-handle"
                    disabled={!movable}
                    draggable={movable}
                    onDragEnd={() => setDraggedId(undefined)}
                    onDragStart={(event) => startDrag(event, item.id)}
                    title={movable ? "Drag to reorder" : "Cover stays first"}
                    type="button"
                  >
                    <span aria-hidden="true">⠿</span>
                  </button>
                  <span className="outline-position" aria-hidden="true">
                    {index + 1}
                  </span>
                  <div className="outline-item-identity">
                    <span className={`outline-type outline-type-${item.type}`}>
                      {outlineTypeLabel(item.type)}
                    </span>
                    <strong>{label}</strong>
                    {item.type === "recipe" ? (
                      <small>{category?.name ?? "Uncategorized"}</small>
                    ) : null}
                    {savedSpan ? (
                      <span className="outline-page-count">
                        {savedSpan.pageCount}{" "}
                        {savedSpan.pageCount === 1 ? "page" : "pages"}
                        {savedSpan.leadingBlankPages > 0
                          ? ` + ${savedSpan.leadingBlankPages} binding spacer`
                          : ""}
                      </span>
                    ) : null}
                  </div>
                  <div className="outline-row-actions">
                    <button
                      aria-label={`Move ${label} up`}
                      disabled={!movable || index <= firstMovableIndex}
                      onClick={() => moveItem(item.id, index - 1)}
                      title="Move up"
                      type="button"
                    >
                      <span aria-hidden="true">↑</span>
                    </button>
                    <button
                      aria-label={`Move ${label} down`}
                      disabled={!movable || index >= items.length - 1}
                      onClick={() => moveItem(item.id, index + 1)}
                      title="Move down"
                      type="button"
                    >
                      <span aria-hidden="true">↓</span>
                    </button>
                    <label className="outline-remove">
                      <input name={`remove:${item.id}`} type="checkbox" />
                      Remove
                    </label>
                  </div>
                </div>
                <details className="outline-item-options">
                  <summary>Edit page settings</summary>
                  <OutlineEditor item={item} recipeTitle={recipe?.title} />
                </details>
              </li>
            );
          })}
        </ol>
        <div className="outline-save-bar">
          <span>Save after arranging or changing page settings.</span>
          <button className="primary-button" type="submit">
            Save outline
          </button>
        </div>
      </Form>
    </>
  );
}

function LayoutSelect({ name, value }: { name: string; value: PrintLayout }) {
  return (
    <select defaultValue={value} name={name}>
      {layouts.map((layout) => (
        <option key={layout.value} value={layout.value}>
          {layout.label}
        </option>
      ))}
    </select>
  );
}

function LayoutChoices({
  name,
  onChange,
  value,
}: {
  name: string;
  onChange?: (value: PrintLayout) => void;
  value: PrintLayout;
}) {
  return (
    <fieldset className="choice-fieldset layout-choice-fieldset">
      <legend>Recipe page layout</legend>
      <p className="choice-intro">
        This is the default for every recipe. You can override individual
        recipes later.
      </p>
      <div className="layout-choice-grid">
        {layouts.map((layout) => (
          <label className="layout-choice" key={layout.value}>
            <input
              checked={onChange ? layout.value === value : undefined}
              defaultChecked={onChange ? undefined : layout.value === value}
              name={name}
              onChange={onChange ? () => onChange(layout.value) : undefined}
              type="radio"
              value={layout.value}
            />
            <span
              aria-hidden="true"
              className={`layout-diagram layout-diagram-${layout.value}`}
            >
              <i />
              <i />
              <i />
            </span>
            <strong>{layout.label}</strong>
            <small>{layout.description}</small>
            <em>Best for: {layout.bestFor}</em>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function AppearanceChoices({
  colorMode,
  onColorModeChange,
  onVisualStyleChange,
  visualStyle,
}: {
  colorMode: PrintColorMode;
  onColorModeChange: (value: PrintColorMode) => void;
  onVisualStyleChange: (value: PrintVisualStyle) => void;
  visualStyle: PrintVisualStyle;
}) {
  return (
    <>
      <fieldset className="choice-fieldset">
        <legend>Template</legend>
        <div className="style-choice-grid">
          {visualStyles.map((style) => (
            <label className="style-choice" key={style.value}>
              <input
                checked={visualStyle === style.value}
                name="visualStyle"
                onChange={() => onVisualStyleChange(style.value)}
                type="radio"
                value={style.value}
              />
              <span
                aria-hidden="true"
                className={`style-swatch style-${style.value}`}
              >
                <i />
                <i />
                <i />
              </span>
              <strong>{style.label}</strong>
              <small>{style.description}</small>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="choice-fieldset">
        <legend>Print treatment</legend>
        <div className="print-treatment-grid">
          <label className="treatment-choice">
            <input
              checked={colorMode === "color"}
              name="colorMode"
              onChange={() => onColorModeChange("color")}
              type="radio"
              value="color"
            />
            <span>
              <strong>Color</strong>
              <small>Forest and tan accents with full-color photos.</small>
            </span>
          </label>
          <label className="treatment-choice">
            <input
              checked={colorMode === "black-and-white"}
              name="colorMode"
              onChange={() => onColorModeChange("black-and-white")}
              type="radio"
              value="black-and-white"
            />
            <span>
              <strong>Black &amp; white</strong>
              <small>Grayscale photos and ink-friendly contrast.</small>
            </span>
          </label>
        </div>
      </fieldset>
    </>
  );
}

function PdfReadyNotice({
  job,
}: {
  job: {
    artifact?: { pageCount: number; sizeBytes: number };
    id: string;
  };
}) {
  const noticeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    noticeRef.current?.focus();
    noticeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [job.id]);

  const href = `/cookbooks/jobs/${job.id}.pdf`;
  return (
    <div
      className="pdf-ready-notice"
      id="pdf-ready"
      ref={noticeRef}
      role="status"
      tabIndex={-1}
    >
      <div>
        <p className="eyebrow">Your cookbook is ready</p>
        <h2>Download the finished PDF</h2>
        <p>
          {job.artifact?.pageCount ?? 0} pages ·{" "}
          {formatBytes(job.artifact?.sizeBytes ?? 0)}
        </p>
      </div>
      <div className="pdf-ready-actions">
        <a className="primary-button" download href={href}>
          Download PDF
        </a>
        <a href={href} rel="noreferrer" target="_blank">
          Preview in a new tab
        </a>
      </div>
    </div>
  );
}

function OutlineEditor({
  item,
  recipeTitle,
}: {
  item: PrintOutlineItem;
  recipeTitle?: string;
}) {
  if (item.type === "recipe") {
    return (
      <div className="outline-item-fields">
        <strong>{recipeTitle ?? "Recipe"}</strong>
        <label>
          Layout override
          <select
            defaultValue={item.layoutOverride ?? ""}
            name={`layout:${item.id}`}
          >
            <option value="">Use global layout</option>
            {layouts.map((layout) => (
              <option key={layout.value} value={layout.value}>
                {layout.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Target servings
          <input
            defaultValue={item.targetServings}
            min="0.1"
            name={`servings:${item.id}`}
            step="0.1"
            type="number"
          />
        </label>
      </div>
    );
  }
  if (item.type === "notes") {
    return (
      <div className="outline-item-fields">
        <strong>Notes page</strong>
        <label>
          Heading
          <input defaultValue={item.heading} name={`title:${item.id}`} />
        </label>
        <label>
          Lines
          <input
            defaultValue={item.lines}
            min="1"
            name={`lines:${item.id}`}
            type="number"
          />
        </label>
      </div>
    );
  }
  return (
    <div className="outline-item-fields">
      <strong>{item.type}</strong>
      <label>
        Title
        <input defaultValue={item.title} name={`title:${item.id}`} />
      </label>
      <label>
        Subtitle
        <input defaultValue={item.subtitle} name={`subtitle:${item.id}`} />
      </label>
    </div>
  );
}

function outlineItemLabel(
  item: PrintOutlineItem,
  recipeTitle?: string,
): string {
  switch (item.type) {
    case "recipe":
      return recipeTitle ?? "Recipe";
    case "notes":
      return item.heading || "Notes";
    default:
      return item.title || outlineTypeLabel(item.type);
  }
}

function outlineTypeLabel(itemType: PrintOutlineItem["type"]): string {
  switch (itemType) {
    case "cover":
      return "Cover";
    case "divider":
      return "Divider";
    case "notes":
      return "Notes";
    case "recipe":
      return "Recipe";
    case "section":
      return "Section";
  }
}

function outlineArrangement(value: string): PrintOutlineArrangement {
  if (
    value === "category" ||
    value === "recent" ||
    value === "title-asc" ||
    value === "title-desc"
  ) {
    return value;
  }
  throw new Error("Unknown outline arrangement");
}

function updateOutlineItem(
  item: PrintOutlineItem,
  form: FormData,
): PrintOutlineItem {
  if (item.type === "recipe") {
    const layoutValue = field(form, `layout:${item.id}`);
    const servings = numberOr(form, `servings:${item.id}`, item.targetServings);
    return {
      id: item.id,
      ...(layoutValue ? { layoutOverride: printLayout(layoutValue) } : {}),
      recipeId: item.recipeId,
      ...(servings ? { targetServings: servings } : {}),
      type: "recipe",
    };
  }
  if (item.type === "notes") {
    return {
      heading: field(form, `title:${item.id}`),
      id: item.id,
      lines: numberOr(form, `lines:${item.id}`, item.lines) ?? item.lines,
      type: "notes",
    };
  }
  return {
    id: item.id,
    ...(field(form, `subtitle:${item.id}`)
      ? { subtitle: field(form, `subtitle:${item.id}`) }
      : {}),
    title: field(form, `title:${item.id}`),
    type: item.type,
  };
}

function newOutlineItem(form: FormData): PrintOutlineItem {
  const id = randomUUID();
  const itemType = field(form, "itemType");
  if (itemType === "recipe") {
    return { id, recipeId: field(form, "recipeId"), type: "recipe" };
  }
  if (itemType === "notes") {
    return {
      heading: field(form, "title") || "Notes",
      id,
      lines: 24,
      type: "notes",
    };
  }
  if (itemType === "divider" || itemType === "section") {
    return { id, title: field(form, "title"), type: itemType };
  }
  throw new Error("Unknown outline item type");
}

function selectionSource(form: FormData): PrintSelectionSource {
  const [kind, ...parts] = field(form, "sourceRef").split(":");
  const value = parts.join(":");
  switch (kind) {
    case "recipe":
      return { kind, recipeId: value };
    case "saved_view":
      return { kind, savedViewId: value };
    case "collection":
      return { collectionId: value, kind };
    case "facet":
      return { kind, termId: value };
    case "label":
      return { kind, label: value };
    case "search":
      return { filters: { search: field(form, "search") }, kind };
    default:
      throw new Error("Unknown print selection source");
  }
}

function layoutLabel(value: PrintLayout): string {
  return layouts.find((layout) => layout.value === value)?.label ?? value;
}

function printLayout(value: string): PrintLayout {
  const match = layouts.find((layout) => layout.value === value);
  if (!match) throw new Error("Unknown print layout");
  return match.value;
}

function colorMode(value: string): "black-and-white" | "color" {
  if (value === "black-and-white" || value === "color") return value;
  throw new Error("Unknown print treatment");
}

function visualStyle(value: string): "heirloom" | "minimal" | "modern" {
  if (value === "heirloom" || value === "minimal" || value === "modern")
    return value;
  throw new Error("Unknown visual style");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function pageSize(value: string): PrintPageSize {
  if (value === "letter" || value === "a4" || value === "half-letter")
    return value;
  throw new Error("Unknown print page size");
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function checked(form: FormData, name: string): boolean {
  return form.get(name) === "on";
}

function positiveNumber(form: FormData, name: string): number {
  const value = Number(field(form, name));
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be positive`);
  return value;
}

function wholeNumber(form: FormData, name: string): number {
  const value = Number(field(form, name));
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a whole number`);
  return value;
}

function numberOr(
  form: FormData,
  name: string,
  fallback?: number,
): number | undefined {
  const text = field(form, name);
  if (!text) return fallback;
  const value = Number(text);
  return Number.isFinite(value) ? value : fallback;
}
