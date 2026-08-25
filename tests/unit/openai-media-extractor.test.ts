import { describe, expect, it } from "vitest";

import { OpenAICompatibleMediaExtractor } from "#src/modules/imports/openai-media-extractor.server";

describe("OpenAI-compatible import media extractor", () => {
  it("sends bounded image and PDF requests without redirects", async () => {
    const requests: Array<{ init?: RequestInit; url: string }> = [];
    const request = ((input: URL | RequestInfo, init?: RequestInit) => {
      const url =
        input instanceof URL
          ? input.href
          : typeof input === "string"
            ? input
            : input.url;
      requests.push({ init, url });
      if (url.endsWith("/v1/responses")) {
        return Promise.resolve(
          Response.json({ output_text: "PDF recipe text" }),
        );
      }
      return Promise.resolve(
        Response.json({
          choices: [{ message: { content: "Image recipe text" } }],
        }),
      );
    }) as typeof fetch;
    const extractor = new OpenAICompatibleMediaExtractor(
      {
        apiKey: "test-key",
        baseUrl: "http://provider.test/api/",
        model: "vision-model",
      },
      request,
    );

    await expect(
      extractor.extract({
        bytes: new Uint8Array([1, 2, 3]),
        fileName: "card.png",
        kind: "image",
        mimeType: "image/png",
      }),
    ).resolves.toBe("Image recipe text");
    await expect(
      extractor.extract({
        bytes: new Uint8Array([4, 5, 6]),
        fileName: "recipe.pdf",
        kind: "pdf",
        mimeType: "application/pdf",
      }),
    ).resolves.toBe("PDF recipe text");

    expect(requests.map((item) => item.url)).toEqual([
      "http://provider.test/api/v1/chat/completions",
      "http://provider.test/api/v1/responses",
    ]);
    for (const item of requests) {
      expect(item.init?.redirect).toBe("error");
      expect(new Headers(item.init?.headers).get("authorization")).toBe(
        "Bearer test-key",
      );
    }
    const imageBody = requests[0]?.init?.body;
    const pdfBody = requests[1]?.init?.body;
    expect(typeof imageBody).toBe("string");
    expect(typeof pdfBody).toBe("string");
    expect(imageBody).toContain("data:image/png;base64,AQID");
    expect(pdfBody).toContain("data:application/pdf;base64,BAUG");
  });

  it("uses the explicit transcription model for audio and video containers", async () => {
    let form: FormData | undefined;
    const request = ((_input: URL | RequestInfo, init?: RequestInit) => {
      form = init?.body as FormData;
      return Promise.resolve(Response.json({ text: "Spoken recipe text" }));
    }) as typeof fetch;
    const extractor = new OpenAICompatibleMediaExtractor(
      {
        baseUrl: "http://provider.test/",
        model: "vision-model",
        transcriptionModel: "speech-model",
      },
      request,
    );

    await expect(
      extractor.extract({
        bytes: new Uint8Array([1, 2, 3]),
        fileName: "recipe.mp4",
        kind: "audio_video",
        mimeType: "video/mp4",
      }),
    ).resolves.toBe("Spoken recipe text");
    expect(form?.get("model")).toBe("speech-model");
    expect(form?.get("response_format")).toBe("json");
    expect(form?.get("file")).toMatchObject({
      name: "recipe.mp4",
      type: "video/mp4",
    });
  });
});
