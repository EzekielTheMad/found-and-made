import { Form, redirect } from "react-router";

import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/recipe-trash";

export function meta() {
  return [{ title: "Recycle bin · Found & Made" }];
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  return {
    recipes: runtime.recipeAccessService
      .list(principal, true)
      .filter((recipe) => recipe.deletedAt),
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const form = await request.formData();
  const recipeId = form.get("recipeId");
  if (typeof recipeId !== "string") throw new Error("Recipe ID is required");
  runtime.recipeAccessService.restore(
    principal,
    recipeId,
    Number(form.get("version")),
  );
  return redirect(`/recipes/${recipeId}`);
}

export default function RecipeTrash({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <main className="page-shell">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Recoverable deletion</p>
            <h1>Recycle bin</h1>
          </div>
        </div>
        {loaderData.recipes.length === 0 ? (
          <section className="empty-card">
            <h2>Nothing to restore.</h2>
            <p className="muted">
              Recipes moved here remain recoverable until a later permanent
              deletion policy is explicitly implemented.
            </p>
          </section>
        ) : (
          <section className="trash-list" aria-label="Deleted recipes">
            {loaderData.recipes.map((recipe) => (
              <article className="trash-card" key={recipe.id}>
                <div>
                  <h2>{recipe.title}</h2>
                  <p className="recipe-meta">
                    Deleted{" "}
                    {recipe.deletedAt
                      ? new Date(recipe.deletedAt).toLocaleString()
                      : "Unknown time"}{" "}
                    · version {recipe.version}
                  </p>
                </div>
                <Form method="post">
                  <input name="recipeId" type="hidden" value={recipe.id} />
                  <input name="version" type="hidden" value={recipe.version} />
                  <button className="primary-button" type="submit">
                    Restore recipe
                  </button>
                </Form>
              </article>
            ))}
          </section>
        )}
      </main>
    </>
  );
}
