import { data, Form } from "react-router";

import { publicActionFailure } from "~/action-error";
import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/integrations";

export function meta() {
  return [{ title: "Integrations · Found & Made" }];
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  runtime.identityService.policy.require(principal, "instance:manage");
  const approved = new Set(runtime.mcpService.listApprovedRecipeIds(principal));
  return {
    approvedRecipes: runtime.recipeAccessService
      .list(principal)
      .map((recipe) => ({
        approved: approved.has(recipe.id),
        id: recipe.id,
        title: recipe.title,
      })),
    enabled: runtime.mcpTransportConfig.enabled,
    tokens: runtime.mcpService.listTokens(principal),
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  runtime.identityService.policy.require(principal, "instance:manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    if (intent === "issue-token") {
      const expiryDays = wholeNumber(text(form, "expiryDays"), 1, 3_650);
      const issued = runtime.mcpService.issueToken(principal, {
        expiresAt: new Date(Date.now() + expiryDays * 86_400_000),
        name: text(form, "name"),
        scopes: form.get("collectionsRead")
          ? ["collections:read", "recipes:read"]
          : ["recipes:read"],
      });
      return noStore({
        issuedToken: issued.token,
        message: "Token issued. Copy it now; it will not be shown again.",
      });
    }
    if (intent === "revoke-token") {
      runtime.mcpService.revokeToken(principal, text(form, "tokenId"));
      return noStore({ message: "Token revoked." });
    }
    if (intent === "set-approval") {
      runtime.mcpService.setRecipeApproval(
        principal,
        text(form, "recipeId"),
        text(form, "approved") === "true",
      );
      return noStore({ message: "Hermes recipe access updated." });
    }
    throw new Error("Unknown integration action");
  } catch (error) {
    const failure = publicActionFailure(error, "Action failed");
    return data(
      { error: failure.message, requestId: failure.requestId },
      { headers: { "Cache-Control": "no-store" }, status: 400 },
    );
  }
}

export default function Integrations({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  const error = actionData && "error" in actionData ? actionData.error : "";
  const message =
    actionData && "message" in actionData ? actionData.message : "";
  const issuedToken =
    actionData &&
    "issuedToken" in actionData &&
    typeof actionData.issuedToken === "string"
      ? actionData.issuedToken
      : "";
  return (
    <>
      <main className="page-shell">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Owner controls</p>
            <h1>Hermes integration</h1>
            <p>
              MCP is {loaderData.enabled ? "enabled" : "disabled"} for this
              server. Access is read-only and limited to recipes approved below.
            </p>
          </div>
        </div>
        {error ? <p role="alert">{error}</p> : null}
        {message ? <p role="status">{message}</p> : null}
        {issuedToken ? (
          <label>
            Clear-once service token
            <input readOnly value={issuedToken} />
          </label>
        ) : null}
        <div className="settings-grid">
          <section className="form-card" aria-labelledby="issue-token-title">
            <h2 id="issue-token-title">Issue a read-only token</h2>
            <Form className="stacked-form" method="post">
              <input name="intent" type="hidden" value="issue-token" />
              <label>
                Name
                <input name="name" required maxLength={120} />
              </label>
              <label>
                Expires after days
                <input
                  defaultValue="90"
                  max="3650"
                  min="1"
                  name="expiryDays"
                  required
                  type="number"
                />
              </label>
              <label>
                <input name="collectionsRead" type="checkbox" value="true" />
                Include collections and saved views
              </label>
              <button className="primary-button" type="submit">
                Issue token
              </button>
            </Form>
          </section>
          <section className="form-card" aria-labelledby="tokens-title">
            <h2 id="tokens-title">Service tokens</h2>
            <div className="stacked-list">
              {loaderData.tokens.length ? (
                loaderData.tokens.map((token) => (
                  <div className="inline-form" key={token.id}>
                    <span>
                      <strong>{token.name}</strong>
                      <br />
                      <span className="muted">
                        {token.revokedAt
                          ? "Revoked"
                          : token.expiresAt
                            ? `Expires ${new Date(token.expiresAt).toLocaleDateString()}`
                            : "No expiry"}
                      </span>
                    </span>
                    {!token.revokedAt ? (
                      <Form method="post">
                        <input
                          name="intent"
                          type="hidden"
                          value="revoke-token"
                        />
                        <input name="tokenId" type="hidden" value={token.id} />
                        <button type="submit">Revoke</button>
                      </Form>
                    ) : null}
                  </div>
                ))
              ) : (
                <p className="muted">No service tokens issued.</p>
              )}
            </div>
          </section>
        </div>
        <section className="form-card" aria-labelledby="approvals-title">
          <h2 id="approvals-title">Approved recipes</h2>
          <p>
            Publication does not grant Hermes access. Each recipe requires this
            separate approval.
          </p>
          <div className="stacked-list">
            {loaderData.approvedRecipes.map((recipe) => (
              <Form className="inline-form" method="post" key={recipe.id}>
                <input name="intent" type="hidden" value="set-approval" />
                <input name="recipeId" type="hidden" value={recipe.id} />
                <input
                  name="approved"
                  type="hidden"
                  value={recipe.approved ? "false" : "true"}
                />
                <span>{recipe.title}</span>
                <button type="submit">
                  {recipe.approved ? "Remove access" : "Approve"}
                </button>
              </Form>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function wholeNumber(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Value must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function noStore(payload: { issuedToken?: string; message: string }) {
  return data(payload, { headers: { "Cache-Control": "no-store" } });
}
