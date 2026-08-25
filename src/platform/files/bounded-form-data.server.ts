const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");
const MAX_HEADER_BYTES = 16 * 1024;

export interface BoundedFormDataLimits {
  maxBodyBytes: number;
  maxFieldBytes: number;
  maxFields: number;
  maxFileBytes: number;
  maxFiles: number;
  maxParts: number;
}

export class BoundedFormDataError extends Error {
  public constructor(
    message: string,
    public readonly status: 400 | 413 = 400,
  ) {
    super(message);
    this.name = "BoundedFormDataError";
  }
}

/**
 * Parses browser form submissions without allowing Request.formData() to buffer
 * an unbounded body. Multipart boundaries and each part are processed as bytes
 * arrive; only accepted parts within the configured caps are retained in memory.
 */
export async function parseBoundedFormData(
  request: Request,
  limits: BoundedFormDataLimits,
): Promise<FormData> {
  validateLimits(limits);
  let declaredLength: number | undefined;
  try {
    declaredLength = declaredContentLength(request);
  } catch (error) {
    await cancelRequestBody(request);
    throw error;
  }
  if (declaredLength !== undefined && declaredLength > limits.maxBodyBytes) {
    await cancelRequestBody(request);
    throw tooLarge("Form request exceeds the allowed size");
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (/^multipart\/form-data(?:\s*;|\s*$)/i.test(contentType)) {
    let boundary: string;
    try {
      boundary = multipartBoundary(contentType);
    } catch (error) {
      await cancelRequestBody(request);
      throw error;
    }
    return parseMultipart(request, boundary, limits, declaredLength);
  }
  if (/^application\/x-www-form-urlencoded(?:\s*;|\s*$)/i.test(contentType)) {
    const bytes = await readBoundedBody(request, limits.maxBodyBytes);
    verifyDeclaredLength(declaredLength, bytes.byteLength);
    const params = new URLSearchParams(decodeUtf8(bytes, "Form body"));
    const form = new FormData();
    let count = 0;
    for (const [name, value] of params) {
      count += 1;
      if (count > limits.maxFields || count > limits.maxParts) {
        throw tooLarge("Form contains too many fields");
      }
      if (Buffer.byteLength(value) > limits.maxFieldBytes) {
        throw tooLarge(`Form field ${name || "(unnamed)"} is too large`);
      }
      form.append(name, value);
    }
    return form;
  }
  await cancelRequestBody(request);
  throw new BoundedFormDataError(
    "Expected multipart/form-data or application/x-www-form-urlencoded",
  );
}

async function cancelRequestBody(request: Request): Promise<void> {
  await request.body?.cancel().catch(() => undefined);
}

interface CurrentPart {
  chunks: Buffer[];
  fileName?: string;
  name: string;
  size: number;
  type: string;
}

type ParserState = "initial" | "headers" | "body" | "suffix" | "done";

async function parseMultipart(
  request: Request,
  boundary: string,
  limits: BoundedFormDataLimits,
  declaredLength: number | undefined,
): Promise<FormData> {
  if (!request.body) throw new BoundedFormDataError("Form request has no body");
  const reader = request.body.getReader();
  const form = new FormData();
  const opening = Buffer.from(`--${boundary}\r\n`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  let buffer = Buffer.alloc(0);
  let current: CurrentPart | undefined;
  let state: ParserState = "initial";
  let totalBytes = 0;
  let parts = 0;
  let fields = 0;
  let files = 0;
  let aborted = false;
  let rejectAbort: (reason?: unknown) => void = () => undefined;
  const onAbort = () => {
    aborted = true;
    rejectAbort(new BoundedFormDataError("Form request was aborted"));
  };
  const abortError = new Promise<never>((_, reject) => {
    rejectAbort = reject;
    if (request.signal.aborted) {
      onAbort();
      return;
    }
    request.signal.addEventListener("abort", onAbort, { once: true });
  });

  const appendBody = (bytes: Buffer) => {
    if (!current || bytes.byteLength === 0) return;
    current.size += bytes.byteLength;
    const maximum =
      current.fileName === undefined
        ? limits.maxFieldBytes
        : limits.maxFileBytes;
    if (current.size > maximum) {
      throw tooLarge(
        current.fileName === undefined
          ? `Form field ${current.name} is too large`
          : `Uploaded file ${current.name} exceeds the allowed size`,
      );
    }
    current.chunks.push(Buffer.from(bytes));
  };

  const finishPart = () => {
    if (!current) throw new BoundedFormDataError("Malformed multipart body");
    const value = Buffer.concat(current.chunks, current.size);
    if (current.fileName === undefined) {
      form.append(
        current.name,
        decodeUtf8(value, `Form field ${current.name}`),
      );
    } else {
      form.append(
        current.name,
        new File([value], safeFileName(current.fileName), {
          type: current.type,
        }),
      );
    }
    current = undefined;
  };

  const process = () => {
    while (true) {
      if (state === "initial") {
        if (buffer.byteLength < opening.byteLength) return;
        if (!buffer.subarray(0, opening.byteLength).equals(opening)) {
          throw new BoundedFormDataError(
            "Malformed multipart opening boundary",
          );
        }
        buffer = buffer.subarray(opening.byteLength);
        state = "headers";
        continue;
      }

      if (state === "headers") {
        const end = buffer.indexOf(HEADER_END);
        if (end < 0) {
          if (buffer.byteLength > MAX_HEADER_BYTES) {
            throw tooLarge("Multipart part headers are too large");
          }
          return;
        }
        parts += 1;
        if (parts > limits.maxParts) {
          throw tooLarge("Form contains too many parts");
        }
        const headers = parsePartHeaders(buffer.subarray(0, end));
        buffer = buffer.subarray(end + HEADER_END.byteLength);
        if (headers.fileName === undefined) {
          fields += 1;
          if (fields > limits.maxFields) {
            throw tooLarge("Form contains too many fields");
          }
        } else {
          files += 1;
          if (files > limits.maxFiles) {
            throw tooLarge("Form contains too many files");
          }
        }
        current = { chunks: [], size: 0, ...headers };
        state = "body";
        continue;
      }

      if (state === "body") {
        const end = buffer.indexOf(delimiter);
        if (end < 0) {
          const retain = delimiter.byteLength + 2;
          if (buffer.byteLength > retain) {
            const flushLength = buffer.byteLength - retain;
            appendBody(buffer.subarray(0, flushLength));
            buffer = buffer.subarray(flushLength);
          }
          return;
        }
        appendBody(buffer.subarray(0, end));
        buffer = buffer.subarray(end + delimiter.byteLength);
        finishPart();
        state = "suffix";
        continue;
      }

      if (state === "suffix") {
        if (buffer.byteLength < 2) return;
        if (buffer.subarray(0, 2).equals(CRLF)) {
          buffer = buffer.subarray(2);
          state = "headers";
          continue;
        }
        if (buffer[0] === 45 && buffer[1] === 45) {
          buffer = buffer.subarray(2);
          state = "done";
          continue;
        }
        throw new BoundedFormDataError("Malformed multipart boundary suffix");
      }

      if (state === "done") {
        if (buffer.byteLength === 0) return;
        if (buffer.byteLength === 1 && buffer[0] === CRLF[0]) return;
        if (buffer.equals(CRLF)) {
          buffer = Buffer.alloc(0);
          return;
        }
        throw new BoundedFormDataError("Unexpected data after multipart body");
      }
    }
  };

  try {
    while (true) {
      const result = await Promise.race([reader.read(), abortError]);
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > limits.maxBodyBytes) {
        throw tooLarge("Form request exceeds the allowed size");
      }
      buffer = Buffer.concat([buffer, Buffer.from(result.value)]);
      process();
    }
    process();
    if (aborted) throw new BoundedFormDataError("Form request was aborted");
    if ((state as ParserState) !== "done" || buffer.byteLength !== 0) {
      throw new BoundedFormDataError(
        "Multipart body ended before its closing boundary",
      );
    }
    verifyDeclaredLength(declaredLength, totalBytes);
    return form;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error instanceof BoundedFormDataError
      ? error
      : new BoundedFormDataError("Could not read multipart form body");
  } finally {
    request.signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function parsePartHeaders(bytes: Buffer): Omit<CurrentPart, "chunks" | "size"> {
  const raw = bytes.toString("latin1");
  const headers = new Map<string, string>();
  for (const line of raw.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0)
      throw new BoundedFormDataError("Malformed multipart headers");
    const name = line.slice(0, separator).trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(name) || headers.has(name)) {
      throw new BoundedFormDataError("Malformed multipart headers");
    }
    headers.set(name, line.slice(separator + 1).trim());
  }
  if (headers.has("content-transfer-encoding")) {
    throw new BoundedFormDataError(
      "Multipart transfer encoding is not supported",
    );
  }
  const disposition = headers.get("content-disposition");
  if (!disposition || !/^form-data(?:\s*;|\s*$)/i.test(disposition)) {
    throw new BoundedFormDataError(
      "Multipart part is missing form-data disposition",
    );
  }
  const name = dispositionParameter(disposition, "name");
  if (!name || name.length > 200 || /[\0\r\n]/.test(name)) {
    throw new BoundedFormDataError("Multipart part has an invalid field name");
  }
  const fileName = dispositionParameter(disposition, "filename");
  if (fileName !== undefined && /[\0\r\n]/.test(fileName)) {
    throw new BoundedFormDataError("Multipart file has an invalid filename");
  }
  return {
    ...(fileName === undefined ? {} : { fileName }),
    name,
    type:
      headers.get("content-type")?.split(";", 1)[0]?.trim() ||
      "application/octet-stream",
  };
}

function dispositionParameter(
  value: string,
  parameter: string,
): string | undefined {
  const expression = new RegExp(
    `(?:^|;)\\s*${parameter}=(?:"((?:\\\\.|[^"\\\\])*)"|([^;\\s]*))`,
    "i",
  );
  const match = expression.exec(value);
  const selected = match?.[1] ?? match?.[2];
  return selected?.replace(/\\(["\\])/g, "$1");
}

async function readBoundedBody(
  request: Request,
  maximum: number,
): Promise<Buffer> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      if (request.signal.aborted) {
        throw new BoundedFormDataError("Form request was aborted");
      }
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum)
        throw tooLarge("Form request exceeds the allowed size");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function multipartBoundary(contentType: string): string {
  const match = /(?:^|;)\s*boundary=(?:"([^"]*)"|([^;\s]*))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (
    !boundary ||
    boundary.length > 70 ||
    !/^[0-9A-Za-z'()+_,./:=? -]+$/.test(boundary) ||
    boundary.endsWith(" ")
  ) {
    throw new BoundedFormDataError("Multipart boundary is missing or invalid");
  }
  return boundary;
}

function declaredContentLength(request: Request): number | undefined {
  const value = request.headers.get("content-length");
  if (value === null) return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new BoundedFormDataError("Content-Length header is invalid");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new BoundedFormDataError("Content-Length header is invalid");
  }
  return length;
}

function verifyDeclaredLength(
  declared: number | undefined,
  actual: number,
): void {
  if (declared !== undefined && declared !== actual) {
    throw new BoundedFormDataError(
      "Content-Length does not match the request body",
    );
  }
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BoundedFormDataError(`${label} is not valid UTF-8`);
  }
}

function safeFileName(value: string): string {
  const name = value.split(/[\\/]/).at(-1) || "upload.bin";
  return name.slice(0, 255);
}

function tooLarge(message: string): BoundedFormDataError {
  return new BoundedFormDataError(message, 413);
}

function validateLimits(limits: BoundedFormDataLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error("Bounded form-data limits must be positive integers");
    }
  }
}
