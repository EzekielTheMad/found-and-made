import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, type AppRuntime } from "#src/platform/runtime.server";

describe("foundation runtime", () => {
  const cleanup: Array<{ directory: string; runtime?: AppRuntime }> = [];

  afterEach(async () => {
    for (const item of cleanup.splice(0)) {
      await item.runtime?.close();
      await rm(item.directory, { force: true, recursive: true });
    }
  });

  it("migrates SQLite and preserves the installation record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "found-made-foundation-"));
    const item: { directory: string; runtime?: AppRuntime } = { directory };
    cleanup.push(item);

    item.runtime = await createRuntime({
      dataDir: directory,
      startWorker: false,
    });
    const first = item.runtime.systemService.getStatus();
    const firstKey = await readFile(
      join(directory, "keys", "instance.key"),
      "utf8",
    );
    await item.runtime.close();
    item.runtime = undefined;

    item.runtime = await createRuntime({
      dataDir: directory,
      startWorker: false,
    });
    const second = item.runtime.systemService.getStatus();
    const secondKey = await readFile(
      join(directory, "keys", "instance.key"),
      "utf8",
    );

    expect(second.installationId).toBe(first.installationId);
    expect(firstKey).toHaveLength(43);
    expect(secondKey).toBe(firstKey);
    await expect(item.runtime.ready()).resolves.toBeUndefined();
  });

  it("claims and completes a durable job through the worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "found-made-job-"));
    const item: { directory: string; runtime?: AppRuntime } = { directory };
    cleanup.push(item);

    item.runtime = await createRuntime({
      dataDir: directory,
      startWorker: false,
    });
    const job = item.runtime.jobQueue.enqueue({
      idempotencyKey: "foundation-noop",
      payload: { proof: true },
      type: "system.noop",
      version: 1,
    });
    item.runtime.jobWorker.start();

    await waitFor(
      () => item.runtime?.jobQueue.get(job.id)?.status === "succeeded",
    );
    expect(item.runtime.jobQueue.get(job.id)?.attempts).toBe(1);
  });

  it("recovers an expired job lease after a worker interruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "found-made-lease-"));
    const item: { directory: string; runtime?: AppRuntime } = { directory };
    cleanup.push(item);

    item.runtime = await createRuntime({
      dataDir: directory,
      startWorker: false,
    });
    const job = item.runtime.jobQueue.enqueue({
      idempotencyKey: "lease-recovery",
      payload: { proof: true },
      type: "system.noop",
      version: 1,
    });

    const interrupted = item.runtime.jobQueue.claim("worker-interrupted", 1);
    expect(interrupted?.id).toBe(job.id);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const recovered = item.runtime.jobQueue.claim("worker-recovery", 30_000);
    expect(recovered?.id).toBe(job.id);
    expect(recovered?.attempts).toBe(2);
    item.runtime.jobQueue.complete(job.id, "worker-recovery");
    expect(item.runtime.jobQueue.get(job.id)?.status).toBe("succeeded");
  });

  it("fails readiness after the database is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "found-made-health-"));
    const item: { directory: string; runtime?: AppRuntime } = { directory };
    cleanup.push(item);

    const runtime = await createRuntime({
      dataDir: directory,
      startWorker: false,
    });
    item.runtime = runtime;
    await runtime.close();
    item.runtime = undefined;

    await expect(runtime.ready()).rejects.toThrow();
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
