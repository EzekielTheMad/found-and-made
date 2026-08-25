import type {
  ImportModelInput,
  ImportModelProvider,
  StructuredRecipeCandidate,
} from "./import.types";
import { sanitizeRecipeCreator } from "../recipes/recipe-metadata";

export interface OpenAICompatibleImportProviderConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

type FetchLike = typeof fetch;

export class OpenAICompatibleImportProvider implements ImportModelProvider {
  public readonly id: string;

  public constructor(
    private readonly config: OpenAICompatibleImportProviderConfig,
    private readonly request: FetchLike = fetch,
  ) {
    validateConfig(config);
    this.id = `openai-compatible:${config.model}`;
  }

  public async structure(
    input: ImportModelInput,
  ): Promise<StructuredRecipeCandidate> {
    const endpoint = new URL(
      "v1/chat/completions",
      ensureTrailingSlash(this.config.baseUrl),
    );
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.config.apiKey)
      headers.authorization = `Bearer ${this.config.apiKey}`;

    const response = await this.request(endpoint, {
      body: JSON.stringify({
        messages: [
          {
            content:
              "Return only JSON with title, baseYield, yieldText, optional creatorName, ingredients (sourceText, quantityText, name, optional brand and brandIdentitySensitive), and steps. Preserve source wording in sourceText. Include creatorName only when the source explicitly identifies the recipe author or creator. Do not invent missing facts.",
            role: "system",
          },
          {
            content: `Source kind: ${input.source.kind}\n\n${input.sourceText}`,
            role: "user",
          },
        ],
        model: this.config.model,
        response_format: { type: "json_object" },
        temperature: 0,
      }),
      headers,
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
    });
    if (!response.ok)
      throw new Error(`Import provider returned HTTP ${response.status}`);
    return parseCandidate(await response.json());
  }
}

export function openAIImportProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  request?: FetchLike,
): OpenAICompatibleImportProvider | null {
  const baseUrl = env.IMPORT_OPENAI_BASE_URL?.trim();
  const model = env.IMPORT_OPENAI_MODEL?.trim();
  if (!baseUrl && !model) return null;
  if (!baseUrl || !model)
    throw new Error(
      "IMPORT_OPENAI_BASE_URL and IMPORT_OPENAI_MODEL must be configured together",
    );
  return new OpenAICompatibleImportProvider(
    {
      apiKey: env.IMPORT_OPENAI_API_KEY?.trim() || undefined,
      baseUrl,
      model,
    },
    request,
  );
}

function parseCandidate(value: unknown): StructuredRecipeCandidate {
  const envelope = asRecord(value);
  const choices = Array.isArray(envelope.choices) ? envelope.choices : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first.message);
  const content = message.content;
  if (typeof content !== "string")
    throw new Error("Import provider response did not contain JSON content");
  const parsed = asRecord(
    JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")),
  );
  const ingredients = Array.isArray(parsed.ingredients)
    ? parsed.ingredients.map((value) => {
        const item = asRecord(value);
        const name = requiredString(item.name, "ingredient name");
        const sourceText = requiredString(
          item.sourceText,
          "ingredient sourceText",
        );
        return {
          ...(typeof item.brand === "string" ? { brand: item.brand } : {}),
          ...(typeof item.brandIdentitySensitive === "boolean"
            ? { brandIdentitySensitive: item.brandIdentitySensitive }
            : {}),
          ...(typeof item.component === "string"
            ? { component: item.component }
            : {}),
          ...(typeof item.confidence === "number"
            ? { confidence: item.confidence }
            : {}),
          name,
          quantityText:
            typeof item.quantityText === "string"
              ? item.quantityText
              : "as needed",
          sourceText,
        };
      })
    : [];
  const steps = Array.isArray(parsed.steps)
    ? parsed.steps.filter((step): step is string => typeof step === "string")
    : [];
  const baseYield =
    typeof parsed.baseYield === "number" && parsed.baseYield > 0
      ? parsed.baseYield
      : 1;
  const creatorName = sanitizeRecipeCreator(
    typeof parsed.creatorName === "string" ? parsed.creatorName : undefined,
  );
  return {
    baseYield,
    ...(Array.isArray(parsed.components)
      ? {
          components: parsed.components.filter(
            (component): component is string => typeof component === "string",
          ),
        }
      : {}),
    ingredients,
    ...(creatorName ? { creatorName } : {}),
    steps,
    title: requiredString(parsed.title, "title"),
    yieldText:
      typeof parsed.yieldText === "string"
        ? parsed.yieldText
        : `${baseYield} servings`,
  };
}

function validateConfig(config: OpenAICompatibleImportProviderConfig): void {
  const url = new URL(config.baseUrl);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("OpenAI-compatible provider URL must use HTTP or HTTPS");
  if (!config.model.trim())
    throw new Error("Import provider model is required");
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Import provider response requires ${field}`);
  return value.trim();
}
