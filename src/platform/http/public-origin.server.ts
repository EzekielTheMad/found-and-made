export function publicOriginFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.PUBLIC_ORIGIN?.trim();
  if (!configured) throw new Error("PUBLIC_ORIGIN is required");

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be an absolute HTTP or HTTPS origin");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PUBLIC_ORIGIN must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("PUBLIC_ORIGIN must not include credentials");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(
      "PUBLIC_ORIGIN must not include a path, query, or fragment",
    );
  }

  return url.origin;
}

export function publicUrl(
  pathname: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) {
    throw new Error("Public URL paths must be root-relative");
  }
  return new URL(pathname, `${publicOriginFromEnv(env)}/`).toString();
}
