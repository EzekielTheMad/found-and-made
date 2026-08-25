import { data, Form, redirect } from "react-router";

import { publicActionFailure } from "~/action-error";
import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/recover";

export function meta() {
  return [{ title: "Recover account · Found & Made" }];
}

export function loader({ params }: Route.LoaderArgs) {
  // React Router uses thrown Responses to select the route error boundary.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  if (!params.token) throw new Response("Not found", { status: 404 });
  return null;
}

export async function action({ context, params, request }: Route.ActionArgs) {
  // React Router uses thrown Responses to select the route error boundary.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  if (!params.token) throw new Response("Not found", { status: 404 });
  const form = await request.formData();
  const password = form.get("password");
  if (typeof password !== "string") {
    return data({ error: "Password is required" }, { status: 400 });
  }
  try {
    await context
      .get(appRuntimeContext)
      .recoveryService.resetPassword(params.token, password);
    return redirect("/sign-in?recovered=1");
  } catch (error) {
    const failure = publicActionFailure(error, "Recovery failed");
    return data(
      { error: failure.message, requestId: failure.requestId },
      { status: 400 },
    );
  }
}

export default function Recover({ actionData }: Route.ComponentProps) {
  return (
    <main className="narrow-shell auth-shell">
      <section className="form-card" aria-labelledby="recover-title">
        <p className="eyebrow">Single-use recovery</p>
        <h1 id="recover-title">Choose a new password</h1>
        <p>Using this link revokes every existing session for the account.</p>
        {actionData?.error ? <p role="alert">{actionData.error}</p> : null}
        <Form className="stacked-form" method="post">
          <label>
            New password
            <input
              autoComplete="new-password"
              minLength={12}
              name="password"
              required
              type="password"
            />
          </label>
          <button className="primary-button" type="submit">
            Reset password
          </button>
        </Form>
      </section>
    </main>
  );
}
