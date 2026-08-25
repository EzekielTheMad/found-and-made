import { type ReactNode, useEffect, useMemo, useState } from "react";
import { data, Form, Link, redirect } from "react-router";

import { appRuntimeContext } from "~/context";
import { createClientId } from "~/client-id";
import {
  RECIPE_CREATOR_MAX_LENGTH,
  RECIPE_SHARED_NOTES_MAX_LENGTH,
  RECIPE_SOURCE_URL_MAX_LENGTH,
  RECIPE_TITLE_MAX_LENGTH,
  RECIPE_YIELD_MAX_LENGTH,
} from "#src/modules/recipes/recipe-metadata";
import {
  type ConfirmedClassification,
  RecipeConflictError,
  RecipeDuplicateError,
  type RecipeAggregate,
  type RecipeDraft,
  type RecipeIngredient,
  type RecipeEquipment,
  RecipeValidationError,
} from "#src/modules/recipes/recipe.types";

import type { Route } from "./+types/recipe-editor";

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    {
      title: `Edit ${loaderData?.recipe.title ?? "recipe"} · Found & Made`,
    },
  ];
}

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  runtime.identityService.policy.require(principal, "recipe:edit");
  const service = runtime.recipeAccessService;
  const recipe = service.get(principal, requiredRecipeId(params.recipeId));
  return {
    availableRecipes: service
      .list(principal)
      .filter((item) => item.id !== recipe.id),
    recipe,
    revisions: service.revisions(principal, recipe.id).map((revision) => ({
      createdAt: revision.createdAt,
      id: revision.id,
      reason: revision.reason,
      version: revision.version,
    })),
  };
}

export async function action({ context, params, request }: Route.ActionArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const recipeId = requiredRecipeId(params.recipeId);
  const form = await request.formData();
  const restoreRevisionVersion = form.get("restoreRevisionVersion");
  if (typeof restoreRevisionVersion === "string") {
    try {
      runtime.recipeAccessService.restoreRevision(
        principal,
        recipeId,
        Number(restoreRevisionVersion),
        Number(form.get("version")),
      );
      return redirect(`/recipes/${recipeId}/edit#history`);
    } catch (error) {
      if (error instanceof RecipeConflictError)
        return data(
          {
            error: `This recipe changed in another session (current version ${error.actualVersion}). Reload before restoring.`,
          },
          { status: 409 },
        );
      throw error;
    }
  }
  const serialized = form.get("recipe");
  if (typeof serialized !== "string")
    return data({ error: "Recipe data is required" }, { status: 400 });

  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecipeDraft(parsed))
      return data({ error: "Recipe data is malformed" }, { status: 400 });
    const version = Number(form.get("version"));
    runtime.recipeAccessService.update(principal, recipeId, parsed, {
      expectedVersion: version,
      reason: "Saved from recipe editor",
    });
    return redirect(`/recipes/${recipeId}`);
  } catch (error) {
    if (error instanceof RecipeConflictError)
      return data(
        {
          error: `This recipe changed in another session (current version ${error.actualVersion}). Reload before saving.`,
        },
        { status: 409 },
      );
    if (error instanceof RecipeDuplicateError)
      return data(
        {
          error: `Possible duplicate: ${error.matches.map((match) => match.title).join(", ")}`,
        },
        { status: 409 },
      );
    if (error instanceof RecipeValidationError)
      return data({ error: error.message }, { status: 400 });
    throw error;
  }
}

export default function RecipeEditor({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  const { availableRecipes, recipe, revisions } = loaderData;
  const [draft, setDraft] = useState<RecipeDraft>(() => toDraft(recipe));
  const [selectedIngredientId, setSelectedIngredientId] = useState(
    recipe.ingredients[0]?.id ?? "",
  );
  const phoneViewport = usePhoneViewport();

  useEffect(() => {
    setDraft(toDraft(recipe));
    setSelectedIngredientId(recipe.ingredients[0]?.id ?? "");
  }, [recipe.id, recipe.version]);
  const unmapped = draft.ingredients.filter(
    (ingredient) => ingredient.stepIds.length === 0,
  );
  const selectedIngredient = draft.ingredients.find(
    (ingredient) => ingredient.id === selectedIngredientId,
  );
  const serialized = useMemo(() => JSON.stringify(draft), [draft]);
  const baselineSerialized = useMemo(
    () => JSON.stringify(toDraft(recipe)),
    [recipe.id, recipe.version],
  );
  const isDirty = serialized !== baselineSerialized;

  return (
    <>
      <main className="editor-shell">
        <h1 className="sr-only">Edit {recipe.title}</h1>
        <Form id="recipe-editor-save" method="post">
          <input name="recipe" type="hidden" value={serialized} />
          <input name="version" type="hidden" value={recipe.version} />
        </Form>
        <div className="editor-toolbar">
          <div>
            <p className="eyebrow">Recipe editor · version {recipe.version}</p>
            <input
              aria-label="Recipe title"
              className="editor-title-input"
              maxLength={RECIPE_TITLE_MAX_LENGTH}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  title: event.target.value,
                }))
              }
              required
              value={draft.title}
            />
            <div className="editor-context-links">
              <Link to={`/recipes/${recipe.id}`}>Cancel editing</Link>
              <a href="#history">View history</a>
            </div>
          </div>
          <div className="editor-save">
            <span className="autosave-status">
              {isDirty ? "Unsaved changes" : "All changes saved"}
            </span>
            <button
              className="primary-button"
              disabled={!isDirty}
              form="recipe-editor-save"
              type="submit"
            >
              Save recipe
            </button>
          </div>
        </div>

        {actionData?.error ? (
          <div className="error-banner" role="alert">
            <strong>Couldn’t save.</strong> {actionData.error}
          </div>
        ) : null}
        {unmapped.length > 0 ? (
          <div className="warning-banner" role="status">
            <strong>{unmapped.length} unmapped ingredient(s).</strong> Select an
            ingredient, then map it to at least one step in the same component.
          </div>
        ) : null}

        <section className="editor-basics" aria-label="Recipe basics">
          <label>
            Base servings
            <input
              min="0.1"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  baseYield: Number(event.target.value),
                }))
              }
              step="0.1"
              type="number"
              value={draft.baseYield}
            />
          </label>
          <label>
            Descriptive yield
            <input
              maxLength={RECIPE_YIELD_MAX_LENGTH}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  yieldText: event.target.value,
                }))
              }
              value={draft.yieldText}
            />
          </label>
          <label>
            Recipe creator
            <input
              maxLength={RECIPE_CREATOR_MAX_LENGTH}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  creatorName: event.target.value || undefined,
                }))
              }
              placeholder="A friend, relative, chef, or publication"
              value={draft.creatorName ?? ""}
            />
          </label>
          <label>
            Source URL
            <input
              maxLength={RECIPE_SOURCE_URL_MAX_LENGTH}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  source: {
                    ...current.source,
                    originalUrl: event.target.value || undefined,
                  },
                }))
              }
              type="url"
              value={draft.source.originalUrl ?? ""}
            />
          </label>
        </section>

        <EditorDisclosure
          detail={`${draft.subRecipes.length} linked`}
          label="Linked recipes"
          phoneViewport={phoneViewport}
          sectionName="linked-recipes"
        >
          <section
            className="subrecipe-editor"
            aria-labelledby="subrecipes-title"
          >
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Reusable preparations</p>
                <h2 id="subrecipes-title">Linked sub-recipes</h2>
              </div>
              <button
                className="outline-button"
                disabled={availableRecipes.length === 0}
                onClick={() => {
                  const linked = availableRecipes.find(
                    (candidate) =>
                      !draft.subRecipes.some(
                        (edge) => edge.recipeId === candidate.id,
                      ),
                  );
                  const component = draft.components[0];
                  const step = draft.steps.find(
                    (item) => item.componentId === component?.id,
                  );
                  if (!linked || !component || !step) return;
                  setDraft((current) => ({
                    ...current,
                    subRecipes: [
                      ...current.subRecipes,
                      {
                        authoredYield: linked.baseYield,
                        componentId: component.id,
                        id: createClientId(),
                        recipeId: linked.id,
                        requiredYield: linked.baseYield,
                        stepIds: [step.id],
                        title: linked.title,
                      },
                    ],
                  }));
                }}
                type="button"
              >
                + Link recipe
              </button>
            </div>
            {draft.subRecipes.length === 0 ? (
              <p className="muted">
                Link an existing sauce, dough, filling, or other reusable
                recipe.
              </p>
            ) : (
              draft.subRecipes.map((edge) => (
                <div className="subrecipe-row" key={edge.id}>
                  <label>
                    Recipe
                    <select
                      onChange={(event) => {
                        const linked = availableRecipes.find(
                          (candidate) => candidate.id === event.target.value,
                        );
                        if (!linked) return;
                        setDraft((current) => ({
                          ...current,
                          subRecipes: current.subRecipes.map((item) =>
                            item.id === edge.id
                              ? {
                                  ...item,
                                  authoredYield: linked.baseYield,
                                  recipeId: linked.id,
                                  title: linked.title,
                                }
                              : item,
                          ),
                        }));
                      }}
                      value={edge.recipeId}
                    >
                      {availableRecipes.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Required yield
                    <input
                      min="0.1"
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          subRecipes: current.subRecipes.map((item) =>
                            item.id === edge.id
                              ? {
                                  ...item,
                                  requiredYield: Number(event.target.value),
                                }
                              : item,
                          ),
                        }))
                      }
                      step="0.1"
                      type="number"
                      value={edge.requiredYield}
                    />
                  </label>
                  <label>
                    Component
                    <select
                      onChange={(event) => {
                        const componentId = event.target.value;
                        const step = draft.steps.find(
                          (item) => item.componentId === componentId,
                        );
                        setDraft((current) => ({
                          ...current,
                          subRecipes: current.subRecipes.map((item) =>
                            item.id === edge.id
                              ? {
                                  ...item,
                                  componentId,
                                  stepIds: step ? [step.id] : [],
                                }
                              : item,
                          ),
                        }));
                      }}
                      value={edge.componentId}
                    >
                      {draft.components.map((component) => (
                        <option key={component.id} value={component.id}>
                          {component.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="danger-button"
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        subRecipes: current.subRecipes.filter(
                          (item) => item.id !== edge.id,
                        ),
                      }))
                    }
                    type="button"
                  >
                    Unlink
                  </button>
                </div>
              ))
            )}
          </section>
        </EditorDisclosure>

        <EditorDisclosure
          detail="Source, equipment, and classifications"
          label="Details"
          phoneViewport={phoneViewport}
          sectionName="details"
        >
          <section className="metadata-editor" aria-labelledby="metadata-title">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Quality and provenance</p>
                <h2 id="metadata-title">Recipe metadata</h2>
              </div>
            </div>
            <div className="metadata-columns">
              <div>
                <h3>Source wording</h3>
                <label>
                  Private original wording
                  <textarea
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        source: {
                          ...current.source,
                          originalWording: event.target.value || undefined,
                        },
                      }))
                    }
                    rows={5}
                    value={draft.source.originalWording ?? ""}
                  />
                </label>
                <p className="muted">
                  Preserved privately for attribution and lossless comparison.
                </p>
                <h3>Shared recipe notes</h3>
                <label>
                  Notes for everyone with access
                  <textarea
                    maxLength={RECIPE_SHARED_NOTES_MAX_LENGTH}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        sharedNotes: event.target.value || undefined,
                      }))
                    }
                    placeholder="Family tips, serving traditions, or corrections"
                    rows={5}
                    value={draft.sharedNotes ?? ""}
                  />
                </label>
                <p className="muted">
                  Editors can update these notes. They are distinct from each
                  person&apos;s private cooking notes.
                </p>
              </div>
              <EquipmentEditor
                equipment={draft.equipment}
                onChange={(equipment) =>
                  setDraft((current) => ({ ...current, equipment }))
                }
              />
              <div>
                <ClassificationEditor
                  label="Allergens"
                  onChange={(allergens) =>
                    setDraft((current) => ({ ...current, allergens }))
                  }
                  values={draft.allergens}
                />
                <ClassificationEditor
                  label="Dietary classifications"
                  onChange={(diets) =>
                    setDraft((current) => ({ ...current, diets }))
                  }
                  values={draft.diets}
                />
              </div>
            </div>
            <p className="warning-line">
              ⚠ Imported or inferred allergen and dietary classifications
              require human confirmation and are not medical guarantees.
            </p>
          </section>
        </EditorDisclosure>

        <div className="editor-columns">
          <EditorDisclosure
            detail={`${draft.ingredients.length} ingredients`}
            label="Ingredients"
            phoneViewport={phoneViewport}
            primary
            sectionName="ingredients"
          >
            <section
              className="editor-panel"
              aria-labelledby="ingredients-title"
            >
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Canonical ingredients</p>
                  <h2 id="ingredients-title">Ingredients</h2>
                </div>
                <button
                  className="outline-button"
                  onClick={() => {
                    const componentId = draft.components[0]?.id;
                    if (!componentId) return;
                    const ingredient = newIngredient(componentId);
                    setDraft((current) => ({
                      ...current,
                      ingredients: [...current.ingredients, ingredient],
                    }));
                    setSelectedIngredientId(ingredient.id);
                  }}
                  type="button"
                >
                  + Ingredient
                </button>
              </div>
              {draft.components.map((component) => (
                <div className="editor-group" key={component.id}>
                  <input
                    aria-label="Component name"
                    className="component-name-input"
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        components: current.components.map((item) =>
                          item.id === component.id
                            ? { ...item, name: event.target.value }
                            : item,
                        ),
                      }))
                    }
                    value={component.name}
                  />
                  {draft.ingredients
                    .filter(
                      (ingredient) => ingredient.componentId === component.id,
                    )
                    .map((ingredient) => (
                      <IngredientEditorRow
                        ingredient={ingredient}
                        key={ingredient.id}
                        onChange={(next) =>
                          setDraft((current) => ({
                            ...current,
                            ingredients: current.ingredients.map((item) =>
                              item.id === next.id ? next : item,
                            ),
                          }))
                        }
                        onSelect={() => setSelectedIngredientId(ingredient.id)}
                        selected={ingredient.id === selectedIngredientId}
                      />
                    ))}
                  <button
                    className="dashed-button"
                    onClick={() => {
                      const ingredient = newIngredient(component.id);
                      setDraft((current) => ({
                        ...current,
                        ingredients: [...current.ingredients, ingredient],
                      }));
                      setSelectedIngredientId(ingredient.id);
                    }}
                    type="button"
                  >
                    + Add to {component.name}
                  </button>
                </div>
              ))}
              <button
                className="dashed-button"
                onClick={() => {
                  const id = createClientId();
                  setDraft((current) => ({
                    ...current,
                    components: [
                      ...current.components,
                      {
                        id,
                        name: "New component",
                        position: current.components.length,
                      },
                    ],
                  }));
                }}
                type="button"
              >
                + Add component
              </button>
              {selectedIngredient ? (
                <SubstitutionEditor
                  ingredient={selectedIngredient}
                  onChange={(next) =>
                    setDraft((current) => ({
                      ...current,
                      ingredients: current.ingredients.map((item) =>
                        item.id === next.id ? next : item,
                      ),
                    }))
                  }
                />
              ) : null}
            </section>
          </EditorDisclosure>

          <EditorDisclosure
            detail={`${draft.steps.length} steps`}
            label="Steps & mappings"
            phoneViewport={phoneViewport}
            sectionName="steps"
          >
            <section className="editor-panel" aria-labelledby="steps-title">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Ingredient flow</p>
                  <h2 id="steps-title">Steps &amp; mappings</h2>
                </div>
                <span className="mapping-selection">
                  {selectedIngredient
                    ? `Selected: ${selectedIngredient.name}`
                    : "Select an ingredient"}
                </span>
              </div>
              {[...draft.steps]
                .sort((left, right) => left.position - right.position)
                .map((step, index) => {
                  const mapped = selectedIngredient?.stepIds.includes(step.id);
                  const sameComponent =
                    selectedIngredient?.componentId === step.componentId;
                  return (
                    <article className="step-editor-card" key={step.id}>
                      <span className="step-number">{index + 1}</span>
                      <div className="step-editor-fields">
                        <div className="field-pair">
                          <label>
                            Action column
                            <input
                              onChange={(event) =>
                                updateStep(setDraft, step.id, {
                                  action: event.target.value,
                                })
                              }
                              value={step.action}
                            />
                          </label>
                          <label>
                            Component
                            <select
                              onChange={(event) =>
                                updateStep(setDraft, step.id, {
                                  componentId: event.target.value,
                                })
                              }
                              value={step.componentId}
                            >
                              {draft.components.map((component) => (
                                <option key={component.id} value={component.id}>
                                  {component.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <label>
                          Instruction
                          <textarea
                            onChange={(event) =>
                              updateStep(setDraft, step.id, {
                                instruction: event.target.value,
                              })
                            }
                            rows={3}
                            value={step.instruction}
                          />
                        </label>
                        <div className="mapped-chips">
                          {draft.ingredients
                            .filter((ingredient) =>
                              ingredient.stepIds.includes(step.id),
                            )
                            .map((ingredient) => (
                              <span
                                className="mapping-chip"
                                key={ingredient.id}
                              >
                                {ingredient.name}
                              </span>
                            ))}
                        </div>
                        <button
                          className={
                            mapped ? "outline-button" : "dashed-button"
                          }
                          disabled={!selectedIngredient || !sameComponent}
                          onClick={() => {
                            if (!selectedIngredient) return;
                            const next = {
                              ...selectedIngredient,
                              stepIds: mapped
                                ? selectedIngredient.stepIds.filter(
                                    (id) => id !== step.id,
                                  )
                                : [...selectedIngredient.stepIds, step.id],
                            };
                            setDraft((current) => ({
                              ...current,
                              ingredients: current.ingredients.map((item) =>
                                item.id === next.id ? next : item,
                              ),
                            }));
                          }}
                          type="button"
                        >
                          {mapped
                            ? `Unmap ${selectedIngredient?.name ?? ""}`
                            : sameComponent
                              ? "Map selected ingredient here"
                              : "Select an ingredient in this component"}
                        </button>
                      </div>
                    </article>
                  );
                })}
              <button
                className="dashed-button"
                onClick={() => {
                  const componentId =
                    selectedIngredient?.componentId ?? draft.components[0]?.id;
                  if (!componentId) return;
                  setDraft((current) => ({
                    ...current,
                    steps: [
                      ...current.steps,
                      {
                        action: "prepare",
                        componentId,
                        equipmentIds: [],
                        id: createClientId(),
                        instruction: "Describe this step.",
                        position: current.steps.length,
                      },
                    ],
                  }));
                }}
                type="button"
              >
                + Add step
              </button>
            </section>
          </EditorDisclosure>
        </div>

        <EditorDisclosure
          detail={`${revisions.length} snapshots`}
          label="History"
          phoneViewport={phoneViewport}
          sectionName="history"
          summaryId="history"
        >
          <section className="history-card">
            <p className="eyebrow">History</p>
            <h2>Revision snapshots</h2>
            {revisions.length === 0 ? (
              <p className="muted">No previous versions yet.</p>
            ) : (
              <ol>
                {revisions.map((revision) => (
                  <li key={revision.id}>
                    <strong>Version {revision.version}</strong> ·{" "}
                    {revision.reason} ·{" "}
                    <time dateTime={revision.createdAt}>
                      {new Date(revision.createdAt).toLocaleString()}
                    </time>
                    <Form className="history-restore-form" method="post">
                      <input
                        name="version"
                        type="hidden"
                        value={recipe.version}
                      />
                      <button
                        className="history-restore-button"
                        name="restoreRevisionVersion"
                        type="submit"
                        value={revision.version}
                      >
                        Restore this content
                      </button>
                    </Form>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </EditorDisclosure>
        <div className="mobile-editor-save" aria-label="Recipe save status">
          <span>{isDirty ? "Unsaved changes" : "All changes saved"}</span>
          <button
            className="primary-button"
            disabled={!isDirty}
            form="recipe-editor-save"
            type="submit"
          >
            Save
          </button>
        </div>
      </main>
    </>
  );
}

function EditorDisclosure({
  children,
  detail,
  label,
  phoneViewport,
  primary = false,
  sectionName,
  summaryId,
}: {
  children: ReactNode;
  detail: string;
  label: string;
  phoneViewport: boolean | null;
  primary?: boolean;
  sectionName: string;
  summaryId?: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (phoneViewport !== null) setOpen(!phoneViewport);
  }, [phoneViewport]);

  return (
    <details
      className={`editor-disclosure${primary ? " editor-disclosure-primary" : ""}`}
      data-editor-section={sectionName}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary className="editor-disclosure-summary" id={summaryId}>
        <span>{label}</span>
        <small>{detail}</small>
      </summary>
      {children}
    </details>
  );
}

function usePhoneViewport(): boolean | null {
  const [phoneViewport, setPhoneViewport] = useState<boolean | null>(null);

  useEffect(() => {
    const phone = window.matchMedia("(max-width: 600px)");
    const handleChange = (event: MediaQueryListEvent) =>
      setPhoneViewport(event.matches);
    setPhoneViewport(phone.matches);
    phone.addEventListener("change", handleChange);
    return () => phone.removeEventListener("change", handleChange);
  }, []);

  return phoneViewport;
}

function IngredientEditorRow({
  ingredient,
  onChange,
  onSelect,
  selected,
}: {
  ingredient: RecipeIngredient;
  onChange: (ingredient: RecipeIngredient) => void;
  onSelect: () => void;
  selected: boolean;
}) {
  const numericQuantity = ingredient.quantity.asWritten ?? {
    from: { denominator: 1, numerator: 1 },
  };
  return (
    <div
      className={`ingredient-editor-row ${selected ? "selected" : ""} ${
        ingredient.stepIds.length === 0 ? "unmapped" : ""
      }`}
    >
      <button
        aria-label={`Select ${ingredient.name}`}
        className="ingredient-select"
        onClick={onSelect}
        type="button"
      >
        {selected ? "●" : "○"}
      </button>
      <div className="ingredient-editor-fields">
        <label>
          Name
          <input
            onChange={(event) =>
              onChange({ ...ingredient, name: event.target.value })
            }
            value={ingredient.name}
          />
        </label>
        <label>
          Quantity type
          <select
            onChange={(event) =>
              onChange({
                ...ingredient,
                quantity:
                  event.target.value === "text"
                    ? {
                        kind: "measure",
                        scaling: "invariant",
                        text: "to taste",
                        unit: "",
                      }
                    : {
                        asWritten: numericQuantity,
                        kind: "measure",
                        scaling: "proportional",
                        unit: ingredient.quantity.unit,
                      },
              })
            }
            value={ingredient.quantity.asWritten ? "numeric" : "text"}
          >
            <option value="numeric">Numeric</option>
            <option value="text">Text only</option>
          </select>
        </label>
        {ingredient.quantity.asWritten ? (
          <div className="numeric-quantity-editor">
            <div className="quantity-fields">
              <label>
                Amount
                <input
                  min="0"
                  onChange={(event) =>
                    onChange({
                      ...ingredient,
                      quantity: {
                        ...ingredient.quantity,
                        asWritten: {
                          ...numericQuantity,
                          from: {
                            ...numericQuantity.from,
                            numerator: Number(event.target.value),
                          },
                        },
                      },
                    })
                  }
                  type="number"
                  value={numericQuantity.from.numerator}
                />
              </label>
              <label>
                ÷
                <input
                  min="1"
                  onChange={(event) =>
                    onChange({
                      ...ingredient,
                      quantity: {
                        ...ingredient.quantity,
                        asWritten: {
                          ...numericQuantity,
                          from: {
                            ...numericQuantity.from,
                            denominator: Number(event.target.value),
                          },
                        },
                      },
                    })
                  }
                  type="number"
                  value={numericQuantity.from.denominator}
                />
              </label>
              <label>
                Unit
                <input
                  onChange={(event) =>
                    onChange({
                      ...ingredient,
                      quantity: {
                        ...ingredient.quantity,
                        unit: event.target.value,
                      },
                    })
                  }
                  value={ingredient.quantity.unit}
                />
              </label>
            </div>
            <div className="quantity-advanced">
              <label>
                Range end
                <input
                  min="0"
                  onChange={(event) => {
                    const value = event.target.value;
                    onChange({
                      ...ingredient,
                      quantity: {
                        ...ingredient.quantity,
                        asWritten: {
                          ...numericQuantity,
                          ...(value
                            ? {
                                to: {
                                  denominator:
                                    numericQuantity.to?.denominator ?? 1,
                                  numerator: Number(value),
                                },
                              }
                            : { to: undefined }),
                        },
                      },
                    });
                  }}
                  placeholder="optional"
                  type="number"
                  value={numericQuantity.to?.numerator ?? ""}
                />
              </label>
              <label>
                Range ÷
                <input
                  disabled={!numericQuantity.to}
                  min="1"
                  onChange={(event) => {
                    if (!numericQuantity.to) return;
                    onChange({
                      ...ingredient,
                      quantity: {
                        ...ingredient.quantity,
                        asWritten: {
                          ...numericQuantity,
                          to: {
                            ...numericQuantity.to,
                            denominator: Number(event.target.value),
                          },
                        },
                      },
                    });
                  }}
                  type="number"
                  value={numericQuantity.to?.denominator ?? 1}
                />
              </label>
              <label>
                Quantity kind
                <select
                  onChange={(event) =>
                    onChange({
                      ...ingredient,
                      quantity: {
                        ...ingredient.quantity,
                        kind: event.target
                          .value as RecipeIngredient["quantity"]["kind"],
                      },
                    })
                  }
                  value={ingredient.quantity.kind}
                >
                  <option value="measure">Measure</option>
                  <option value="count">Count</option>
                  <option value="package">Package</option>
                </select>
              </label>
              <label>
                Scaling behavior
                <select
                  onChange={(event) =>
                    onChange({
                      ...ingredient,
                      quantity: {
                        ...ingredient.quantity,
                        scaling: event.target
                          .value as RecipeIngredient["quantity"]["scaling"],
                      },
                    })
                  }
                  value={ingredient.quantity.scaling}
                >
                  <option value="proportional">Proportional</option>
                  <option value="invariant">Do not scale</option>
                </select>
              </label>
              <label>
                Metric equivalent
                <input
                  min="0"
                  onChange={(event) => {
                    const value = event.target.value;
                    onChange({
                      ...ingredient,
                      quantity: {
                        ...ingredient.quantity,
                        metricEquivalent: value
                          ? {
                              quantity: {
                                from: {
                                  denominator: 1,
                                  numerator: Number(value),
                                },
                              },
                              unit:
                                ingredient.quantity.metricEquivalent?.unit ??
                                "g",
                            }
                          : undefined,
                      },
                    });
                  }}
                  placeholder="optional"
                  type="number"
                  value={
                    ingredient.quantity.metricEquivalent?.quantity.from
                      .numerator ?? ""
                  }
                />
              </label>
              <label>
                Metric unit
                <input
                  disabled={!ingredient.quantity.metricEquivalent}
                  onChange={(event) => {
                    if (!ingredient.quantity.metricEquivalent) return;
                    onChange({
                      ...ingredient,
                      quantity: {
                        ...ingredient.quantity,
                        metricEquivalent: {
                          ...ingredient.quantity.metricEquivalent,
                          unit: event.target.value,
                        },
                      },
                    });
                  }}
                  value={ingredient.quantity.metricEquivalent?.unit ?? ""}
                />
              </label>
            </div>
          </div>
        ) : (
          <label>
            As written
            <input
              onChange={(event) =>
                onChange({
                  ...ingredient,
                  quantity: {
                    ...ingredient.quantity,
                    text: event.target.value,
                  },
                })
              }
              value={ingredient.quantity.text ?? ""}
            />
          </label>
        )}
        <div className="field-pair">
          <label>
            Requirement
            <select
              onChange={(event) =>
                onChange({
                  ...ingredient,
                  requirement: event.target
                    .value as RecipeIngredient["requirement"],
                })
              }
              value={ingredient.requirement}
            >
              <option value="required">Required</option>
              <option value="optional">Optional</option>
              <option value="alternative">Alternative</option>
            </select>
          </label>
          <label>
            Alternative group
            <input
              disabled={ingredient.requirement !== "alternative"}
              onChange={(event) =>
                onChange({
                  ...ingredient,
                  alternativeGroupId: event.target.value || undefined,
                })
              }
              value={ingredient.alternativeGroupId ?? ""}
            />
          </label>
        </div>
        {ingredient.stepIds.length === 0 ? (
          <span className="unmapped-label">⚠ Unmapped</span>
        ) : (
          <span className="mapped-label">
            Mapped to {ingredient.stepIds.length} step(s)
          </span>
        )}
      </div>
    </div>
  );
}

function SubstitutionEditor({
  ingredient,
  onChange,
}: {
  ingredient: RecipeIngredient;
  onChange: (ingredient: RecipeIngredient) => void;
}) {
  return (
    <div className="substitution-card">
      <p className="eyebrow">Substitutions for {ingredient.name}</p>
      {ingredient.substitutions.map((substitution, index) => (
        <div className="field-pair" key={`${substitution.name}-${index}`}>
          <label>
            Substitute
            <input
              onChange={(event) =>
                onChange({
                  ...ingredient,
                  substitutions: ingredient.substitutions.map(
                    (item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, name: event.target.value }
                        : item,
                  ),
                })
              }
              value={substitution.name}
            />
          </label>
          <label>
            Effect on flavor, diet, or technique
            <input
              onChange={(event) =>
                onChange({
                  ...ingredient,
                  substitutions: ingredient.substitutions.map(
                    (item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, note: event.target.value }
                        : item,
                  ),
                })
              }
              value={substitution.note}
            />
          </label>
        </div>
      ))}
      <button
        className="dashed-button"
        onClick={() =>
          onChange({
            ...ingredient,
            substitutions: [
              ...ingredient.substitutions,
              { name: "New substitute", note: "Describe the effect." },
            ],
          })
        }
        type="button"
      >
        + Add substitution
      </button>
    </div>
  );
}

function EquipmentEditor({
  equipment,
  onChange,
}: {
  equipment: RecipeEquipment[];
  onChange: (equipment: RecipeEquipment[]) => void;
}) {
  return (
    <div>
      <h3>Equipment</h3>
      {equipment.map((item) => (
        <div className="metadata-row" key={item.id}>
          <input
            aria-label="Equipment name"
            onChange={(event) =>
              onChange(
                equipment.map((candidate) =>
                  candidate.id === item.id
                    ? { ...candidate, name: event.target.value }
                    : candidate,
                ),
              )
            }
            value={item.name}
          />
          <label className="compact-check">
            <input
              checked={item.required}
              onChange={(event) =>
                onChange(
                  equipment.map((candidate) =>
                    candidate.id === item.id
                      ? { ...candidate, required: event.target.checked }
                      : candidate,
                  ),
                )
              }
              type="checkbox"
            />
            Required
          </label>
        </div>
      ))}
      <button
        className="dashed-button"
        onClick={() =>
          onChange([
            ...equipment,
            { id: createClientId(), name: "New equipment", required: true },
          ])
        }
        type="button"
      >
        + Add equipment
      </button>
    </div>
  );
}

function ClassificationEditor({
  label,
  onChange,
  values,
}: {
  label: string;
  onChange: (values: ConfirmedClassification[]) => void;
  values: ConfirmedClassification[];
}) {
  return (
    <div className="classification-editor">
      <h3>{label}</h3>
      {values.map((item, index) => (
        <div className="metadata-row" key={`${item.name}-${index}`}>
          <input
            aria-label={`${label} name`}
            onChange={(event) =>
              onChange(
                values.map((candidate, itemIndex) =>
                  itemIndex === index
                    ? { ...candidate, name: event.target.value }
                    : candidate,
                ),
              )
            }
            value={item.name}
          />
          <label className="compact-check">
            <input
              checked={item.confirmed}
              onChange={(event) =>
                onChange(
                  values.map((candidate, itemIndex) =>
                    itemIndex === index
                      ? { ...candidate, confirmed: event.target.checked }
                      : candidate,
                  ),
                )
              }
              type="checkbox"
            />
            Confirmed
          </label>
        </div>
      ))}
      <button
        className="dashed-button"
        onClick={() =>
          onChange([...values, { confirmed: false, name: "Needs review" }])
        }
        type="button"
      >
        + Add {label.toLowerCase()}
      </button>
    </div>
  );
}

function updateStep(
  setDraft: React.Dispatch<React.SetStateAction<RecipeDraft>>,
  stepId: string,
  patch: Partial<RecipeDraft["steps"][number]>,
) {
  setDraft((current) => ({
    ...current,
    steps: current.steps.map((step) =>
      step.id === stepId ? { ...step, ...patch } : step,
    ),
  }));
}

function newIngredient(componentId: string): RecipeIngredient {
  return {
    componentId,
    id: createClientId(),
    name: "New ingredient",
    quantity: {
      asWritten: { from: { denominator: 1, numerator: 1 } },
      kind: "measure",
      scaling: "proportional",
      unit: "",
    },
    requirement: "required",
    sourceText: "1 new ingredient",
    stepIds: [],
    substitutions: [],
  };
}

function toDraft(recipe: RecipeAggregate): RecipeDraft {
  return structuredClone({
    allergens: recipe.allergens,
    baseYield: recipe.baseYield,
    components: recipe.components,
    ...(recipe.creatorName ? { creatorName: recipe.creatorName } : {}),
    diets: recipe.diets,
    equipment: recipe.equipment,
    id: recipe.id,
    ingredients: recipe.ingredients,
    ...(recipe.sharedNotes ? { sharedNotes: recipe.sharedNotes } : {}),
    source: recipe.source,
    steps: recipe.steps,
    subRecipes: recipe.subRecipes,
    title: recipe.title,
    ...(recipe.variantOfId ? { variantOfId: recipe.variantOfId } : {}),
    yieldText: recipe.yieldText,
  });
}

function isRecipeDraft(value: unknown): value is RecipeDraft {
  return (
    typeof value === "object" &&
    value !== null &&
    "title" in value &&
    typeof value.title === "string" &&
    "ingredients" in value &&
    Array.isArray(value.ingredients) &&
    "steps" in value &&
    Array.isArray(value.steps)
  );
}

function requiredRecipeId(value: string | undefined): string {
  if (!value) throw new Error("Recipe ID is required");
  return value;
}
