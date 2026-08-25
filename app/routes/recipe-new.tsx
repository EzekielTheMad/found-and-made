import { Form, redirect } from "react-router";

import { appRuntimeContext } from "~/context";
import { createClientId } from "~/client-id";
import {
  RECIPE_CREATOR_MAX_LENGTH,
  RECIPE_SOURCE_URL_MAX_LENGTH,
  RECIPE_TITLE_MAX_LENGTH,
  RECIPE_YIELD_MAX_LENGTH,
} from "#src/modules/recipes/recipe-metadata";
import type { RecipeDraft } from "#src/modules/recipes/recipe.types";

import type { Route } from "./+types/recipe-new";

export function meta() {
  return [{ title: "New recipe · Found & Made" }];
}

export async function action({ context, request }: Route.ActionArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const form = await request.formData();
  const title = requiredText(form, "title");
  const yieldText = requiredText(form, "yieldText");
  const baseYield = Number(form.get("baseYield"));
  const sourceUrl = optionalText(form, "sourceUrl");
  const creatorName = optionalText(form, "creatorName");
  const componentId = createClientId();
  const ingredientId = createClientId();
  const stepId = createClientId();
  const draft: RecipeDraft = {
    allergens: [],
    baseYield,
    components: [{ id: componentId, name: "Main", position: 0 }],
    ...(creatorName ? { creatorName } : {}),
    diets: [],
    equipment: [],
    ingredients: [
      {
        componentId,
        id: ingredientId,
        name: "New ingredient",
        quantity: {
          asWritten: { from: { denominator: 1, numerator: 1 } },
          kind: "measure",
          scaling: "proportional",
          unit: "",
        },
        requirement: "required",
        sourceText: "1 new ingredient",
        stepIds: [stepId],
        substitutions: [],
      },
    ],
    source: sourceUrl ? { originalUrl: sourceUrl } : {},
    steps: [
      {
        action: "prepare",
        componentId,
        equipmentIds: [],
        id: stepId,
        instruction: "Describe this step.",
        position: 0,
      },
    ],
    subRecipes: [],
    title,
    yieldText,
  };
  const recipe = runtime.recipeAccessService.create(principal, draft);
  return redirect(`/recipes/${recipe.id}/edit`);
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  runtime.identityService.policy.require(principal, "recipe:create");
  return null;
}

export default function NewRecipe() {
  return (
    <>
      <main className="narrow-shell">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <a href="/">Library</a>
          <span aria-hidden="true">/</span>
          <span>Add recipe</span>
        </nav>
        <section className="form-card" aria-labelledby="new-recipe-title">
          <p className="eyebrow">Manual entry</p>
          <h1 id="new-recipe-title">Start a recipe</h1>
          <p className="lede">
            Begin with its authored yield. You can build components,
            ingredients, mappings, and steps next.
          </p>
          <Form className="stacked-form" method="post">
            <label>
              Recipe title
              <input
                autoFocus
                maxLength={RECIPE_TITLE_MAX_LENGTH}
                name="title"
                required
              />
            </label>
            <div className="field-pair">
              <label>
                Base servings
                <input
                  inputMode="decimal"
                  min="0.1"
                  name="baseYield"
                  required
                  step="0.1"
                  type="number"
                  defaultValue="4"
                />
              </label>
              <label>
                Descriptive yield
                <input
                  defaultValue="Serves 4"
                  maxLength={RECIPE_YIELD_MAX_LENGTH}
                  name="yieldText"
                  required
                />
              </label>
            </div>
            <label>
              Recipe creator <span className="label-note">optional</span>
              <input
                maxLength={RECIPE_CREATOR_MAX_LENGTH}
                name="creatorName"
                placeholder="A friend, relative, chef, or publication"
              />
            </label>
            <label>
              Source URL <span className="label-note">optional</span>
              <input
                maxLength={RECIPE_SOURCE_URL_MAX_LENGTH}
                name="sourceUrl"
                type="url"
                placeholder="https://example.com/recipe"
              />
            </label>
            <button className="primary-button" type="submit">
              Create private draft
            </button>
          </Form>
        </section>
      </main>
    </>
  );
}

function requiredText(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required`);
  return value.trim();
}

function optionalText(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
