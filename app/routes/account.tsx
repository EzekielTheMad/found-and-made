import { useState, type FormEvent } from "react";
import { data, Form } from "react-router";

import { publicActionFailure } from "~/action-error";
import { authClient } from "~/auth-client";
import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/account";

export function meta() {
  return [{ title: "Account · Found & Made" }];
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const accounts = runtime.database.sqlite
    .prepare(
      "SELECT providerId FROM account WHERE userId = ? ORDER BY providerId",
    )
    .all(principal.userId) as { providerId: string }[];
  return {
    accounts: accounts.map((account) => account.providerId),
    googleEnabled: Boolean(
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
    ),
    principal,
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const form = await request.formData();
  try {
    const providerId = form.get("providerId");
    if (typeof providerId !== "string") throw new Error("Provider is required");
    runtime.identityService.unlinkAccount(principal, providerId);
    return data({ message: "Connected account removed." });
  } catch (error) {
    const failure = publicActionFailure(error, "Unable to unlink account");
    return data(
      { error: failure.message, requestId: failure.requestId },
      { status: 400 },
    );
  }
}

export default function Account({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  const [linkError, setLinkError] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const actionError =
    actionData && "error" in actionData ? actionData.error : "";
  const actionMessage =
    actionData && "message" in actionData ? actionData.message : "";
  async function linkGoogle() {
    setLinkError("");
    const result = await authClient.linkSocial({
      callbackURL: "/account",
      provider: "google",
    });
    if (result.error)
      setLinkError(result.error.message ?? "Unable to link Google");
  }
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setPasswordError("");
    setPasswordMessage("");
    const form = new FormData(formElement);
    const currentPassword = formText(form, "currentPassword");
    const newPassword = formText(form, "newPassword");
    const confirmation = formText(form, "confirmation");
    if (newPassword !== confirmation) {
      setPasswordError("The new passwords do not match.");
      return;
    }
    const result = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    if (result.error) {
      setPasswordError(result.error.message ?? "Unable to change password");
      return;
    }
    formElement.reset();
    setPasswordMessage(
      "Password changed. Other signed-in devices have been signed out.",
    );
  }
  return (
    <>
      <main className="narrow-shell">
        <section className="form-card" aria-labelledby="account-title">
          <p className="eyebrow">{loaderData.principal.role}</p>
          <h1 id="account-title">Connected sign-in methods</h1>
          {actionError || linkError || passwordError ? (
            <p role="alert">{actionError || linkError || passwordError}</p>
          ) : null}
          {actionMessage || passwordMessage ? (
            <p role="status">{actionMessage || passwordMessage}</p>
          ) : null}
          <div className="stacked-list">
            {loaderData.accounts.map((providerId) =>
              providerId === "credential" ? (
                <div className="inline-form" key={providerId}>
                  <strong>Local email and password</strong>
                  <span className="status-chip">Recovery method</span>
                </div>
              ) : (
                <Form className="inline-form" method="post" key={providerId}>
                  <input name="providerId" type="hidden" value={providerId} />
                  <strong>Google</strong>
                  <button type="submit">Remove</button>
                </Form>
              ),
            )}
          </div>
          {loaderData.googleEnabled &&
          !loaderData.accounts.includes("google") ? (
            <div className="account-link-panel">
              <h2>Connect Google</h2>
              <p>
                Sign in to the Google account with the same email address to add
                it as another sign-in method. Your recipes stay in this account;
                nothing is copied or merged in the background.
              </p>
              <button onClick={() => void linkGoogle()} type="button">
                Connect Google account
              </button>
            </div>
          ) : null}
          {loaderData.accounts.includes("credential") ? (
            <section className="account-password-panel">
              <h2>Change password</h2>
              <form
                className="stacked-form"
                onSubmit={(event) => void changePassword(event)}
              >
                <label>
                  Current password
                  <input
                    autoComplete="current-password"
                    name="currentPassword"
                    required
                    type="password"
                  />
                </label>
                <label>
                  New password
                  <input
                    autoComplete="new-password"
                    minLength={12}
                    name="newPassword"
                    required
                    type="password"
                  />
                </label>
                <label>
                  Confirm new password
                  <input
                    autoComplete="new-password"
                    minLength={12}
                    name="confirmation"
                    required
                    type="password"
                  />
                </label>
                <p className="recipe-meta">
                  Use at least 12 characters. Changing it signs out other
                  devices for your protection.
                </p>
                <button className="primary-button" type="submit">
                  Change password
                </button>
              </form>
            </section>
          ) : null}
          <Form action="/sign-out" method="post">
            <button type="submit">Sign out</button>
          </Form>
        </section>
      </main>
    </>
  );
}

function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
