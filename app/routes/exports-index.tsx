import { useState } from "react";
import { data, Form } from "react-router";

import type {
  LibraryExportResult,
  LibraryExportVerification,
} from "#src/modules/exports/export.types";
import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/exports-index";

export function meta() {
  return [{ title: "Exports · Found & Made" }];
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  return {
    isOwner: principal.role === "owner",
    recipes: runtime.recipeAccessService.list(principal),
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const form = await request.formData();
  try {
    const intent = field(form, "intent");
    if (intent === "generate-library") {
      const result = await runtime.exportService.exportLibrary(principal);
      return data({
        library: libraryResultView(result),
        message: "Library export created.",
      });
    }
    if (intent === "verify-library") {
      const artifactName = required(
        field(form, "artifactName"),
        "Artifact name",
      );
      const manifestSha256 = required(
        field(form, "manifestSha256"),
        "Manifest checksum",
      );
      const verification = await runtime.exportService.verifyLibraryExport(
        principal,
        artifactName,
        manifestSha256,
      );
      return data({
        message: verification.valid
          ? "Export integrity verified."
          : "Export verification found a problem.",
        verification: verificationView(verification),
      });
    }
    return data({ error: "Unknown export action" }, { status: 400 });
  } catch {
    return data({ error: "Export action failed" }, { status: 400 });
  }
}

export default function ExportsIndex({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const library =
    actionData && "library" in actionData ? actionData.library : undefined;
  const verification =
    actionData && "verification" in actionData
      ? actionData.verification
      : undefined;
  return (
    <>
      <main className="page-shell narrow-shell">
        <p className="eyebrow">Portable data</p>
        <h1>Export recipes</h1>
        <p className="lede">
          Recipe downloads use the same authorized, scaled projections shown
          while cooking. Export files never expose database or media storage
          paths.
        </p>
        {actionData && "error" in actionData && actionData.error ? (
          <p role="alert">{actionData.error}</p>
        ) : null}
        {actionData && "message" in actionData && actionData.message ? (
          <p role="status">{actionData.message}</p>
        ) : null}

        <section
          className="form-card export-builder"
          aria-labelledby="recipe-export-title"
        >
          <p className="eyebrow">Build a download</p>
          <h2 id="recipe-export-title">Choose recipes</h2>
          <p>
            Select any number of recipes, then choose what the portable JSON
            download should contain.
          </p>
          {loaderData.recipes.length === 0 ? (
            <p>No recipes are available to export.</p>
          ) : (
            <Form action="/exports/selection.json" method="post" reloadDocument>
              <div className="export-selection-heading">
                <strong>{selected.size} selected</strong>
                <button
                  onClick={() =>
                    setSelected(
                      selected.size === loaderData.recipes.length
                        ? new Set()
                        : new Set(
                            loaderData.recipes.map((recipe) => recipe.id),
                          ),
                    )
                  }
                  type="button"
                >
                  {selected.size === loaderData.recipes.length
                    ? "Clear selection"
                    : "Select all"}
                </button>
              </div>
              <fieldset className="export-recipe-picker">
                <legend className="sr-only">Recipes to export</legend>
                {loaderData.recipes.map((recipe) => (
                  <label key={recipe.id}>
                    <input
                      checked={selected.has(recipe.id)}
                      name="recipeIds"
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setSelected((current) => {
                          const next = new Set(current);
                          if (checked) next.add(recipe.id);
                          else next.delete(recipe.id);
                          return next;
                        });
                      }}
                      type="checkbox"
                      value={recipe.id}
                    />
                    <span>
                      <strong>{recipe.title}</strong>
                      <small>{recipe.yieldText}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
              <fieldset className="export-options">
                <legend>Include in the download</legend>
                <label>
                  <input defaultChecked name="includeSource" type="checkbox" />
                  Source and recipe creator
                </label>
                <label>
                  <input
                    defaultChecked
                    name="includeClassifications"
                    type="checkbox"
                  />
                  Diet and allergen classifications
                </label>
                <label>
                  <input name="includePhotoReferences" type="checkbox" />
                  Photo metadata and references
                </label>
                <label>
                  Units
                  <select name="unitPreference">
                    <option value="as-written">As written</option>
                    <option value="metric">Metric</option>
                  </select>
                </label>
              </fieldset>
              <button
                className="primary-button"
                disabled={selected.size === 0}
                type="submit"
              >
                Download {selected.size || "selected"} recipe
                {selected.size === 1 ? "" : "s"}
              </button>
            </Form>
          )}
        </section>

        {loaderData.isOwner ? (
          <section className="form-card" aria-labelledby="library-export-title">
            <h2 id="library-export-title">Complete library and media</h2>
            <p>
              Owner-only. Creates a checksummed artifact under the configured
              data root without mounting that directory on the web.
            </p>
            <Form method="post">
              <input name="intent" type="hidden" value="generate-library" />
              <button className="primary-button" type="submit">
                Generate complete export
              </button>
            </Form>
            {library ? (
              <div role="status">
                <dl>
                  <dt>Artifact</dt>
                  <dd>{library.artifactName}</dd>
                  <dt>Files</dt>
                  <dd>{library.fileCount}</dd>
                  <dt>Manifest checksum</dt>
                  <dd>{library.manifestSha256}</dd>
                </dl>
                <Form method="post">
                  <input name="intent" type="hidden" value="verify-library" />
                  <input
                    name="artifactName"
                    type="hidden"
                    value={library.artifactName}
                  />
                  <input
                    name="manifestSha256"
                    type="hidden"
                    value={library.manifestSha256}
                  />
                  <button type="submit">Verify integrity</button>
                </Form>
              </div>
            ) : null}
            {verification ? (
              <div role={verification.valid ? "status" : "alert"}>
                <p>
                  {verification.valid
                    ? `${verification.filesVerified} files verified.`
                    : "Integrity verification failed."}
                </p>
                {verification.errorCount ? (
                  <p>{verification.errorCount} integrity issue(s) found.</p>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : (
          <section className="form-card" aria-labelledby="owner-export-title">
            <h2 id="owner-export-title">Complete library export</h2>
            <p>
              Only the Owner can export the complete library and media archive.
            </p>
          </section>
        )}
      </main>
    </>
  );
}

export function libraryResultView(result: LibraryExportResult) {
  return {
    artifactName: result.artifactName,
    fileCount: result.fileCount,
    manifestSha256: result.manifest.sha256,
  };
}

function verificationView(result: LibraryExportVerification) {
  return {
    errorCount: result.errors.length,
    filesVerified: result.filesVerified,
    valid: result.valid,
  };
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function required(value: string, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}
