import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from "express";

export function toWebRequest(
  request: ExpressRequest,
  parsedBody?: unknown,
): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const protocol = request.protocol;
  const host = request.get("host") ?? "localhost";
  const url = new URL(request.originalUrl, `${protocol}://${host}`);
  const method = request.method.toUpperCase();
  const body =
    method === "GET" || method === "HEAD" || parsedBody === undefined
      ? undefined
      : JSON.stringify(parsedBody);

  return new Request(url, {
    ...(body === undefined ? {} : { body }),
    headers,
    method,
  });
}

export async function sendWebResponse(
  webResponse: Response,
  response: ExpressResponse,
): Promise<void> {
  response.status(webResponse.status);
  webResponse.headers.forEach((value, name) => response.setHeader(name, value));

  if (!webResponse.body) {
    response.end();
    return;
  }

  await pipeline(
    Readable.fromWeb(webResponse.body as NodeReadableStream<Uint8Array>),
    response,
  );
}
