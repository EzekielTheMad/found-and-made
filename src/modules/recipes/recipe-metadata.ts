export const RECIPE_TITLE_MAX_LENGTH = 300;
export const RECIPE_YIELD_MAX_LENGTH = 200;
export const RECIPE_CREATOR_MAX_LENGTH = 200;
export const RECIPE_SOURCE_URL_MAX_LENGTH = 2_048;
export const RECIPE_SHARED_NOTES_MAX_LENGTH = 20_000;

// These non-printing ranges can corrupt layout or visually spoof imported metadata.
const UNSAFE_SINGLE_LINE_CONTROLS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const UNSAFE_MULTILINE_CONTROLS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeRecipeTitle(value: string): string {
  return sanitizeSingleLine(value, RECIPE_TITLE_MAX_LENGTH);
}

export function sanitizeRecipeYield(value: string): string {
  return sanitizeSingleLine(value, RECIPE_YIELD_MAX_LENGTH);
}

export function sanitizeRecipeCreator(value?: string): string {
  return sanitizeSingleLine(value ?? "", RECIPE_CREATOR_MAX_LENGTH);
}

export function sanitizeRecipeSharedNotes(value?: string): string {
  const normalized = (value ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_MULTILINE_CONTROLS, " ");
  return [...normalized]
    .slice(0, RECIPE_SHARED_NOTES_MAX_LENGTH)
    .join("")
    .trim();
}

export function sanitizeSingleLine(value: string, maxLength: number): string {
  const normalized = value
    .normalize("NFC")
    .replace(UNSAFE_SINGLE_LINE_CONTROLS, " ")
    .replace(/\s+/gu, " ")
    .trim();

  // Count Unicode code points so truncation never leaves half of a surrogate pair.
  return [...normalized].slice(0, maxLength).join("").trim();
}
