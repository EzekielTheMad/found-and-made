import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import { OfflineCoordinator } from "~/components/offline-coordinator";
import { SiteHeader } from "~/components/site-header";
import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/root";
import "@fontsource-variable/ibm-plex-sans/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/ibm-plex-mono/700.css";
import "./styles/global.css";

export async function loader({ context, request }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.principal(request);
  return {
    navigationRole: principal.kind === "user" ? principal.role : null,
    offlinePartitionKey: principal.kind === "user" ? principal.userId : null,
  };
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#214a33" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <link href="/manifest.webmanifest" rel="manifest" />
        <link href="/icons/icon.svg" rel="icon" type="image/svg+xml" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <OfflineCoordinator partitionKey={loaderData.offlinePartitionKey} />
      <SiteHeader role={loaderData.navigationRole} />
      <Outlet />
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let detail = "The request could not be completed.";

  if (isRouteErrorResponse(error) && error.status === 404) {
    title = "Page not found";
    detail = "That page is not available on this Found & Made instance.";
  }

  return (
    <main className="centered-shell">
      <section className="empty-card" aria-labelledby="error-title">
        <p className="eyebrow">Found &amp; Made</p>
        <h1 id="error-title">{title}</h1>
        <p>{detail}</p>
        <a className="button-link" href="/">
          Return home
        </a>
      </section>
    </main>
  );
}
