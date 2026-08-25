import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";

import { ImportAcquisitionService } from "#src/modules/imports/import-acquisition.server";
import { ImportExtractionService } from "#src/modules/imports/import-extraction.server";
import type { ImportMediaTextExtractor } from "#src/modules/imports/import.types";
import {
  ensureDataPaths,
  resolveDataPaths,
} from "#src/platform/files/data-paths.server";
import { ImportUploadStore } from "#src/platform/files/import-upload.server";

describe("import media text extraction", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    for (const directory of cleanup.splice(0)) {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("extracts embedded recipe text from a bounded PDF locally", async () => {
    const directory = await mkdtemp(join(tmpdir(), "found-made-pdf-extract-"));
    cleanup.push(directory);
    const paths = resolveDataPaths(directory);
    await ensureDataPaths(paths);
    const uploads = new ImportUploadStore(paths);
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    const lines = [
      "Grandma's Tomato Soup",
      "Serves 4",
      "Ingredients",
      "2 cups tomatoes",
      "1 cup stock",
      "Instructions",
      "Simmer tomatoes and stock for 20 minutes.",
    ];
    lines.forEach((line, index) => {
      page.drawText(line, { font, size: 12, x: 50, y: 740 - index * 24 });
    });
    const stored = await uploads.store(
      new File([Buffer.from(await pdf.save())], "tomato-soup.pdf", {
        type: "application/pdf",
      }),
    );
    const acquired = await new ImportAcquisitionService().acquire({
      fileName: "tomato-soup.pdf",
      kind: "pdf",
      mimeType: "application/pdf",
      storageRef: stored.storageRef,
    });

    const extracted = await new ImportExtractionService(uploads).extract(
      acquired,
    );

    expect(extracted.extractedText).toContain("Grandma's Tomato Soup");
    expect(extracted.extractedText).toContain("2 cups tomatoes");
    expect(extracted.extractedText).toContain("Simmer tomatoes and stock");
    expect(extracted.warnings).toEqual([]);
  });

  it("uses the configured extractor for image, audio, and video files", async () => {
    const calls: string[] = [];
    const extractor: ImportMediaTextExtractor = {
      id: "test-extractor",
      extract(input) {
        calls.push(`${input.kind}:${input.mimeType}`);
        return Promise.resolve(
          "Recipe Card\nIngredients\n1 cup rice\nInstructions\nCook rice.",
        );
      },
    };
    const uploads = {
      read() {
        return Promise.resolve(new Uint8Array([1, 2, 3, 4]));
      },
    } as unknown as ImportUploadStore;
    const service = new ImportExtractionService(uploads, extractor);
    const acquisition = new ImportAcquisitionService();
    const sources = [
      {
        fileName: "card.png",
        kind: "image" as const,
        mimeType: "image/png",
        storageRef: "card.png",
      },
      {
        fileName: "voice.mp3",
        kind: "audio_video" as const,
        mediaType: "audio" as const,
        mimeType: "audio/mpeg",
        storageRef: "voice.mp3",
      },
      {
        fileName: "clip.mp4",
        kind: "audio_video" as const,
        mediaType: "video" as const,
        mimeType: "video/mp4",
        storageRef: "clip.mp4",
      },
    ];

    for (const source of sources) {
      const extracted = await service.extract(
        await acquisition.acquire(source),
      );
      expect(extracted.extractedText).toContain("1 cup rice");
    }
    expect(calls).toEqual([
      "image:image/png",
      "audio_video:audio/mpeg",
      "audio_video:video/mp4",
    ]);
  });

  it("preserves the file and returns an actionable warning when extraction is unavailable", async () => {
    const uploads = {
      read() {
        return Promise.resolve(new Uint8Array([1, 2, 3, 4]));
      },
    } as unknown as ImportUploadStore;
    const acquired = await new ImportAcquisitionService().acquire({
      fileName: "voice.mp3",
      kind: "audio_video",
      mediaType: "audio",
      mimeType: "audio/mpeg",
      storageRef: "voice.mp3",
    });
    const extracted = await new ImportExtractionService(uploads).extract(
      acquired,
    );
    expect(extracted.extractedText).toBe("");
    expect(extracted.fallback?.message).toContain("file is preserved");
    expect(extracted.warnings).toEqual([
      expect.objectContaining({ code: "media_extraction_failed" }),
    ]);
  });
});
