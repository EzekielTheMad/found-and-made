import { data, Form } from "react-router";

import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/forgot-password";

export function meta() {
  return [{ title: "Password recovery · Found & Made" }];
}

export function loader({ context }: Route.LoaderArgs) {
  return {
    smtpConfigured: Boolean(context.get(appRuntimeContext).smtpRecoveryMailer),
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const runtime = context.get(appRuntimeContext);
  const form = await request.formData();
  const email = form.get("email");
  if (typeof email !== "string") {
    return data({ error: "Email is required" }, { status: 400 });
  }
  if (!runtime.smtpRecoveryMailer) {
    return data(
      { error: "Email recovery is not configured on this server" },
      { status: 503 },
    );
  }
  try {
    await runtime.recoveryService.requestEmailReset(
      email,
      runtime.smtpRecoveryMailer.deliver,
    );
    return data({
      message: "If that account exists, a recovery email was sent.",
    });
  } catch {
    return data(
      { error: "Recovery email could not be sent. Try again later." },
      { status: 502 },
    );
  }
}

export default function ForgotPassword({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  const actionError =
    actionData && "error" in actionData ? actionData.error : "";
  const actionMessage =
    actionData && "message" in actionData ? actionData.message : "";
  return (
    <main className="narrow-shell auth-shell">
      <section className="form-card" aria-labelledby="forgot-title">
        <p className="eyebrow">Account recovery</p>
        <h1 id="forgot-title">Reset your password</h1>
        {actionError ? <p role="alert">{actionError}</p> : null}
        {actionMessage ? <p role="status">{actionMessage}</p> : null}
        {loaderData.smtpConfigured ? (
          <Form className="stacked-form" method="post">
            <label>
              Email
              <input autoComplete="email" name="email" required type="email" />
            </label>
            <button className="primary-button" type="submit">
              Send recovery email
            </button>
          </Form>
        ) : (
          <p>
            Email recovery is not configured. An administrator can create a
            single-use Owner link from the server console.
          </p>
        )}
        <a href="/sign-in">Back to sign in</a>
      </section>
    </main>
  );
}
