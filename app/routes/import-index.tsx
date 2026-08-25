import { useEffect, useState } from "react";
import {
  data,
  Form,
  redirect,
  useNavigation,
  useRevalidator,
} from "react-router";

import { publicActionFailure } from "~/action-error";
import { createClientId } from "~/client-id";
import { appRuntimeContext } from "~/context";
import type {
  ImportSource,
  ImportSession,
  MigrationFormat,
} from "#src/modules/imports/import.types";
import {
  RECIPE_CREATOR_MAX_LENGTH,
  sanitizeRecipeCreator,
} from "#src/modules/recipes/recipe-metadata";

import type { Route } from "./+types/import-index";

export function meta() {
  return [{ title: "Import a recipe · Found & Made" }];
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  runtime.identityService.policy.require(principal, "recipe:create");
  const sessions = runtime.importService.list(principal);
  const batchKey = migrationBatchKey(
    new URL(request.url).searchParams.get("batch"),
  );
  const batchSessions =
    batchKey && principal.kind === "user"
      ? sessions.filter((session) =>
          session.requestKey.startsWith(`${principal.userId}:${batchKey}:`),
        )
      : [];
  return {
    batch:
      batchKey && batchSessions.length > 0
        ? { key: batchKey, sessions: batchSessions.map(importSessionView) }
        : null,
    idempotencyKey: createClientId(),
    sessions: sessions.slice(0, 20).map(importSessionView),
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  runtime.identityService.policy.require(principal, "recipe:create");
  const boundedForm =
    await import("#src/platform/files/bounded-form-data.server");
  const storedRefs = new Set<string>();
  try {
    const form = await boundedForm.parseBoundedFormData(request, {
      maxBodyBytes: 101 * 1024 * 1024,
      maxFieldBytes: 1024 * 1024,
      maxFields: 8,
      maxFileBytes: 100 * 1024 * 1024,
      maxFiles: 1,
      maxParts: 9,
    });
    const intent = field(form, "intent");
    if (intent === "retry-failed-batch") {
      const batchKey = required(field(form, "batchKey"), "Import batch key");
      runtime.importService.retryFailedBatch(principal, batchKey);
      return redirect(`/imports?batch=${encodeURIComponent(batchKey)}`);
    }
    const kind = field(form, "sourceKind");
    const idempotencyKey = required(
      field(form, "idempotencyKey"),
      "Import request key",
    );
    if (kind === "migration_json") {
      const defaultCreatorName = sanitizeRecipeCreator(
        field(form, "defaultCreatorName"),
      );
      const upload = form.get("migrationUpload");
      if (!(upload instanceof File) || upload.size === 0) {
        throw new Error("Choose a recipe export file");
      }
      const parser =
        await import("#src/modules/imports/migration-archive.server");
      let recipes: Awaited<ReturnType<typeof parser.parseMigrationUpload>>;
      try {
        recipes = await parser.parseMigrationUpload(
          upload,
          migrationFormat(field(form, "migrationFormat")),
        );
      } catch (error) {
        if (error instanceof parser.MigrationUploadError) {
          return data({ error: error.message }, { status: 400 });
        }
        throw error;
      }
      const sources: ImportSource[] = [];
      for (const recipe of recipes) {
        let source = recipe.source;
        if (defaultCreatorName) {
          source = { ...source, defaultCreatorName };
        }
        if (recipe.heroImage) {
          const imageName =
            recipe.heroImage.fileName.split("/").at(-1) ?? "original.webp";
          const stored = await runtime.importUploadStore.store(
            new File([Buffer.from(recipe.heroImage.bytes)], imageName),
          );
          storedRefs.add(stored.storageRef);
          source = {
            ...source,
            heroImage: {
              fileName: imageName,
              mimeType: stored.mimeType,
              storageRef: stored.storageRef,
            },
          };
        }
        sources.push(source);
      }
      runtime.importService.startBatch(principal, sources, { idempotencyKey });
      return redirect(`/imports?batch=${encodeURIComponent(idempotencyKey)}`);
    }
    let source: ImportSource;
    if (kind === "pasted_text") {
      source = {
        kind,
        text: required(field(form, "sourceText"), "Recipe text"),
      };
    } else if (kind === "website") {
      source = {
        kind,
        pastedText: field(form, "sourceText") || undefined,
        url: required(field(form, "url"), "Website URL"),
      };
    } else if (kind === "social_url") {
      source = {
        caption: field(form, "sourceText") || undefined,
        kind,
        platform: socialPlatform(field(form, "platform")),
        url: required(field(form, "url"), "Social URL"),
      };
    } else if (kind === "image" || kind === "pdf" || kind === "audio_video") {
      const upload = form.get("upload");
      if (!(upload instanceof File) || upload.size === 0) {
        throw new Error("Choose a source file");
      }
      const stored = await runtime.importUploadStore.store(upload);
      storedRefs.add(stored.storageRef);
      if (kind === "image") {
        if (!stored.mimeType.startsWith("image/")) {
          throw new Error("The selected source is not an image");
        }
        source = {
          fileName: upload.name,
          kind,
          mimeType: stored.mimeType,
          storageRef: stored.storageRef,
          userText: field(form, "sourceText") || undefined,
        };
      } else if (kind === "pdf") {
        if (stored.mimeType !== "application/pdf") {
          throw new Error("The selected source is not a PDF");
        }
        source = {
          fileName: upload.name,
          kind,
          mimeType: "application/pdf",
          storageRef: stored.storageRef,
          userText: field(form, "sourceText") || undefined,
        };
      } else {
        if (
          !stored.mimeType.startsWith("audio/") &&
          !stored.mimeType.startsWith("video/")
        ) {
          throw new Error("The selected source is not audio or video");
        }
        source = {
          fileName: upload.name,
          kind,
          mediaType: stored.mimeType.startsWith("audio/") ? "audio" : "video",
          mimeType: stored.mimeType,
          storageRef: stored.storageRef,
          transcript: field(form, "sourceText") || undefined,
        };
      }
    } else {
      return data({ error: "Choose an import source type" }, { status: 400 });
    }

    const session = runtime.importService.start(principal, source, {
      idempotencyKey,
    });
    return redirect(`/imports/${session.id}`);
  } catch (error) {
    let failureCause = error;
    for (const storedRef of storedRefs) {
      try {
        await runtime.importUploadStore.remove(storedRef);
      } catch (cleanupError) {
        failureCause = cleanupError;
      }
    }
    if (failureCause instanceof boundedForm.BoundedFormDataError) {
      return data(
        { error: failureCause.message },
        { status: failureCause.status },
      );
    }
    const failure = publicActionFailure(failureCause, "Import could not start");
    return data(
      { error: failure.message, requestId: failure.requestId },
      { status: 400 },
    );
  }
}

export default function ImportIndex({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  const [sourceKind, setSourceKind] = useState<ImportFormSource>("pasted_text");
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  return (
    <>
      <main className="page-shell narrow-shell">
        <p className="eyebrow">Add recipes</p>
        <h1>Import from almost anywhere</h1>
        <p className="lede">
          Imports are saved privately using the best available structure. Any
          warnings stay with the import so you can adjust a recipe later only
          when it needs attention.
        </p>
        {actionData?.error ? <p role="alert">{actionData.error}</p> : null}
        <Form
          className="stacked-form form-card"
          encType="multipart/form-data"
          method="post"
        >
          <input
            name="idempotencyKey"
            type="hidden"
            value={loaderData.idempotencyKey}
          />
          <label>
            Source type
            <select
              name="sourceKind"
              onChange={(event) =>
                setSourceKind(event.currentTarget.value as ImportFormSource)
              }
              required
              value={sourceKind}
            >
              <option value="pasted_text">Pasted recipe text</option>
              <option value="website">Recipe website</option>
              <option value="social_url">Social or video URL</option>
              <option value="migration_json">Recipe manager migration</option>
              <option value="image">Photo or screenshot</option>
              <option value="pdf">PDF</option>
              <option value="audio_video">Audio or video file</option>
            </select>
          </label>
          <div aria-live="polite" className="import-source-fields">
            {sourceKind === "pasted_text" ? (
              <label>
                Recipe text
                <textarea
                  name="sourceText"
                  placeholder="Paste the complete recipe with its ingredients and steps."
                  required
                  rows={12}
                />
              </label>
            ) : null}
            {sourceKind === "website" ? (
              <>
                <label>
                  Recipe website URL
                  <input
                    name="url"
                    placeholder="https://example.com/recipe"
                    required
                    type="url"
                  />
                </label>
                <label>
                  Fallback recipe text <span>(optional)</span>
                  <textarea
                    name="sourceText"
                    placeholder="Paste the recipe if the website blocks importing."
                    rows={8}
                  />
                </label>
              </>
            ) : null}
            {sourceKind === "social_url" ? (
              <>
                <label>
                  Platform
                  <select name="platform">
                    <option value="youtube">YouTube</option>
                    <option value="instagram">Instagram</option>
                    <option value="tiktok">TikTok</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label>
                  Public post or video URL
                  <input
                    name="url"
                    placeholder="https://..."
                    required
                    type="url"
                  />
                </label>
                <label>
                  Caption or transcript <span>(optional)</span>
                  <textarea
                    name="sourceText"
                    placeholder="Paste the caption or transcript for the best result."
                    rows={8}
                  />
                </label>
              </>
            ) : null}
            {sourceKind === "migration_json" ? <MigrationFields /> : null}
            {sourceKind === "image" ? (
              <MediaFields
                accept="image/jpeg,image/png,image/webp"
                helper="JPEG, PNG, or WebP up to 100 MiB. Automatic model reading is available up to 25 MiB; larger originals are preserved with the text fallback."
                label="Recipe photo or screenshot"
                textLabel="Fallback visible text (optional)"
              />
            ) : null}
            {sourceKind === "pdf" ? (
              <MediaFields
                accept="application/pdf"
                helper="PDF up to 100 MiB. Text PDFs are read locally; scanned-PDF model reading is available up to 25 MiB, with the original preserved on fallback."
                label="Recipe PDF"
                textLabel="Fallback recipe text (optional)"
              />
            ) : null}
            {sourceKind === "audio_video" ? (
              <MediaFields
                accept="audio/*,video/*"
                helper="Audio or video up to 100 MiB. Automatic transcription is available up to 25 MiB; larger originals are preserved with the transcript fallback."
                label="Recipe audio or video"
                textLabel="Fallback transcript (optional)"
              />
            ) : null}
          </div>
          <button
            className="primary-button"
            disabled={submitting}
            type="submit"
          >
            {submitting
              ? sourceKind === "migration_json"
                ? "Uploading and preparing recipes…"
                : "Starting import…"
              : sourceKind === "migration_json"
                ? "Queue private migration"
                : "Start private import"}
          </button>
        </Form>
        {loaderData.batch ? <MigrationBatch batch={loaderData.batch} /> : null}
        {loaderData.sessions.length > 0 ? (
          <section className="form-card" aria-labelledby="import-history-title">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Import activity</p>
                <h2 id="import-history-title">Recent imports</h2>
              </div>
            </div>
            <ImportProgressList sessions={loaderData.sessions} />
          </section>
        ) : null}
      </main>
    </>
  );
}

type ImportFormSource = Exclude<ImportSource["kind"], "manual">;
type MigrationBatchData = NonNullable<
  Route.ComponentProps["loaderData"]["batch"]
>;
type ImportSessionView = Route.ComponentProps["loaderData"]["sessions"][number];

function ImportProgressList({
  poll = true,
  sessions,
}: {
  poll?: boolean;
  sessions: ImportSessionView[];
}) {
  const revalidator = useRevalidator();
  const active = sessions.some((session) =>
    ["queued", "processing", "review"].includes(session.status),
  );

  useEffect(() => {
    if (!active || !poll) return;
    const timer = window.setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [active, poll, revalidator]);

  return (
    <ol className="import-progress-list">
      {sessions.map((session) => (
        <li key={session.id}>
          <div className="import-progress-heading">
            <a
              href={
                session.resultingRecipeId
                  ? `/recipes/${session.resultingRecipeId}`
                  : `/imports/${session.id}`
              }
            >
              {session.title}
            </a>
            <span>
              {importStatusLabel(session.status)} · {session.progress}%
            </span>
          </div>
          <progress max={100} value={session.progress}>
            {session.progress}%
          </progress>
          <small>{sourceLabel(session.sourceKind)}</small>
        </li>
      ))}
    </ol>
  );
}

function importStatusLabel(status: ImportSessionView["status"]): string {
  const labels: Record<ImportSessionView["status"], string> = {
    cancelled: "Cancelled",
    completed: "Uploaded",
    failed: "Needs attention",
    processing: "Importing",
    queued: "Waiting",
    review: "Finishing",
    skipped: "Duplicate skipped",
  };
  return labels[status];
}

function MigrationFields() {
  const [format, setFormat] = useState<MigrationFormat>("mealie");
  return (
    <>
      <label>
        Recipe manager
        <select
          aria-label="Recipe manager"
          name="migrationFormat"
          onChange={(event) =>
            setFormat(event.currentTarget.value as MigrationFormat)
          }
          value={format}
        >
          <option value="mealie">Mealie</option>
          <option value="tandoor">Tandoor Recipes</option>
          <option value="nextcloud">Nextcloud Cookbook</option>
          <option value="schema_org">Schema.org / JSON-LD</option>
        </select>
      </label>
      <label>
        Recipe export file
        <input
          accept=".json,.zip,application/json,application/ld+json,application/zip"
          aria-label="Recipe export file"
          aria-describedby="migration-file-help"
          name="migrationUpload"
          required
          type="file"
        />
      </label>
      <label>
        Default recipe creator <span>(optional)</span>
        <input
          maxLength={RECIPE_CREATOR_MAX_LENGTH}
          name="defaultCreatorName"
          placeholder="Used only when an imported recipe has no author"
        />
      </label>
      <p className="recipe-meta" id="migration-file-help">
        {MIGRATION_GUIDANCE[format]} Up to 500 recipes are saved as private
        recipes automatically. Native Mealie backups also bring across each
        available original recipe image; app-specific history is not copied. The
        default creator never replaces an author included in the export.
      </p>
    </>
  );
}

function MediaFields({
  accept,
  helper,
  label,
  textLabel,
}: {
  accept: string;
  helper: string;
  label: string;
  textLabel: string;
}) {
  return (
    <>
      <label>
        {label}
        <input accept={accept} name="upload" required type="file" />
      </label>
      <label>
        {textLabel}
        <textarea
          name="sourceText"
          placeholder="Paste text here only if you already have it or automatic extraction needs help."
          rows={8}
        />
      </label>
      <p className="recipe-meta">
        {helper} Files are magic-byte checked and stored under the configured
        data root.
      </p>
    </>
  );
}

function MigrationBatch({ batch }: { batch: MigrationBatchData }) {
  const revalidator = useRevalidator();
  const processingCount = batch.sessions.filter((session) =>
    ["queued", "processing", "review"].includes(session.status),
  ).length;
  const completedCount = batch.sessions.filter(
    (session) => session.status === "completed",
  ).length;
  const failedCount = batch.sessions.filter(
    (session) => session.status === "failed",
  ).length;
  const skippedCount = batch.sessions.filter(
    (session) => session.status === "skipped",
  ).length;
  const totalCount = batch.sessions.length;
  const settledCount = completedCount + failedCount + skippedCount;
  const overallProgress = Math.round(
    batch.sessions.reduce((total, session) => total + session.progress, 0) /
      Math.max(totalCount, 1),
  );

  useEffect(() => {
    if (processingCount === 0) return;
    const timer = window.setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [processingCount, revalidator]);
  return (
    <section
      className="form-card import-batch-card"
      aria-labelledby="migration-batch-title"
    >
      <p className="eyebrow">Bulk migration</p>
      <h2 id="migration-batch-title">
        {processingCount > 0
          ? `Importing ${settledCount} of ${totalCount} recipes`
          : `Import complete: ${completedCount} saved`}
      </h2>
      <div aria-live="polite" className="import-batch-progress" role="status">
        <div>
          <span>{overallProgress}% complete</span>
          {processingCount > 0 ? <span>Updates automatically</span> : null}
        </div>
        <progress max={100} value={overallProgress}>
          {overallProgress}%
        </progress>
      </div>
      <dl className="import-batch-stats">
        <div>
          <dt>Saved privately</dt>
          <dd>{completedCount}</dd>
        </div>
        <div>
          <dt>Processing</dt>
          <dd>{processingCount}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd>{failedCount}</dd>
        </div>
        <div>
          <dt>Duplicates skipped</dt>
          <dd>{skippedCount}</dd>
        </div>
      </dl>
      {failedCount > 0 ? (
        <Form method="post">
          <input name="intent" type="hidden" value="retry-failed-batch" />
          <input name="batchKey" type="hidden" value={batch.key} />
          <button type="submit">
            Retry {failedCount} failed import{failedCount === 1 ? "" : "s"}
          </button>
        </Form>
      ) : null}
      {completedCount > 0 ? (
        <a
          className="button-link"
          href={`/?importBatch=${encodeURIComponent(batch.key)}`}
        >
          Manage imported recipes
        </a>
      ) : null}
      <details className="import-session-details">
        <summary>View individual imports</summary>
        <ImportProgressList
          poll={false}
          sessions={batch.sessions.slice(0, 50)}
        />
        {batch.sessions.length > 50 ? (
          <p className="recipe-meta">
            Showing the first 50 of {batch.sessions.length} durable imports.
          </p>
        ) : null}
      </details>
    </section>
  );
}

function migrationRecipeTitle(source: ImportSource): string {
  if (source.kind !== "migration_json") return sourceLabel(source.kind);
  if (!source.payload || typeof source.payload !== "object") return "Migration";
  const payload = source.payload as Record<string, unknown>;
  const title = payload.name ?? payload.title;
  return typeof title === "string" && title.trim() ? title.trim() : "Migration";
}

function importSessionView(session: ImportSession) {
  return {
    id: session.id,
    progress: session.progress,
    resultingRecipeId: session.resultingRecipeId,
    sourceKind: session.sourceKind,
    status: session.status,
    title: migrationRecipeTitle(session.source),
  };
}

const MIGRATION_GUIDANCE: Record<MigrationFormat, string> = {
  mealie:
    "Upload the recipe-data JSON or ZIP from Mealie Group > Data > Recipes, not a raw database snapshot.",
  nextcloud:
    "Download your Nextcloud Cookbook Recipes folder as a ZIP containing one recipe.json per recipe.",
  schema_org:
    "Upload JSON or JSON-LD containing Recipe objects, including RecipeSage-compatible exports.",
  tandoor:
    "Use Tandoor's recipe export with the all-recipes option, then upload the JSON or ZIP.",
};

function sourceLabel(kind: ImportSource["kind"]): string {
  const labels: Record<ImportSource["kind"], string> = {
    audio_video: "Audio or video",
    image: "Photo or screenshot",
    manual: "Manual entry",
    migration_json: "Migration",
    pasted_text: "Pasted text",
    pdf: "PDF",
    social_url: "Social URL",
    website: "Website",
  };
  return labels[kind];
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function required(value: string, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function socialPlatform(
  value: string,
): "instagram" | "other" | "tiktok" | "youtube" {
  return value === "instagram" || value === "tiktok" || value === "youtube"
    ? value
    : "other";
}

function migrationFormat(value: string): MigrationFormat {
  return value === "tandoor" || value === "nextcloud" || value === "schema_org"
    ? value
    : "mealie";
}

function migrationBatchKey(value: string | null): string | null {
  const key = value?.trim() ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    key,
  )
    ? key
    : null;
}
