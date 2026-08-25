import { randomUUID } from "node:crypto";

import type { ErrorRequestHandler, RequestHandler, Response } from "express";

const permissionsPolicy = [
  "camera=()",
  "geolocation=()",
  "microphone=()",
  "payment=()",
  "usb=()",
].join(", ");

const contentSecurityPolicy = [
  "base-uri 'self'",
  "connect-src 'self'",
  "default-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
].join("; ");

interface HttpBaselineOptions {
  enableHsts?: boolean;
  enableOriginIsolation?: boolean;
}

export function createHttpBaseline({
  enableHsts = false,
  enableOriginIsolation = false,
}: HttpBaselineOptions = {}): RequestHandler {
  return (request, response, next) => {
    const requestId = randomUUID();
    (response.locals as Record<string, unknown>).requestId = requestId;

    response.set({
      "Content-Security-Policy": contentSecurityPolicy,
      "Cross-Origin-Resource-Policy": "same-origin",
      "Permissions-Policy": permissionsPolicy,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-DNS-Prefetch-Control": "off",
      "X-Frame-Options": "DENY",
      "X-Request-ID": requestId,
    });

    if (enableHsts) {
      response.set("Strict-Transport-Security", "max-age=31536000");
    }
    if (enableOriginIsolation) {
      response.set({
        "Cross-Origin-Opener-Policy": "same-origin",
        "Origin-Agent-Cluster": "?1",
      });
    }

    if (request.path === "/api" || request.path.startsWith("/api/")) {
      response.set("Cache-Control", "no-store");
    } else if (
      explicitlyAcceptsHtml(request.get("accept")) &&
      !request.path.startsWith("/public/")
    ) {
      response.set("Cache-Control", "private, no-store");
    }

    next();
  };
}

function explicitlyAcceptsHtml(accept: string | undefined): boolean {
  return /(?:^|,)\s*(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*,|\s*$)/i.test(
    accept ?? "",
  );
}

export const httpBaseline = createHttpBaseline();

export const unknownApiRoute: RequestHandler = (_request, response) => {
  response
    .status(404)
    .type("application/problem+json")
    .json({
      requestId: requestIdFor(response),
      status: 404,
      title: "Resource not found",
      type: "about:blank",
    });
};

export const genericHttpError: ErrorRequestHandler = (
  _error,
  request,
  response,
  next,
) => {
  if (response.headersSent) {
    next(_error);
    return;
  }

  const requestId = requestIdFor(response);
  console.error(
    JSON.stringify({
      event: "http.request_failed",
      method: request.method,
      requestId,
    }),
  );
  response.status(500).type("application/problem+json").json({
    requestId,
    status: 500,
    title: "Request failed",
    type: "about:blank",
  });
};

function requestIdFor(response: Response): string {
  const candidate: unknown = (response.locals as Record<string, unknown>)
    .requestId;
  return typeof candidate === "string" ? candidate : randomUUID();
}
