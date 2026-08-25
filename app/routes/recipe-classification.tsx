import { data, Form, redirect } from "react-router";

import { publicActionFailure } from "~/action-error";
import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/recipe-classification";

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    {
      title: `Classify ${loaderData?.recipe.title ?? "recipe"} · Found & Made`,
    },
  ];
}

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  runtime.identityService.policy.require(principal, "recipe:edit");
  const recipeId = requiredId(params.recipeId);
  const categoryGroup = runtime.discoveryService
    .facetGroups(principal)
    .find((group) => group.slug === "recipe-type");
  return {
    classification: runtime.discoveryService.recipeClassification(
      principal,
      recipeId,
    ),
    recipe: runtime.recipeAccessService.get(principal, recipeId),
    categories: categoryGroup
      ? runtime.discoveryService.terms(principal, categoryGroup.id)
      : [],
  };
}

export async function action({ context, params, request }: Route.ActionArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const recipeId = requiredId(params.recipeId);
  const form = await request.formData();
  try {
    runtime.discoveryService.assignTerms(
      principal,
      recipeId,
      form
        .getAll("termIds")
        .filter((value): value is string => typeof value === "string"),
    );
    runtime.discoveryService.assignLabels(
      principal,
      recipeId,
      commaList(field(form, "labels")),
    );
    return redirect(`/recipes/${recipeId}`);
  } catch (error) {
    const failure = publicActionFailure(error, "Classification failed");
    return data(
      { error: failure.message, requestId: failure.requestId },
      { status: 400 },
    );
  }
}

export default function RecipeClassification({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  return (
    <>
      <main className="page-shell">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <a href={`/recipes/${loaderData.recipe.id}`}>Recipe</a>
          <span aria-hidden="true">/</span>
          <span>Classification</span>
        </nav>
        <p className="eyebrow">Categories and labels</p>
        <h1>Organize {loaderData.recipe.title}</h1>
        {actionData?.error ? <p role="alert">{actionData.error}</p> : null}
        <Form className="stacked-form form-card" method="post">
          <fieldset>
            <legend>Categories</legend>
            <p className="recipe-meta">
              Choose the broad recipe types that apply.
            </p>
            {loaderData.categories.map((category) => (
              <label key={category.id}>
                <input
                  defaultChecked={loaderData.classification.termIds.includes(
                    category.id,
                  )}
                  name="termIds"
                  type="checkbox"
                  value={category.id}
                />{" "}
                {category.name}
              </label>
            ))}
          </fieldset>
          <label>
            Labels <span>(comma separated)</span>
            <input
              aria-describedby="labels-help"
              defaultValue={loaderData.classification.labelNames.join(", ")}
              name="labels"
            />
          </label>
          <p className="recipe-meta" id="labels-help">
            Add household-specific details such as family favorite or freezer
            friendly.
          </p>
          <button className="primary-button" type="submit">
            Save categories and labels
          </button>
        </Form>
      </main>
    </>
  );
}

function requiredId(value: string | undefined): string {
  if (!value) throw new Error("Recipe ID is required");
  return value;
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function commaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
