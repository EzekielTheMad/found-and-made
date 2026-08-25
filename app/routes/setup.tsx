import { data, Form, redirect } from "react-router";

import { publicActionFailure } from "~/action-error";
import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/setup";

export function meta() {
  return [{ title: "Set up Found & Made" }];
}

export function loader({ context }: Route.LoaderArgs) {
  if (!context.get(appRuntimeContext).identityService.needsInitialOwner()) {
    return redirect("/sign-in");
  }
  return null;
}

export async function action({ context, request }: Route.ActionArgs) {
  const runtime = context.get(appRuntimeContext);
  const form = await request.formData();
  const input = credentials(form);
  try {
    await runtime.identityService.createInitialOwner(input);
    const result = await runtime.auth.api.signInEmail({
      body: { email: input.email, password: input.password },
      headers: request.headers,
      returnHeaders: true,
    });
    return redirect("/", { headers: cookieHeaders(result.headers) });
  } catch (error) {
    const failure = publicActionFailure(error, "Setup failed");
    return data(
      { error: failure.message, requestId: failure.requestId },
      { status: 400 },
    );
  }
}

export default function Setup({ actionData }: Route.ComponentProps) {
  return (
    <main className="narrow-shell auth-shell">
      <section className="form-card" aria-labelledby="setup-title">
        <p className="eyebrow">First run</p>
        <h1 id="setup-title">Create the local Owner</h1>
        <p className="lede">
          This local credential remains the recovery path even if Google is
          linked later.
        </p>
        {actionData?.error ? <p role="alert">{actionData.error}</p> : null}
        <Form className="stacked-form" method="post">
          <label>
            Name
            <input autoComplete="name" name="name" required autoFocus />
          </label>
          <label>
            Email
            <input autoComplete="email" name="email" required type="email" />
          </label>
          <label>
            Password
            <input
              autoComplete="new-password"
              minLength={12}
              name="password"
              required
              type="password"
            />
          </label>
          <button className="primary-button" type="submit">
            Create Owner
          </button>
        </Form>
      </section>
    </main>
  );
}

function credentials(form: FormData) {
  return {
    email: requiredText(form, "email"),
    name: requiredText(form, "name"),
    password: requiredText(form, "password"),
  };
}

function requiredText(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required`);
  return value;
}

function cookieHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const cookie of source.getSetCookie())
    headers.append("Set-Cookie", cookie);
  return headers;
}
