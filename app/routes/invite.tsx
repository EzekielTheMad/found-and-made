import { data, Form, redirect } from "react-router";

import { publicActionFailure } from "~/action-error";
import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/invite";

export function meta() {
  return [{ title: "Accept invitation · Found & Made" }];
}

export function loader({ params }: Route.LoaderArgs) {
  // React Router uses thrown Responses to select the route error boundary.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  if (!params.token) throw new Response("Not found", { status: 404 });
  return { token: params.token };
}

export async function action({ context, params, request }: Route.ActionArgs) {
  // React Router uses thrown Responses to select the route error boundary.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  if (!params.token) throw new Response("Not found", { status: 404 });
  const runtime = context.get(appRuntimeContext);
  const form = await request.formData();
  const email = formText(form, "email");
  const password = formText(form, "password");
  const name = formText(form, "name");
  try {
    await runtime.identityService.acceptInvitation(params.token, {
      email,
      name,
      password,
    });
    const result = await runtime.auth.api.signInEmail({
      body: { email, password },
      headers: request.headers,
      returnHeaders: true,
    });
    const headers = new Headers();
    for (const cookie of result.headers.getSetCookie())
      headers.append("Set-Cookie", cookie);
    return redirect("/", { headers });
  } catch (error) {
    const failure = publicActionFailure(error, "Invitation failed");
    return data(
      { error: failure.message, requestId: failure.requestId },
      { status: 400 },
    );
  }
}

function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export default function Invite({ actionData }: Route.ComponentProps) {
  return (
    <main className="narrow-shell auth-shell">
      <section className="form-card" aria-labelledby="invite-title">
        <p className="eyebrow">Invitation</p>
        <h1 id="invite-title">Join this cookbook</h1>
        {actionData?.error ? <p role="alert">{actionData.error}</p> : null}
        <Form className="stacked-form" method="post">
          <label>
            Name
            <input name="name" required autoFocus />
          </label>
          <label>
            Email
            <input name="email" required type="email" />
          </label>
          <label>
            Password
            <input minLength={12} name="password" required type="password" />
          </label>
          <button className="primary-button" type="submit">
            Accept invitation
          </button>
        </Form>
      </section>
    </main>
  );
}
