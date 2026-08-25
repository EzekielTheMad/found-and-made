import { readFile } from "node:fs/promises";

import { appRuntimeContext } from "~/context";

import type { Route } from "./+types/cookbook-pdf";

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const runtime = context.get(appRuntimeContext);
  const principal = await runtime.sessionService.requireUser(request);
  const job = runtime.printingService.getPrintJob(principal, params.jobId);
  if (job.status !== "completed" || !job.artifact) {
    return Response.json(
      { error: "The print artifact is not ready." },
      { status: 404 },
    );
  }
  const path = runtime.printingService.resolveArtifactPath(
    job.artifact.relativePath,
  );
  return new Response(await readFile(path), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="found-and-made-${job.id}.pdf"`,
      "Content-Type": "application/pdf",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
