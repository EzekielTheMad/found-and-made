import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/public-collection";

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "Not found · Found & Made" }];
  return [
    { title: `${loaderData.collection.title} · Found & Made` },
    {
      name: "description",
      content:
        loaderData.collection.description ||
        `${loaderData.collection.recipes.length} published recipes`,
    },
    { property: "og:type", content: "website" },
    { property: "og:title", content: loaderData.collection.title },
    {
      property: "og:description",
      content:
        loaderData.collection.description ||
        `${loaderData.collection.recipes.length} published recipes`,
    },
    { property: "og:url", content: loaderData.canonicalUrl },
    { tagName: "link", rel: "canonical", href: loaderData.canonicalUrl },
  ];
}

export function loader({ context, params }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  const collection = runtime.publishingService.getPublicCollection(
    String(params.collectionId ?? ""),
  );
  // React Router uses thrown Responses to select the route error boundary.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  if (!collection) throw new Response("Not found", { status: 404 });
  return {
    canonicalUrl: runtime.publicUrl(`/public/collections/${collection.id}`),
    collection,
  };
}

export default function PublicCollection({ loaderData }: Route.ComponentProps) {
  const { collection } = loaderData;
  return (
    <main className="page-shell public-collection-shell">
      <header className="public-collection-heading">
        <p className="eyebrow">Published collection</p>
        <h1>{collection.title}</h1>
        {collection.description ? (
          <p className="lede">{collection.description}</p>
        ) : null}
        <p className="recipe-meta">
          {collection.recipes.length} published recipe
          {collection.recipes.length === 1 ? "" : "s"}
        </p>
      </header>
      {collection.recipes.length ? (
        <section
          aria-label={`${collection.title} recipes`}
          className="public-collection-grid"
        >
          {collection.recipes.map((recipe) => (
            <article className="public-collection-card" key={recipe.id}>
              <p className="eyebrow">Recipe</p>
              <h2>
                <a href={`/public/recipes/${recipe.id}`}>{recipe.title}</a>
              </h2>
              <p>{recipe.yieldText}</p>
            </article>
          ))}
        </section>
      ) : (
        <section className="empty-card">
          <h2>No published recipes yet</h2>
          <p>Recipes appear here only after the Owner publishes each one.</p>
        </section>
      )}
    </main>
  );
}
