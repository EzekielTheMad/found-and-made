import type {
  ImportMediaExtractionInput,
  ImportMediaTextExtractor,
} from "./import.types";

interface OpenAICompatibleMediaExtractorConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  transcriptionModel?: string;
}

type FetchLike = typeof fetch;

const MAX_PROVIDER_BYTES = 25 * 1024 * 1024;

export class OpenAICompatibleMediaExtractor implements ImportMediaTextExtractor {
  public readonly id: string;

  public constructor(
    private readonly config: OpenAICompatibleMediaExtractorConfig,
    private readonly request: FetchLike = fetch,
  ) {
    validateConfig(config);
    this.id = `openai-compatible-media:${config.model}`;
  }

  public async extract(input: ImportMediaExtractionInput): Promise<string> {
    if (input.bytes.byteLength > MAX_PROVIDER_BYTES) {
      throw new Error("Media extraction provider inputs are limited to 25 MiB");
    }
    if (input.kind === "image") return this.extractImage(input);
    if (input.kind === "pdf") return this.extractPdf(input);
    return this.transcribe(input);
  }

  private async extractImage(
    input: ImportMediaExtractionInput,
  ): Promise<string> {
    const response = await this.postJson("v1/chat/completions", {
      max_tokens: 8_000,
      messages: [
        {
          content: [
            {
              text: extractionPrompt(),
              type: "text",
            },
            {
              image_url: {
                url: dataUrl(input.mimeType, input.bytes),
              },
              type: "image_url",
            },
          ],
          role: "user",
        },
      ],
      model: this.config.model,
      temperature: 0,
    });
    const envelope = asRecord(response);
    const choices = Array.isArray(envelope.choices) ? envelope.choices : [];
    const message = asRecord(asRecord(choices[0]).message);
    return textContent(message.content);
  }

  private async extractPdf(input: ImportMediaExtractionInput): Promise<string> {
    const response = await this.postJson("v1/responses", {
      input: [
        {
          content: [
            {
              text: extractionPrompt(),
              type: "input_text",
            },
            {
              file_data: dataUrl(input.mimeType, input.bytes),
              filename: input.fileName,
              type: "input_file",
            },
          ],
          role: "user",
        },
      ],
      model: this.config.model,
    });
    const envelope = asRecord(response);
    if (typeof envelope.output_text === "string") return envelope.output_text;
    const output: unknown[] = Array.isArray(envelope.output)
      ? (envelope.output as unknown[])
      : [];
    return output
      .flatMap((item) => {
        const content = asRecord(item).content;
        return Array.isArray(content) ? (content as unknown[]) : [];
      })
      .map((item) => asRecord(item).text)
      .filter((value): value is string => typeof value === "string")
      .join("\n");
  }

  private async transcribe(input: ImportMediaExtractionInput): Promise<string> {
    if (!this.config.transcriptionModel) {
      throw new Error("IMPORT_OPENAI_TRANSCRIPTION_MODEL is not configured");
    }
    const endpoint = new URL(
      "v1/audio/transcriptions",
      ensureTrailingSlash(this.config.baseUrl),
    );
    const form = new FormData();
    form.set(
      "file",
      new File([Buffer.from(input.bytes)], input.fileName, {
        type: input.mimeType,
      }),
    );
    form.set("model", this.config.transcriptionModel);
    form.set("response_format", "json");
    const response = await this.request(endpoint, {
      body: form,
      headers: this.authorizationHeaders(),
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 60_000),
    });
    if (!response.ok)
      throw new Error(
        `Media extraction provider returned HTTP ${response.status}`,
      );
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) return response.text();
    const body = asRecord(await response.json());
    return typeof body.text === "string" ? body.text : "";
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const endpoint = new URL(path, ensureTrailingSlash(this.config.baseUrl));
    const response = await this.request(endpoint, {
      body: JSON.stringify(body),
      headers: {
        ...this.authorizationHeaders(),
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 60_000),
    });
    if (!response.ok)
      throw new Error(
        `Media extraction provider returned HTTP ${response.status}`,
      );
    return response.json();
  }

  private authorizationHeaders(): Record<string, string> {
    return this.config.apiKey
      ? { authorization: `Bearer ${this.config.apiKey}` }
      : {};
  }
}

export function openAIImportMediaExtractorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  request?: FetchLike,
): OpenAICompatibleMediaExtractor | null {
  const baseUrl = env.IMPORT_OPENAI_BASE_URL?.trim();
  const model = env.IMPORT_OPENAI_MODEL?.trim();
  if (!baseUrl && !model) return null;
  if (!baseUrl || !model)
    throw new Error(
      "IMPORT_OPENAI_BASE_URL and IMPORT_OPENAI_MODEL must be configured together",
    );
  return new OpenAICompatibleMediaExtractor(
    {
      apiKey: env.IMPORT_OPENAI_API_KEY?.trim() || undefined,
      baseUrl,
      model,
      transcriptionModel:
        env.IMPORT_OPENAI_TRANSCRIPTION_MODEL?.trim() || undefined,
    },
    request,
  );
}

function extractionPrompt(): string {
  return "Transcribe all visible recipe text exactly, preserving the title, yield, ingredient lines, headings, and numbered instructions. Return plain text only. Do not invent missing content.";
}

function dataUrl(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => asRecord(item).text)
    .filter((item): item is string => typeof item === "string")
    .join("\n");
}

function validateConfig(config: OpenAICompatibleMediaExtractorConfig): void {
  const url = new URL(config.baseUrl);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("OpenAI-compatible provider URL must use HTTP or HTTPS");
  if (!config.model.trim()) throw new Error("Import media model is required");
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
