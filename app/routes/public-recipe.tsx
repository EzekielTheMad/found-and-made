import { useState } from "react";

import { appRuntimeContext } from "~/context";
import { systemPrincipal } from "#src/modules/identity/identity.types";
import type { MediaRole } from "#src/modules/media/media.types";

import type { Route } from "./+types/public-recipe";

interface PublicMediaAsset {
  altText: string;
  caption: string;
  componentId?: string;
  id: string;
  position: number;
  role: MediaRole;
  stepId?: string;
}

const PRIVATE_RECIPE_DESCRIPTION =
  "This recipe is private. Sign in to Found & Made to continue.";

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "Not found · Found & Made" }];
  if (loaderData.kind === "private") {
    return [
      { title: "Found & Made · Sign in" },
      { name: "description", content: PRIVATE_RECIPE_DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:title", content: "Found & Made" },
      { property: "og:description", content: PRIVATE_RECIPE_DESCRIPTION },
      { property: "og:url", content: loaderData.canonicalUrl },
      { property: "og:image", content: loaderData.socialCardUrl },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: loaderData.socialCardUrl },
      { tagName: "link", rel: "canonical", href: loaderData.canonicalUrl },
    ];
  }
  return [
    { title: `${loaderData.recipe.title} · Found & Made` },
    { name: "description", content: loaderData.recipe.yieldText },
    { property: "og:type", content: "article" },
    { property: "og:title", content: loaderData.recipe.title },
    { property: "og:description", content: loaderData.recipe.yieldText },
    { property: "og:url", content: loaderData.canonicalUrl },
    { name: "twitter:card", content: "summary_large_image" },
    ...(loaderData.heroUrl
      ? [
          { property: "og:image", content: loaderData.heroUrl },
          { name: "twitter:image", content: loaderData.heroUrl },
        ]
      : []),
    { tagName: "link", rel: "canonical", href: loaderData.canonicalUrl },
  ];
}

export function loader({ context, params }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  const recipeId = String(params.recipeId ?? "");
  const canonicalUrl = runtime.publicUrl(`/public/recipes/${recipeId}`);
  const recipe = runtime.publishingService.getPublicRecipe(recipeId);
  if (!recipe) {
    return {
      canonicalUrl,
      kind: "private" as const,
      socialCardUrl: runtime.publicUrl("/public/assets/social-card.webp"),
    };
  }
  const assets: PublicMediaAsset[] = runtime.mediaService
    .list(systemPrincipal, recipe.id)
    .map((asset) => ({
      altText: asset.altText,
      caption: asset.caption,
      ...(asset.componentId ? { componentId: asset.componentId } : {}),
      id: asset.id,
      position: asset.position,
      role: asset.role,
      ...(asset.stepId ? { stepId: asset.stepId } : {}),
    }));
  const hero = assets.find((asset) => asset.role === "hero");
  return {
    assets,
    canonicalUrl,
    hero,
    heroUrl: runtime.publicUrl(
      hero
        ? `/public/media/${hero.id}/social`
        : "/public/assets/social-card.webp",
    ),
    kind: "public" as const,
    recipe,
  };
}

export default function PublicRecipe({ loaderData }: Route.ComponentProps) {
  if (loaderData.kind === "private") {
    return (
      <main className="centered-shell">
        <section className="auth-card">
          <p className="eyebrow">Found &amp; Made</p>
          <h1>This recipe is private</h1>
          <p className="lede">
            Sign in to Found &amp; Made to view recipes available to your
            account.
          </p>
          <div className="button-row">
            <a className="button-link" href="/sign-in">
              Sign in
            </a>
            <a className="secondary-button-link" href="/">
              Visit cookbook
            </a>
          </div>
        </section>
      </main>
    );
  }
  const { recipe } = loaderData;
  const recipeJsonLd = {
    "@context": "https://schema.org",
    "@type": "Recipe",
    ...(recipe.creatorName
      ? { author: { "@type": "Person", name: recipe.creatorName } }
      : {}),
    name: recipe.title,
    recipeIngredient: recipe.ingredients.map((item) => item.text),
    recipeInstructions: recipe.steps.map((step) => ({
      "@type": "HowToStep",
      text: step.instruction,
    })),
    recipeYield: recipe.yieldText,
    image: [loaderData.heroUrl],
  };
  return (
    <>
      <main className="recipe-shell">
        <article>
          <script
            dangerouslySetInnerHTML={{
              __html: JSON.stringify(recipeJsonLd).replaceAll("<", "\\u003c"),
            }}
            type="application/ld+json"
          />
          {loaderData.hero ? (
            <img
              alt={loaderData.hero.altText}
              className="recipe-hero"
              src={`/public/media/${loaderData.hero.id}/web`}
            />
          ) : null}
          {loaderData.assets.some((asset) => asset.role === "gallery") ? (
            <section className="media-gallery" aria-label="Recipe gallery">
              {loaderData.assets
                .filter((asset) => asset.role === "gallery")
                .map((asset) => (
                  <PublicPhoto asset={asset} key={asset.id} />
                ))}
            </section>
          ) : null}
          <p className="eyebrow">Published recipe</p>
          <h1>{recipe.title}</h1>
          {recipe.creatorName ? (
            <p className="recipe-meta">Recipe by {recipe.creatorName}</p>
          ) : null}
          <p className="lede">{recipe.yieldText}</p>
          <ShareControls canonicalUrl={loaderData.canonicalUrl} />
          {recipe.components.map((component) => (
            <section key={component.id}>
              <h2>{component.name}</h2>
              {loaderData.assets
                .filter(
                  (asset) =>
                    asset.role === "component" &&
                    asset.componentId === component.id,
                )
                .map((asset) => (
                  <PublicPhoto asset={asset} key={asset.id} />
                ))}
              <ul>
                {recipe.ingredients
                  .filter((item) => item.componentId === component.id)
                  .map((item) => (
                    <li key={item.id}>{item.text}</li>
                  ))}
              </ul>
              <ol>
                {recipe.steps
                  .filter((step) => step.componentId === component.id)
                  .map((step) => (
                    <li key={step.id}>
                      <p>{step.instruction}</p>
                      {loaderData.assets
                        .filter(
                          (asset) =>
                            asset.role === "step" && asset.stepId === step.id,
                        )
                        .map((asset) => (
                          <PublicPhoto asset={asset} key={asset.id} />
                        ))}
                    </li>
                  ))}
              </ol>
            </section>
          ))}
        </article>
      </main>
    </>
  );
}

function PublicPhoto({ asset }: { asset: PublicMediaAsset }) {
  return (
    <figure className="recipe-inline-photo">
      <img alt={asset.altText} src={`/public/media/${asset.id}/web`} />
      {asset.caption ? <figcaption>{asset.caption}</figcaption> : null}
    </figure>
  );
}

function ShareControls({ canonicalUrl }: { canonicalUrl: string }) {
  const [status, setStatus] = useState("");
  async function share() {
    if (navigator.share) {
      await navigator.share({ title: document.title, url: canonicalUrl });
      return;
    }
    await navigator.clipboard.writeText(canonicalUrl);
    setStatus("Link copied");
  }
  return (
    <div className="share-controls">
      <button onClick={() => void share()} type="button">
        Share recipe
      </button>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(canonicalUrl).then(() => {
            setStatus("Link copied");
          });
        }}
        type="button"
      >
        Copy link
      </button>
      <span aria-live="polite">{status}</span>
    </div>
  );
}
