import { data, Form, redirect } from "react-router";

import { publicActionFailure } from "~/action-error";
import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/taxonomy";

export function meta() {
  return [{ title: "Categories and labels · Found & Made" }];
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  runtime.identityService.policy.require(principal, "instance:manage");
  const groups = runtime.discoveryService.facetGroups(principal);
  const categoryGroup = groups.find((group) => group.slug === "recipe-type");
  return {
    categories: categoryGroup
      ? runtime.discoveryService.terms(principal, categoryGroup.id)
      : [],
    collections: runtime.discoveryService
      .collections(principal)
      .map((item) => ({
        ...runtime.discoveryService.collection(principal, item.id),
        publicUrl: runtime.publicUrl(`/public/collections/${item.id}`),
        published:
          runtime.publishingService.collectionStatus(item.id) === "published",
      })),
    labels: runtime.discoveryService.labels(principal),
    recipes: runtime.recipeAccessService.list(principal),
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const form = await request.formData();
  try {
    switch (field(form, "intent")) {
      case "create-category": {
        const categoryGroupId =
          runtime.discoveryService
            .facetGroups(principal)
            .find((group) => group.slug === "recipe-type")?.id ??
          runtime.discoveryService.createFacetGroup(principal, {
            name: "Recipe category",
            slug: "recipe-type",
          });
        runtime.discoveryService.createFacetTerm(principal, {
          aliases: commaList(field(form, "aliases")),
          groupId: categoryGroupId,
          name: field(form, "name"),
        });
        break;
      }
      case "create-collection":
        runtime.discoveryService.createCollection(principal, {
          description: field(form, "description"),
          title: field(form, "title"),
        });
        break;
      case "assign-collection":
        runtime.discoveryService.assignCollectionRecipes(
          principal,
          field(form, "collectionId"),
          form
            .getAll("recipeIds")
            .filter((value): value is string => typeof value === "string"),
        );
        break;
      case "publish-collection":
        runtime.publishingService.setCollectionPublished(
          principal,
          field(form, "collectionId"),
          true,
        );
        break;
      case "unpublish-collection":
        runtime.publishingService.setCollectionPublished(
          principal,
          field(form, "collectionId"),
          false,
        );
        break;
      default:
        return data({ error: "Unknown taxonomy action" }, { status: 400 });
    }
    return redirect("/taxonomy");
  } catch (error) {
    const failure = publicActionFailure(error, "Taxonomy update failed");
    return data(
      { error: failure.message, requestId: failure.requestId },
      { status: 400 },
    );
  }
}

export default function Taxonomy({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  return (
    <>
      <main className="page-shell">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Owner configuration</p>
            <h1>Categories and labels</h1>
            <p className="lede">
              Keep meal categories consistent, then use labels for the details
              that matter to your household.
            </p>
          </div>
        </div>
        {actionData?.error ? <p role="alert">{actionData.error}</p> : null}
        <div className="admin-grid">
          <section className="form-card taxonomy-card">
            <p className="eyebrow">Controlled vocabulary</p>
            <h2>Categories</h2>
            <p>
              Categories are broad recipe types such as Breakfast, Dinner,
              Dessert, or Cocktail. Imports reuse these names instead of
              creating near-duplicates.
            </p>
            <Form className="stacked-form" method="post">
              <input name="intent" type="hidden" value="create-category" />
              <label>
                Category name
                <input name="name" placeholder="Brunch" required />
              </label>
              <label>
                Also recognize <span>(optional, comma separated)</span>
                <input
                  name="aliases"
                  placeholder="mid-morning, late breakfast"
                />
              </label>
              <button className="primary-button" type="submit">
                Add category
              </button>
            </Form>
            <ul className="taxonomy-chip-list">
              {loaderData.categories.map((term) => (
                <li key={term.id}>
                  <strong>{term.name}</strong>
                  {term.aliases.length ? ` (${term.aliases.join(", ")})` : ""}
                </li>
              ))}
            </ul>
          </section>
          <section className="form-card taxonomy-card">
            <p className="eyebrow">Flexible details</p>
            <h2>Labels</h2>
            <p>
              Labels are custom and personal, such as family favorite, freezer
              friendly, or Victor's pick. Add them while editing a recipe or in
              bulk from the library.
            </p>
            <ul className="taxonomy-chip-list">
              {loaderData.labels.map((label) => (
                <li key={label.id}>
                  {label.name} · {label.recipeCount} recipe(s)
                </li>
              ))}
            </ul>
            {loaderData.labels.length === 0 ? (
              <p className="recipe-meta">No custom labels yet.</p>
            ) : null}
          </section>
          <section className="form-card taxonomy-collections-card">
            <h2>Collections</h2>
            <Form className="stacked-form" method="post">
              <input name="intent" type="hidden" value="create-collection" />
              <label>
                Collection title
                <input name="title" required />
              </label>
              <label>
                Description
                <textarea name="description" />
              </label>
              <button className="primary-button" type="submit">
                Create collection
              </button>
            </Form>
            {loaderData.collections.map((collection) => (
              <article className="collection-editor" key={collection.id}>
                <div className="collection-editor-heading">
                  <div>
                    <h3>{collection.title}</h3>
                    <p>{collection.description}</p>
                    <p className="recipe-meta">
                      {collection.published ? "Published" : "Private"}
                    </p>
                  </div>
                  <Form method="post">
                    <input
                      name="intent"
                      type="hidden"
                      value={
                        collection.published
                          ? "unpublish-collection"
                          : "publish-collection"
                      }
                    />
                    <input
                      name="collectionId"
                      type="hidden"
                      value={collection.id}
                    />
                    <button
                      className={
                        collection.published ? undefined : "primary-button"
                      }
                      type="submit"
                    >
                      {collection.published
                        ? "Make collection private"
                        : "Publish collection"}
                    </button>
                  </Form>
                </div>
                {collection.published ? (
                  <p className="collection-public-link">
                    <a href={collection.publicUrl}>View public collection</a>
                    <span>{collection.publicUrl}</span>
                  </p>
                ) : null}
                <Form method="post">
                  <input
                    name="intent"
                    type="hidden"
                    value="assign-collection"
                  />
                  <input
                    name="collectionId"
                    type="hidden"
                    value={collection.id}
                  />
                  <fieldset>
                    <legend>Recipes in this collection</legend>
                    {loaderData.recipes.map((recipe) => (
                      <label key={recipe.id}>
                        <input
                          defaultChecked={collection.recipeIds.includes(
                            recipe.id,
                          )}
                          name="recipeIds"
                          type="checkbox"
                          value={recipe.id}
                        />{" "}
                        {recipe.title}
                      </label>
                    ))}
                  </fieldset>
                  <button type="submit">Save collection recipes</button>
                </Form>
              </article>
            ))}
          </section>
        </div>
      </main>
    </>
  );
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
