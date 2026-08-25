import { createClientId } from "~/client-id";

export interface PublicActionFailure {
  message: string;
  requestId: string;
}

/**
 * Redact unexpected action failures at the route boundary. Domain errors that
 * are intentionally safe for users must be handled before calling this helper.
 */
export function publicActionFailure(
  error: unknown,
  fallback: string,
): PublicActionFailure {
  const requestId = createClientId();
  const errorType = error instanceof Error ? error.name : "NonError";
  console.error(
    JSON.stringify({
      errorType,
      event: "route.action_failed",
      requestId,
    }),
  );
  return {
    message: `${fallback}. Reference: ${requestId}`,
    requestId,
  };
}
