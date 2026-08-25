import { useEffect } from "react";
import { data, Form, redirect, useRevalidator } from "react-router";

import { publicActionFailure } from "~/action-error";
import { appRuntimeContext } from "~/context";
import {
  IMPORT_STAGES,
  type DuplicateImport,
  type ImportReviewPackage,
} from "#src/modules/imports/import.types";

import type { Route } from "./+types/import-review";

export function meta({ loaderData }: Route.MetaArgs) {
  const title = loaderData?.prepared?.draft.title ?? "Recipe import";
  return [{ title: `Import ${title} · Found & Made` }];
}

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const sessionId = requiredId(params.sessionId);
  const session = runtime.importService.get(principal, sessionId);
  const checkpoints = runtime.importService.checkpoints(principal, sessionId);
  const duplicate = checkpoints.find((item) => item.stage === "duplicate")
    ?.artifact as DuplicateImport | undefined;
  return {
    checkpoints,
    prepared: checkpoints.some((item) => item.stage === "review")
      ? runtime.importService.review(principal, sessionId)
      : null,
    skippedDuplicate:
      session.status === "skipped"
        ? (duplicate?.duplicateCandidates[0] ?? null)
        : null,
    session,
  };
}

export async function action({ context, params, request }: Route.ActionArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const sessionId = requiredId(params.sessionId);
  const form = await request.formData();
  try {
    if (field(form, "intent") !== "retry") {
      return data({ error: "Unknown import action" }, { status: 400 });
    }
    runtime.importService.retry(principal, sessionId);
    return redirect(`/imports/${sessionId}`);
  } catch (error) {
    const failure = publicActionFailure(error, "Import retry failed");
    return data(
      { error: failure.message, requestId: failure.requestId },
      { status: 400 },
    );
  }
}

export default function ImportReview({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  const title = loaderData.prepared?.draft.title ?? "recipe";
  return (
    <main className="page-shell narrow-shell">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <a href="/imports">Imports</a>
        <span aria-hidden="true">/</span>
        <span>Status</span>
      </nav>
      <p className="eyebrow">Private automatic import</p>
      <h1>
        {loaderData.session.status === "completed"
          ? `Imported “${title}”`
          : loaderData.session.status === "skipped"
            ? "Exact duplicate skipped"
            : `Importing “${title}”`}
      </h1>
      {actionData?.error ? <p role="alert">{actionData.error}</p> : null}
      {loaderData.session.status === "completed" ? (
        <section className="success-card">
          <h2>Saved privately</h2>
          <p>
            Found &amp; Made used its best structured result. You can edit this
            recipe whenever you notice something that needs adjusting.
          </p>
          <a href={`/recipes/${loaderData.session.resultingRecipeId}`}>
            Open recipe
          </a>
        </section>
      ) : loaderData.session.status === "skipped" ? (
        <section className="success-card">
          <h2>Your existing recipe was kept</h2>
          <p>
            This source or recipe content exactly matches an active recipe, so
            Found &amp; Made did not create another copy.
          </p>
          {loaderData.skippedDuplicate ? (
            <a href={`/recipes/${loaderData.skippedDuplicate.id}`}>
              Open {loaderData.skippedDuplicate.title}
            </a>
          ) : null}
        </section>
      ) : (
        <ImportProgress
          checkpoints={loaderData.checkpoints.map((item) => item.stage)}
          session={loaderData.session}
        />
      )}
      {loaderData.prepared ? (
        <PreparedWarnings prepared={loaderData.prepared} />
      ) : null}
    </main>
  );
}

function ImportProgress({
  checkpoints,
  session,
}: {
  checkpoints: string[];
  session: Route.ComponentProps["loaderData"]["session"];
}) {
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!["queued", "processing", "review"].includes(session.status)) return;
    const timer = window.setInterval(() => {
      void revalidator.revalidate();
    }, 750);
    return () => window.clearInterval(timer);
  }, [revalidator, session.status]);
  return (
    <section className="form-card import-progress" aria-live="polite">
      <h2>
        {session.status === "failed"
          ? "Import needs attention"
          : "Building your private recipe"}
      </h2>
      <progress max={100} value={session.progress}>
        {session.progress}%
      </progress>
      <ol className="stage-list">
        {IMPORT_STAGES.map((stage) => (
          <li
            className={checkpoints.includes(stage) ? "complete" : ""}
            key={stage}
          >
            {stage === "review" ? "save privately" : stage}
          </li>
        ))}
      </ol>
      {session.status === "failed" ? (
        <Form method="post">
          <input name="intent" type="hidden" value="retry" />
          {session.resultingRecipeId ? (
            <p>
              The recipe itself was saved. Retry to finish attached media, or
              <a href={`/recipes/${session.resultingRecipeId}`}> open it now</a>
              .
            </p>
          ) : (
            <p>
              The supplied material is preserved. Retry the durable job or add
              more source text when the original did not contain a usable
              recipe.
            </p>
          )}
          <button type="submit">Retry import</button>
        </Form>
      ) : (
        <p className="recipe-meta">
          This page refreshes while Found &amp; Made saves the best result.
        </p>
      )}
    </section>
  );
}

function PreparedWarnings({ prepared }: { prepared: ImportReviewPackage }) {
  const hasNotes =
    prepared.warnings.length > 0 ||
    prepared.brandConfirmations.length > 0 ||
    prepared.duplicateCandidates.length > 0;
  if (!hasNotes) return null;
  return (
    <details className="form-card">
      <summary>Things you may want to check later</summary>
      {prepared.warnings.length > 0 ? (
        <ul>
          {prepared.warnings.map((warning, index) => (
            <li key={`${warning.code}-${index}`}>{warning.message}</li>
          ))}
        </ul>
      ) : null}
      {prepared.brandConfirmations.length > 0 ? (
        <p>
          {prepared.brandConfirmations.length} branded ingredient
          normalization(s) were saved as best guesses while preserving the
          original wording.
        </p>
      ) : null}
      {prepared.duplicateCandidates.length > 0 ? (
        <p>
          This exactly matches an existing active recipe and will be skipped.
        </p>
      ) : null}
    </details>
  );
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function requiredId(value: string | undefined): string {
  if (!value) throw new Error("Import session ID is required");
  return value;
}
