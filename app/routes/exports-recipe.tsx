import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/exports-recipe";

export async function action({ context, params, request }: Route.ActionArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const form = await request.formData();
  try {
    const result = runtime.exportService.exportRecipeJson(
      principal,
      params.recipeId,
      individualExportOptions(form),
    );
    return new Response(`${JSON.stringify(result.dto, null, 2)}\n`, {
      headers: downloadHeaders(result.artifactName),
    });
  } catch {
    return Response.json(
      { error: "Recipe export failed" },
      {
        headers: { "Cache-Control": "private, no-store" },
        status: 400,
      },
    );
  }
}

export function individualExportOptions(form: FormData): {
  targetYield?: number;
  unitPreference: "as-written" | "metric";
} {
  const targetText = field(form, "targetYield");
  const targetYield = targetText ? Number(targetText) : undefined;
  if (
    targetYield !== undefined &&
    (!Number.isFinite(targetYield) || targetYield <= 0)
  )
    throw new Error("Target servings must be a positive number");
  return {
    ...(targetYield === undefined ? {} : { targetYield }),
    unitPreference:
      field(form, "unitPreference") === "metric" ? "metric" : "as-written",
  };
}

export function downloadHeaders(artifactName: string): HeadersInit {
  if (!/^recipe-[0-9a-f-]{36}\.json$/i.test(artifactName))
    throw new Error("Recipe export artifact name is invalid");
  return {
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="${artifactName}"`,
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  };
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}
