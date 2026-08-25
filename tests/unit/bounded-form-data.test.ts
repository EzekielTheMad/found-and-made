import { describe, expect, it } from "vitest";

import {
  parseBoundedFormData,
  type BoundedFormDataLimits,
} from "#src/platform/files/bounded-form-data.server";

const limits: BoundedFormDataLimits = {
  maxBodyBytes: 2048,
  maxFieldBytes: 128,
  maxFields: 3,
  maxFileBytes: 256,
  maxFiles: 1,
  maxParts: 4,
};

describe("bounded form-data parser", () => {
  it("parses a chunked multipart body without Content-Length", async () => {
    const body = multipart([
      { name: "title", value: "Sunday pie" },
      {
        fileName: "photo.png",
        name: "image",
        type: "image/png",
        value: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      },
    ]);
    const request = streamRequest(body, { chunkSize: 3, chunked: true });

    const form = await parseBoundedFormData(request, limits);

    expect(form.get("title")).toBe("Sunday pie");
    const image = form.get("image");
    expect(image).toBeInstanceOf(File);
    expect(image).toMatchObject({
      name: "photo.png",
      size: 4,
      type: "image/png",
    });
  });

  it("rejects malformed and mismatched Content-Length values", async () => {
    const body = multipart([{ name: "title", value: "Pie" }]);
    await expect(
      parseBoundedFormData(
        streamRequest(body, { contentLength: "not-a-number" }),
        limits,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      parseBoundedFormData(
        streamRequest(body, { contentLength: String(body.length - 1) }),
        limits,
      ),
    ).rejects.toThrow("does not match");
  });

  it("stops and cancels an oversized body stream", async () => {
    let cancelled = false;
    const body = multipart([{ name: "title", value: "x".repeat(100) }]);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(body);
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = requestWithStream(stream);

    await expect(
      parseBoundedFormData(request, {
        ...limits,
        maxBodyBytes: body.length - 1,
      }),
    ).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toBe(true);
  });

  it("enforces per-file and multiple-file limits while streaming", async () => {
    const oversizedFile = multipart([
      { fileName: "large.jpg", name: "image", value: Buffer.alloc(257, 1) },
    ]);
    await expect(
      parseBoundedFormData(
        streamRequest(oversizedFile, { chunkSize: 17 }),
        limits,
      ),
    ).rejects.toThrow("exceeds the allowed size");

    const multipleFiles = multipart([
      { fileName: "one.jpg", name: "image", value: "one" },
      { fileName: "two.jpg", name: "image", value: "two" },
    ]);
    await expect(
      parseBoundedFormData(streamRequest(multipleFiles), limits),
    ).rejects.toThrow("too many files");
  });

  it("enforces field and total part counts independently", async () => {
    const tooManyFields = multipart([
      { name: "one", value: "1" },
      { name: "two", value: "2" },
    ]);
    await expect(
      parseBoundedFormData(streamRequest(tooManyFields), {
        ...limits,
        maxFields: 1,
      }),
    ).rejects.toThrow("too many fields");

    const tooManyParts = multipart([
      { name: "one", value: "1" },
      { fileName: "one.jpg", name: "image", value: "one" },
    ]);
    await expect(
      parseBoundedFormData(streamRequest(tooManyParts), {
        ...limits,
        maxParts: 1,
      }),
    ).rejects.toThrow("too many parts");
  });

  it("rejects truncated multipart data and aborts without returning partial files", async () => {
    const truncated = Buffer.from(
      '--test-boundary\r\nContent-Disposition: form-data; name="image"; filename="partial.jpg"\r\n\r\npartial',
    );
    await expect(
      parseBoundedFormData(streamRequest(truncated), limits),
    ).rejects.toThrow("closing boundary");

    const controller = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        controller.abort();
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      parseBoundedFormData(
        requestWithStream(stream, controller.signal),
        limits,
      ),
    ).rejects.toThrow("aborted");
    expect(cancelled).toBe(true);
  });

  it("bounds urlencoded update forms too", async () => {
    const request = new Request("http://local.test/form", {
      body: "intent=update&caption=short",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    const form = await parseBoundedFormData(request, limits);
    expect(form.get("intent")).toBe("update");

    const large = new Request("http://local.test/form", {
      body: `caption=${"x".repeat(129)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    await expect(parseBoundedFormData(large, limits)).rejects.toMatchObject({
      status: 413,
    });
  });
});

interface Part {
  fileName?: string;
  name: string;
  type?: string;
  value: Buffer | string;
}

function multipart(parts: Part[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from("--test-boundary\r\n"));
    const file =
      part.fileName === undefined ? "" : `; filename="${part.fileName}"`;
    chunks.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"${file}\r\n`,
      ),
    );
    if (part.type) chunks.push(Buffer.from(`Content-Type: ${part.type}\r\n`));
    chunks.push(Buffer.from("\r\n"));
    chunks.push(
      Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value),
    );
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from("--test-boundary--\r\n"));
  return Buffer.concat(chunks);
}

function streamRequest(
  body: Buffer,
  options: {
    chunked?: boolean;
    chunkSize?: number;
    contentLength?: string;
  } = {},
): Request {
  let offset = 0;
  const size = options.chunkSize ?? body.length;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= body.length) {
        controller.close();
        return;
      }
      controller.enqueue(
        body.subarray(offset, Math.min(offset + size, body.length)),
      );
      offset += size;
    },
  });
  const request = requestWithStream(stream);
  if (options.chunked) request.headers.set("transfer-encoding", "chunked");
  if (options.contentLength !== undefined) {
    request.headers.set("content-length", options.contentLength);
  }
  return request;
}

function requestWithStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Request {
  return new Request("http://local.test/form", {
    body: stream,
    headers: { "content-type": "multipart/form-data; boundary=test-boundary" },
    method: "POST",
    ...(signal ? { signal } : {}),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}
