import { data, Form, redirect } from "react-router";

import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/sign-in";

export function meta() {
  return [{ title: "Sign in · Found & Made" }];
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  if (runtime.identityService.needsInitialOwner()) return redirect("/setup");
  if ((await runtime.sessionService.principal(request)).kind === "user") {
    return redirect("/");
  }
  return null;
}

export async function action({ context, request }: Route.ActionArgs) {
  const runtime = context.get(appRuntimeContext);
  const form = await request.formData();
  const email = formText(form, "email");
  const password = formText(form, "password");
  try {
    const result = await runtime.auth.api.signInEmail({
      body: { email, password },
      headers: request.headers,
      returnHeaders: true,
    });
    const headers = new Headers();
    for (const cookie of result.headers.getSetCookie())
      headers.append("Set-Cookie", cookie);
    return redirect("/", { headers });
  } catch {
    return data({ error: "Email or password is incorrect" }, { status: 400 });
  }
}

function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export default function SignIn({ actionData }: Route.ComponentProps) {
  return (
    <main className="narrow-shell auth-shell">
      <section className="form-card" aria-labelledby="sign-in-title">
        <p className="eyebrow">Private cookbook</p>
        <h1 id="sign-in-title">Sign in</h1>
        {actionData?.error ? <p role="alert">{actionData.error}</p> : null}
        <Form className="stacked-form" method="post">
          <label>
            Email
            <input
              autoComplete="email"
              name="email"
              required
              type="email"
              autoFocus
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              name="password"
              required
              type="password"
            />
          </label>
          <button className="primary-button" type="submit">
            Sign in
          </button>
        </Form>
        <p>
          <a href="/forgot-password">Forgot password?</a>
        </p>
      </section>
    </main>
  );
}
