import type {
  AcquiredImport,
  ImportSource,
  PublicContentAcquirer,
} from "./import.types";

const blockedAcquirer: PublicContentAcquirer = {
  acquire() {
    return Promise.resolve({
      method: "blocked",
      reason: "No SSRF-safe public acquisition adapter is configured",
    });
  },
  acquireImage() {
    return Promise.resolve({
      reason: "No SSRF-safe public image adapter is configured",
      status: "blocked" as const,
    });
  },
};

export class ImportAcquisitionService {
  public constructor(
    private readonly publicContent: PublicContentAcquirer = blockedAcquirer,
  ) {}

  public async acquire(source: ImportSource): Promise<AcquiredImport> {
    switch (source.kind) {
      case "manual":
        return acquired(source, source.originalWording, "manual");
      case "pasted_text":
        return acquired(source, source.text, "user_material");
      case "migration_json": {
        const text = source.originalWording ?? JSON.stringify(source.payload);
        return acquired(source, text, "user_material");
      }
      case "image":
      case "pdf":
        return source.userText
          ? acquired(source, source.userText, "user_material")
          : pendingMediaExtraction(source);
      case "audio_video":
        return source.transcript
          ? acquired(source, source.transcript, "user_material")
          : pendingMediaExtraction(source);
      case "website":
        if (source.pastedText)
          return {
            ...acquired(source, source.pastedText, "user_material"),
            canonicalUrl: validatePublicUrl(source.url),
          };
        return this.acquirePublicUrl(source, source.url);
      case "social_url":
        if (source.caption)
          return {
            ...acquired(source, source.caption, "user_material"),
            canonicalUrl: validatePublicUrl(source.url),
          };
        return this.acquirePublicUrl(source, source.url);
    }
  }

  private async acquirePublicUrl(
    source: Extract<ImportSource, { kind: "social_url" | "website" }>,
    url: string,
  ): Promise<AcquiredImport> {
    const validatedUrl = validatePublicUrl(url);
    const result = await this.publicContent.acquire({
      preference: ["official_metadata", "public_page"],
      url: validatedUrl,
    });
    if (result.method !== "blocked") {
      return {
        canonicalUrl: result.canonicalUrl ?? validatedUrl,
        ...(result.heroImageUrl ? { heroImageUrl: result.heroImageUrl } : {}),
        method: result.method,
        originalWording: result.text,
        source,
        text: result.text,
        warnings: [],
      };
    }
    return {
      canonicalUrl: validatedUrl,
      fallback: {
        acceptedInputs: ["caption", "media", "pasted_text"],
        message:
          "The public source could not be acquired. Paste its caption or text, or supply media you have permission to use.",
      },
      method: "blocked",
      originalWording: validatedUrl,
      source,
      text: "",
      warnings: [
        {
          code: "blocked_source",
          message: result.reason,
          severity: "warning",
        },
      ],
    };
  }
}

function acquired(
  source: ImportSource,
  text: string,
  method: "manual" | "user_material",
): AcquiredImport {
  return {
    method,
    originalWording: text,
    source,
    text,
    warnings: [],
  };
}

function pendingMediaExtraction(
  source: Extract<ImportSource, { kind: "audio_video" | "image" | "pdf" }>,
): AcquiredImport {
  return {
    method: "user_material",
    originalWording: "",
    source,
    text: "",
    warnings: [],
  };
}

function validatePublicUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Import URLs must use HTTP or HTTPS");
  if (url.username || url.password)
    throw new Error("Import URLs cannot include credentials");
  url.hash = "";
  return url.toString();
}
