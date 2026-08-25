import { extractText, getDocumentProxy } from "unpdf";

import type { ImportUploadStore } from "../../platform/files/import-upload.server";
import type {
  AcquiredImport,
  ExtractedImport,
  ImportMediaTextExtractor,
  ImportSource,
} from "./import.types";

const MAX_PDF_PAGES = 50;
const MAX_EXTRACTED_CHARACTERS = 200_000;
const EXTRACTION_TIMEOUT_MS = 30_000;

export class ImportExtractionService {
  public constructor(
    private readonly uploads?: ImportUploadStore,
    private readonly mediaExtractor?: ImportMediaTextExtractor,
  ) {}

  public async extract(acquired: AcquiredImport): Promise<ExtractedImport> {
    if (acquired.text.trim()) {
      return { ...acquired, extractedText: acquired.text };
    }
    if (!isMediaSource(acquired.source)) {
      return { ...acquired, extractedText: "" };
    }
    if (!this.uploads)
      return unavailable(acquired, "Import upload storage is unavailable");

    try {
      const bytes = await this.uploads.read(acquired.source.storageRef);
      let text = "";
      if (acquired.source.kind === "pdf") {
        text = await extractPdfText(bytes).catch(() => "");
      }
      if (!text.trim() && this.mediaExtractor) {
        text = await withTimeout(
          this.mediaExtractor.extract({
            bytes,
            fileName: acquired.source.fileName,
            kind: acquired.source.kind,
            mimeType: mediaMimeType(acquired.source),
          }),
          EXTRACTION_TIMEOUT_MS,
        );
      }
      const bounded = [...text.normalize("NFC")]
        .slice(0, MAX_EXTRACTED_CHARACTERS)
        .join("")
        .trim();
      if (!bounded) {
        return unavailable(
          acquired,
          this.mediaExtractor
            ? "No recipe text could be extracted from the supplied file"
            : "Configure an OpenAI-compatible media extractor or add text manually",
        );
      }
      return {
        ...acquired,
        extractedText: bounded,
        originalWording: bounded,
        text: bounded,
      };
    } catch {
      return unavailable(
        acquired,
        "Media text extraction could not be completed",
      );
    }
  }
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const document = await withTimeout(
    getDocumentProxy(bytes, { maxImageSize: 16_777_216 }),
    EXTRACTION_TIMEOUT_MS,
  );
  try {
    if (document.numPages > MAX_PDF_PAGES) {
      throw new Error(`PDF imports are limited to ${MAX_PDF_PAGES} pages`);
    }
    const result = await withTimeout(
      extractText(document, { mergePages: true }),
      EXTRACTION_TIMEOUT_MS,
    );
    return result.text;
  } finally {
    await document.cleanup();
    const managed = document as typeof document & {
      loadingTask?: { destroy(): Promise<void> };
    };
    await managed.loadingTask?.destroy();
  }
}

function unavailable(
  acquired: AcquiredImport,
  message: string,
): ExtractedImport {
  return {
    ...acquired,
    extractedText: "",
    fallback: {
      acceptedInputs: ["caption", "pasted_text"],
      message:
        "The supplied file is preserved. Add recipe text, a transcript, or a caption if automatic extraction is unavailable.",
    },
    warnings: [
      ...acquired.warnings,
      {
        code: "media_extraction_failed",
        message,
        severity: "warning",
      },
    ],
  };
}

function isMediaSource(
  source: ImportSource,
): source is Extract<ImportSource, { kind: "audio_video" | "image" | "pdf" }> {
  return ["audio_video", "image", "pdf"].includes(source.kind);
}

function mediaMimeType(
  source: Extract<ImportSource, { kind: "audio_video" | "image" | "pdf" }>,
): string {
  if (source.kind === "pdf") return "application/pdf";
  if (source.kind === "image") return source.mimeType;
  return (
    source.mimeType ??
    (source.mediaType === "audio" ? "audio/mpeg" : "video/mp4")
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Extraction timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
