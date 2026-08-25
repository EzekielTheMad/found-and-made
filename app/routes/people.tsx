import { data, Form } from "react-router";

import { publicActionFailure } from "~/action-error";
import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/people";

export function meta() {
  return [{ title: "People · Found & Made" }];
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  runtime.identityService.policy.require(principal, "people:manage");
  return {
    publicMode: runtime.publishingService.isPublicModeEnabled(),
    users: runtime.identityService.listUsers(principal),
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const form = await request.formData();
  const intentValue = form.get("intent");
  const intent = typeof intentValue === "string" ? intentValue : "";
  try {
    if (intent === "invite") {
      const role = form.get("role");
      if (role !== "editor" && role !== "viewer") {
        return data({ error: "Role is required" }, { status: 400 });
      }
      const invitation = runtime.identityService.createInvitation(principal, {
        email: formText(form, "email"),
        role,
      });
      const invitationUrl = runtime.publicUrl(`/invite/${invitation.token}`);
      return data({
        invitationUrl,
        message: "Invitation created. Copy it now.",
      });
    }
    if (intent === "public-mode") {
      runtime.publishingService.setPublicMode(
        principal,
        form.get("enabled") === "true",
      );
      return data({ message: "Public cookbook mode updated." });
    }
    if (intent === "role") {
      const role = form.get("role");
      if (role !== "owner" && role !== "editor" && role !== "viewer") {
        return data({ error: "Role is required" }, { status: 400 });
      }
      runtime.identityService.changeRole(
        principal,
        formText(form, "userId"),
        role,
      );
      return data({ message: "Role updated." });
    }
    return data({ error: "Unknown people action" }, { status: 400 });
  } catch (error) {
    const failure = publicActionFailure(error, "People action failed");
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

export default function People({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  const actionError =
    actionData && "error" in actionData ? actionData.error : "";
  const actionMessage =
    actionData && "message" in actionData ? actionData.message : "";
  const invitationUrl =
    actionData &&
    "invitationUrl" in actionData &&
    typeof actionData.invitationUrl === "string"
      ? actionData.invitationUrl
      : "";
  return (
    <>
      <main className="page-shell">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Owner controls</p>
            <h1>People &amp; visibility</h1>
          </div>
        </div>
        {actionError ? <p role="alert">{actionError}</p> : null}
        {actionMessage ? <p role="status">{actionMessage}</p> : null}
        {invitationUrl ? (
          <label>
            Clear-once invitation URL
            <input readOnly value={invitationUrl} />
          </label>
        ) : null}
        <div className="settings-grid">
          <section className="form-card" aria-labelledby="invite-person-title">
            <h2 id="invite-person-title">Invite a person</h2>
            <Form className="stacked-form" method="post">
              <input name="intent" type="hidden" value="invite" />
              <label>
                Email
                <input name="email" required type="email" />
              </label>
              <label>
                Role
                <select name="role">
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
              </label>
              <button className="primary-button" type="submit">
                Create invitation
              </button>
            </Form>
          </section>
          <section className="form-card" aria-labelledby="public-mode-title">
            <h2 id="public-mode-title">Public cookbook</h2>
            <p>
              Public mode opens the cookbook. Use Library &gt; Bulk edit to make
              selected recipes public or private.
            </p>
            <Form method="post">
              <input name="intent" type="hidden" value="public-mode" />
              <input
                name="enabled"
                type="hidden"
                value={loaderData.publicMode ? "false" : "true"}
              />
              <button type="submit">
                {loaderData.publicMode ? "Disable" : "Enable"} public mode
              </button>
            </Form>
          </section>
        </div>
        <section className="form-card" aria-labelledby="collaborators-title">
          <h2 id="collaborators-title">Collaborators</h2>
          <div className="stacked-list">
            {loaderData.users.map((user) => (
              <Form className="inline-form" method="post" key={user.id}>
                <input name="intent" type="hidden" value="role" />
                <input name="userId" type="hidden" value={user.id} />
                <span>
                  <strong>{user.name}</strong>
                  <br />
                  <span className="muted">{user.email}</span>
                </span>
                <label>
                  <span className="sr-only">Role for {user.name}</span>
                  <select defaultValue={user.role} name="role">
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                </label>
                <button type="submit">Update role</button>
              </Form>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}
