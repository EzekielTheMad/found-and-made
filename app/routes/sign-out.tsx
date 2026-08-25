import { redirect } from "react-router";

import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/sign-out";

export async function action({ context, request }: Route.ActionArgs) {
  const result = await context.get(appRuntimeContext).auth.api.signOut({
    headers: request.headers,
    returnHeaders: true,
  });
  const headers = new Headers();
  for (const cookie of result.headers.getSetCookie())
    headers.append("Set-Cookie", cookie);
  return redirect("/sign-in", { headers });
}

export function loader() {
  return redirect("/");
}
