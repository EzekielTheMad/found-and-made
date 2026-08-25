import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

import type {
  PublicContentAcquirer as PublicContentAcquirerContract,
  PublicContentAcquisitionRequest,
  PublicContentAcquisitionResult,
  PublicImageAcquisitionResult,
} from "../../modules/imports/import.types";

export interface PublicContentAcquirerOptions {
  byteLimit?: number;
  fetchTransport?: PublicContentFetchTransport;
  imageByteLimit?: number;
  maxRedirects?: number;
  resolver?: PublicAddressResolver;
  timeoutMs?: number;
}

export type PublicAddressResolver = (
  hostname: string,
) => Promise<readonly string[]>;

export type PublicContentFetchTransport = (
  url: string,
  init: RequestInit,
  target: ValidatedPublicTarget,
) => Promise<Response>;

export interface ValidatedPublicTarget {
  address: string;
  hostname: string;
}

const defaultByteLimit = 2 * 1024 * 1024;
const defaultImageByteLimit = 20 * 1024 * 1024;
const defaultRedirects = 3;
const defaultTimeoutMs = 10_000;
const acceptedContentTypes = [
  "text/html",
  "application/json",
  "application/ld+json",
];

/**
 * Public, cookie-free acquisition boundary for URL imports. It validates DNS
 * answers before every request hop and follows redirects itself so each target
 * receives the same SSRF checks.
 */
export class PublicContentAcquirer implements PublicContentAcquirerContract {
  private readonly byteLimit: number;
  private readonly fetchTransport: PublicContentFetchTransport;
  private readonly imageByteLimit: number;
  private readonly maxRedirects: number;
  private readonly resolver: PublicAddressResolver;
  private readonly timeoutMs: number;

  public constructor(options: PublicContentAcquirerOptions = {}) {
    this.byteLimit = positiveInteger(
      options.byteLimit ?? defaultByteLimit,
      "byteLimit",
    );
    this.maxRedirects = nonNegativeInteger(
      options.maxRedirects ?? defaultRedirects,
      "maxRedirects",
    );
    this.imageByteLimit = positiveInteger(
      options.imageByteLimit ?? defaultImageByteLimit,
      "imageByteLimit",
    );
    this.timeoutMs = positiveInteger(
      options.timeoutMs ?? defaultTimeoutMs,
      "timeoutMs",
    );
    this.fetchTransport = options.fetchTransport ?? nodeFetchTransport;
    this.resolver = options.resolver ?? resolvePublicAddresses;
  }

  public async acquire(
    request: PublicContentAcquisitionRequest,
  ): Promise<PublicContentAcquisitionResult> {
    try {
      let url = parsePublicUrl(request.url);
      for (let redirect = 0; redirect <= this.maxRedirects; redirect += 1) {
        const target = await this.assertPublicTarget(url);
        const response = await this.request(url, target);
        if (isRedirect(response.status)) {
          if (redirect === this.maxRedirects)
            return blocked("Public redirects were blocked");
          const location = response.headers.get("location");
          if (!location) return blocked("Public content was unavailable");
          url = parsePublicUrl(new URL(location, url).toString());
          continue;
        }
        if (!response.ok) return blocked("Public content was unavailable");
        const contentType = contentTypeOf(response.headers.get("content-type"));
        if (!isAcceptedContentType(contentType))
          return blocked("Public content type was blocked");
        const text = await readCappedText(response, this.byteLimit);
        const recipeMetadata = request.preference.includes("official_metadata")
          ? contentType === "text/html"
            ? recipeJsonLd(text)
            : isJsonContentType(contentType)
              ? recipeJsonDocument(text)
              : undefined
          : undefined;
        const heroImageUrl =
          contentType === "text/html" || recipeMetadata?.image
            ? publicImageUrl(recipeMetadata?.image, text, url)
            : undefined;
        return {
          canonicalUrl: url.toString(),
          ...(heroImageUrl ? { heroImageUrl } : {}),
          method:
            recipeMetadata || isJsonContentType(contentType)
              ? "official_metadata"
              : "public_page",
          text:
            recipeMetadata?.text ??
            (contentType === "text/html" ? visiblePageText(text) : text),
        };
      }
      return blocked("Public redirects were blocked");
    } catch (error) {
      return blocked(reasonFor(error));
    }
  }

  public async acquireImage(
    urlValue: string,
  ): Promise<PublicImageAcquisitionResult> {
    try {
      let url = parsePublicUrl(urlValue);
      for (let redirect = 0; redirect <= this.maxRedirects; redirect += 1) {
        const target = await this.assertPublicTarget(url);
        const response = await this.request(
          url,
          target,
          "image/avif,image/webp,image/png,image/jpeg;q=0.9",
        );
        if (isRedirect(response.status)) {
          if (redirect === this.maxRedirects)
            return blockedImage("Image redirects were blocked");
          const location = response.headers.get("location");
          if (!location) return blockedImage("Recipe image was unavailable");
          url = parsePublicUrl(new URL(location, url).toString());
          continue;
        }
        if (!response.ok) return blockedImage("Recipe image was unavailable");
        const mimeType = imageContentType(
          contentTypeOf(response.headers.get("content-type")),
        );
        if (!mimeType) return blockedImage("Recipe image type was blocked");
        return {
          bytes: await readCappedBytes(response, this.imageByteLimit),
          mimeType,
        };
      }
      return blockedImage("Image redirects were blocked");
    } catch (error) {
      return blockedImage(reasonFor(error));
    }
  }

  private async assertPublicTarget(url: URL): Promise<ValidatedPublicTarget> {
    const hostname = normalizedHostname(url.hostname);
    if (hostname === "localhost" || hostname.endsWith(".localhost"))
      throw new PublicContentBlockedError();
    const literalVersion = isIP(hostname);
    const addresses = literalVersion
      ? [hostname]
      : await this.resolver(hostname);
    if (
      !addresses.length ||
      addresses.some((address) => !isPublicAddress(address))
    ) {
      throw new PublicContentBlockedError();
    }
    return { address: addresses[0], hostname };
  }

  private async request(
    url: URL,
    target: ValidatedPublicTarget,
    accept = "text/html, application/ld+json, application/json;q=0.9",
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchTransport(
        url.toString(),
        {
          credentials: "omit",
          headers: {
            accept,
          },
          redirect: "manual",
          signal: controller.signal,
        },
        target,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createPublicContentAcquirer(
  options?: PublicContentAcquirerOptions,
): PublicContentAcquirer {
  return new PublicContentAcquirer(options);
}

export async function resolvePublicAddresses(
  hostname: string,
): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/** Pins a request to a validated IP while retaining the URL hostname for Host,
 * TLS SNI, and certificate validation. */
export function nodeFetchTransport(
  url: string,
  init: RequestInit,
  target: ValidatedPublicTarget,
): Promise<Response> {
  const parsed = new URL(url);
  const client = parsed.protocol === "https:" ? https : http;
  return new Promise<Response>((resolve, reject) => {
    const request = client.request(
      parsed,
      {
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        lookup(_hostname, options, callback) {
          const family = isIP(target.address);
          if (typeof options === "object" && options.all) {
            callback(null, [{ address: target.address, family }]);
          } else {
            callback(null, target.address, family);
          }
        },
        method: "GET",
        signal: init.signal ?? undefined,
      },
      (response) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) headers.set(key, value.join(", "));
          else if (value !== undefined) headers.set(key, String(value));
        }
        resolve(
          new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
            headers,
            status: response.statusCode ?? 502,
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version !== 6) return false;
  const mapped = mappedIpv4(address);
  if (mapped) return isPublicIpv4(mapped);
  const normalized = expandIpv6(address);
  if (!normalized) return false;
  const first = normalized[0];
  const second = normalized[1];
  if (
    normalized.every((part) => part === 0) ||
    normalized.every((part, index) => (index === 7 ? part === 1 : part === 0))
  )
    return false;
  if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // link local fe80::/10
  if ((first & 0xff00) === 0xff00) return false; // multicast ff00::/8
  if (first === 0x2001 && second === 0x0db8) return false; // documentation
  if (
    first === 0x0100 &&
    normalized[1] === 0 &&
    normalized[2] === 0 &&
    normalized[3] === 0
  ) {
    return false; // discard-only 100::/64
  }
  if (first === 0x2001 && (second & 0xfff0) === 0x0020) return false; // ORCHID
  const embedded = embeddedIpv4(normalized);
  if (embedded && !isPublicIpv4(embedded)) return false;
  return true;
}

function parsePublicUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicContentBlockedError();
  }
  if (
    !(url.protocol === "http:" || url.protocol === "https:") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new PublicContentBlockedError();
  }
  return url;
}

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  const [a, b, c] = parts;
  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  ) {
    return false;
  }
  return true;
}

function mappedIpv4(address: string): string | undefined {
  const dotted = normalizedHostname(address).match(
    /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i,
  );
  if (dotted?.[1]) return dotted[1];
  const expanded = expandIpv6(address);
  if (!expanded) return undefined;
  const prefix = expanded.slice(0, 5).every((part) => part === 0);
  const mapped = expanded[5] === 0xffff || expanded[5] === 0;
  if (!prefix || !mapped) return undefined;
  return `${expanded[6] >> 8}.${expanded[6] & 255}.${expanded[7] >> 8}.${expanded[7] & 255}`;
}

function expandIpv6(address: string): number[] | undefined {
  const value = normalizedHostname(address);
  const [before, after] = value.split("::");
  if (value.split("::").length > 2) return undefined;
  const left = before ? before.split(":") : [];
  const right = after ? after.split(":") : [];
  const parts = [...left, ...right];
  if (parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return undefined;
  if (value.includes("::")) {
    const missing = 8 - parts.length;
    if (missing < 1) return undefined;
    return [...left, ...Array<number>(missing).fill(0), ...right].map((part) =>
      typeof part === "number" ? part : Number.parseInt(part, 16),
    );
  }
  return parts.length === 8
    ? parts.map((part) => Number.parseInt(part, 16))
    : undefined;
}

function embeddedIpv4(parts: number[]): string | undefined {
  if (parts[0] === 0x2002) {
    return `${parts[1] >> 8}.${parts[1] & 255}.${parts[2] >> 8}.${parts[2] & 255}`;
  }
  if (parts[0] === 0x2001 && parts[1] === 0) {
    const high = parts[6] ^ 0xffff;
    const low = parts[7] ^ 0xffff;
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return undefined;
}

async function readCappedText(
  response: Response,
  byteLimit: number,
): Promise<string> {
  return new TextDecoder().decode(await readCappedBytes(response, byteLimit));
}

async function readCappedBytes(
  response: Response,
  byteLimit: number,
): Promise<Uint8Array> {
  const headerLength = response.headers.get("content-length");
  if (headerLength && Number(headerLength) > byteLimit)
    throw new PublicContentBlockedError();
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > byteLimit) {
        await reader.cancel();
        throw new PublicContentBlockedError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const content = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function contentTypeOf(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isAcceptedContentType(value: string): boolean {
  return acceptedContentTypes.includes(value) || /\+json$/.test(value);
}

function isJsonContentType(value: string): boolean {
  return (
    value === "application/json" ||
    value === "application/ld+json" ||
    /\+json$/.test(value)
  );
}

function recipeJsonLd(
  html: string,
): { image?: string; text: string } | undefined {
  const scripts = html.matchAll(
    /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi,
  );
  const recipes: unknown[] = [];
  for (const script of scripts) {
    const payload = script[1];
    if (!payload || payload.length > 256 * 1024) continue;
    const parsed = parseRecipeDocument(payload);
    if (parsed) collectRecipes(parsed, recipes);
  }
  return recipeMetadata(recipes);
}

function recipeJsonDocument(
  payload: string,
): { image?: string; text: string } | undefined {
  const parsed = parseRecipeDocument(payload);
  if (!parsed) return undefined;
  const recipes: unknown[] = [];
  collectRecipes(parsed, recipes);
  return recipeMetadata(recipes);
}

function parseRecipeDocument(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

function recipeMetadata(
  recipes: unknown[],
): { image?: string; text: string } | undefined {
  if (!recipes.length) return undefined;
  const document = recipes.length === 1 ? recipes[0] : recipes;
  const first = recipes[0] as Record<string, unknown> | undefined;
  const image = first ? imageReference(first.image) : undefined;
  return {
    ...(image ? { image } : {}),
    text: JSON.stringify(document),
  };
}

function collectRecipes(value: unknown, recipes: unknown[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRecipes(item, recipes);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  const isRecipe =
    (typeof type === "string" && type.toLowerCase() === "recipe") ||
    (Array.isArray(type) &&
      type.some(
        (item) => typeof item === "string" && item.toLowerCase() === "recipe",
      ));
  if (isRecipe) recipes.push(record);
  if (record["@graph"]) collectRecipes(record["@graph"], recipes);
}

function visiblePageText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function imageReference(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = imageReference(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return imageReference(record.url ?? record.contentUrl);
}

function publicImageUrl(
  metadataImage: string | undefined,
  html: string,
  pageUrl: URL,
): string | undefined {
  const reference = metadataImage ?? socialImageReference(html);
  if (!reference) return undefined;
  try {
    const resolved = new URL(reference, pageUrl);
    resolved.hash = "";
    return parsePublicUrl(resolved.toString()).toString();
  } catch {
    return undefined;
  }
}

function socialImageReference(html: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(
      /([a-zA-Z_:][\w:.-]*)\s*=\s*["']([^"']*)["']/g,
    )) {
      attributes.set(match[1]?.toLowerCase() ?? "", match[2] ?? "");
    }
    const key = (
      attributes.get("property") ??
      attributes.get("name") ??
      ""
    ).toLowerCase();
    if (["og:image", "og:image:url", "twitter:image"].includes(key)) {
      const content = attributes.get("content")?.trim();
      if (content) return decodeEntities(content);
    }
  }
  return undefined;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function blocked(reason: string): PublicContentAcquisitionResult {
  return { method: "blocked", reason };
}

function blockedImage(reason: string): PublicImageAcquisitionResult {
  return { reason, status: "blocked" };
}

function imageContentType(
  value: string,
): "image/jpeg" | "image/png" | "image/webp" | undefined {
  if (value === "image/jpg" || value === "image/jpeg") return "image/jpeg";
  if (value === "image/png" || value === "image/webp") return value;
  return undefined;
}

function reasonFor(error: unknown): string {
  if (error instanceof PublicContentBlockedError)
    return "Public content was blocked";
  return "Public content was unavailable";
}

class PublicContentBlockedError extends Error {}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
}
