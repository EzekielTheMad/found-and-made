import { data, Form, redirect } from "react-router";

import { publicActionFailure } from "~/action-error";
import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/recipe-media";

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    {
      title: `Photos for ${loaderData?.recipe.title ?? "recipe"} · Found & Made`,
    },
  ];
}

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  runtime.identityService.policy.require(principal, "recipe:edit");
  const recipeId = requiredId(params.recipeId);
  return {
    assets: runtime.mediaService.list(principal, recipeId),
    recipe: runtime.recipeAccessService.get(principal, recipeId),
  };
}

export async function action({ context, params, request }: Route.ActionArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const recipeId = requiredId(params.recipeId);
  const boundedForm =
    await import("#src/platform/files/bounded-form-data.server");
  try {
    const form = await boundedForm.parseBoundedFormData(request, {
      maxBodyBytes: 21 * 1024 * 1024,
      maxFieldBytes: 64 * 1024,
      maxFields: 8,
      maxFileBytes: 20 * 1024 * 1024,
      maxFiles: 1,
      maxParts: 9,
    });
    const intent = text(form, "intent") || "upload";
    if (intent === "update") {
      await runtime.mediaService.update(principal, text(form, "mediaId"), {
        altText: text(form, "altText"),
        caption: text(form, "caption"),
        focalX: integer(form, "focalX"),
        focalY: integer(form, "focalY"),
        position: integer(form, "position"),
      });
      return redirect(`/recipes/${recipeId}/media`);
    }
    if (intent === "remove") {
      await runtime.mediaService.remove(principal, text(form, "mediaId"));
      return redirect(`/recipes/${recipeId}/media`);
    }

    const image = form.get("image");
    const role = form.get("role");
    if (!(image instanceof File) || image.size === 0) {
      return data({ error: "Choose an image" }, { status: 400 });
    }
    if (
      role !== "hero" &&
      role !== "gallery" &&
      role !== "component" &&
      role !== "step"
    ) {
      return data({ error: "Choose an image role" }, { status: 400 });
    }
    await runtime.mediaService.upload(principal, {
      altText: text(form, "altText"),
      bytes: new Uint8Array(await image.arrayBuffer()),
      caption: text(form, "caption"),
      ...(text(form, "componentId")
        ? { componentId: text(form, "componentId") }
        : {}),
      recipeId,
      role,
      ...(text(form, "stepId") ? { stepId: text(form, "stepId") } : {}),
    });
    return redirect(`/recipes/${params.recipeId}/media`);
  } catch (error) {
    if (error instanceof boundedForm.BoundedFormDataError) {
      return data({ error: error.message }, { status: error.status });
    }
    const failure = publicActionFailure(error, "Upload failed");
    return data(
      { error: failure.message, requestId: failure.requestId },
      { status: 400 },
    );
  }
}

export default function RecipeMedia({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  return (
    <>
      <main className="page-shell">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <a href={`/recipes/${loaderData.recipe.id}`}>Recipe</a>
          <span aria-hidden="true">/</span>
          <span>Photos</span>
        </nav>
        <div className="page-heading">
          <div>
            <p className="eyebrow">Sanitized media</p>
            <h1>Photos for {loaderData.recipe.title}</h1>
          </div>
        </div>
        {actionData?.error ? <p role="alert">{actionData.error}</p> : null}
        <section className="form-card" aria-labelledby="upload-title">
          <h2 id="upload-title">Add a photo</h2>
          <Form
            className="stacked-form"
            encType="multipart/form-data"
            method="post"
          >
            <label>
              Image
              <input
                accept="image/jpeg,image/png,image/webp"
                name="image"
                required
                type="file"
              />
            </label>
            <label>
              Placement
              <select name="role">
                <option value="hero">Hero</option>
                <option value="gallery">Gallery</option>
                <option value="component">Component</option>
                <option value="step">Step</option>
              </select>
            </label>
            <label>
              Component
              <select name="componentId">
                <option value="">Not attached</option>
                {loaderData.recipe.components.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Step
              <select name="stepId">
                <option value="">Not attached</option>
                {loaderData.recipe.steps.map((item, index) => (
                  <option key={item.id} value={item.id}>
                    Step {index + 1}: {item.instruction}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Alt text
              <input maxLength={300} name="altText" required />
            </label>
            <label>
              Caption
              <input name="caption" />
            </label>
            <button className="primary-button" type="submit">
              Upload and sanitize
            </button>
          </Form>
        </section>
        <section className="media-gallery" aria-label="Recipe photos">
          {loaderData.assets.map((asset) => (
            <figure className="media-card" key={asset.id}>
              <img alt={asset.altText} src={`/api/media/${asset.id}/web`} />
              <figcaption>
                <strong>{asset.role}</strong>
                {asset.caption ? ` · ${asset.caption}` : ""}
              </figcaption>
              <Form className="stacked-form media-controls" method="post">
                <input name="mediaId" type="hidden" value={asset.id} />
                <label>
                  Alt text
                  <input
                    defaultValue={asset.altText}
                    maxLength={300}
                    name="altText"
                    required
                  />
                </label>
                <label>
                  Caption
                  <input defaultValue={asset.caption} name="caption" />
                </label>
                <label>
                  Order
                  <input
                    defaultValue={asset.position}
                    min={0}
                    name="position"
                    step={1}
                    type="number"
                  />
                </label>
                <label>
                  Horizontal focal point ({asset.focalX}%)
                  <input
                    defaultValue={asset.focalX}
                    max={100}
                    min={0}
                    name="focalX"
                    step={1}
                    type="range"
                  />
                </label>
                <label>
                  Vertical focal point ({asset.focalY}%)
                  <input
                    defaultValue={asset.focalY}
                    max={100}
                    min={0}
                    name="focalY"
                    step={1}
                    type="range"
                  />
                </label>
                <div className="form-actions">
                  <button
                    className="secondary-button"
                    name="intent"
                    type="submit"
                    value="update"
                  >
                    Save photo details
                  </button>
                  <button
                    className="danger-button"
                    name="intent"
                    onClick={(event) => {
                      if (!confirm("Remove this photo and its derivatives?")) {
                        event.preventDefault();
                      }
                    }}
                    type="submit"
                    value="remove"
                  >
                    Remove photo
                  </button>
                </div>
              </Form>
            </figure>
          ))}
        </section>
      </main>
    </>
  );
}

function requiredId(value: string | undefined): string {
  if (!value) throw new Error("Recipe ID is required");
  return value;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function integer(form: FormData, name: string): number {
  const value = Number(text(form, name));
  return Number.isInteger(value) ? value : Number.NaN;
}
