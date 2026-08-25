import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import nodemailer from "nodemailer";
import { afterEach, describe, expect, it } from "vitest";

import { SmtpRecoveryMailer } from "#src/platform/email/smtp-recovery.server";
import { createRuntime, type AppRuntime } from "#src/platform/runtime.server";

describe("SMTP password recovery delivery", () => {
  const cleanup: Array<{
    directory?: string;
    mailer?: SmtpRecoveryMailer;
    runtime?: AppRuntime;
    sink?: SmtpSink;
  }> = [];

  afterEach(async () => {
    for (const item of cleanup.splice(0)) {
      item.mailer?.close();
      await item.runtime?.close();
      await item.sink?.close();
      if (item.directory)
        await rm(item.directory, { force: true, recursive: true });
    }
  });

  it("sends a real bounded SMTP transaction with the single-use recovery URL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "found-made-smtp-"));
    const runtime = await createRuntime({
      dataDir: directory,
      startWorker: false,
    });
    const sink = await SmtpSink.start();
    const transporter = nodemailer.createTransport({
      host: "127.0.0.1",
      ignoreTLS: true,
      port: sink.port,
      secure: false,
    });
    const mailer = new SmtpRecoveryMailer(
      (pathname) => `https://recipes.example.test${pathname}`,
      "Found & Made <recovery@example.test>",
      transporter,
    );
    cleanup.push({ directory, mailer, runtime, sink });

    await runtime.identityService.createInitialOwner({
      email: "owner@example.test",
      name: "Owner",
      password: "initial owner password",
    });
    await runtime.recoveryService.requestEmailReset(
      "owner@example.test",
      mailer.deliver,
      new Date("2026-08-11T18:00:00.000Z"),
    );

    const message = await sink.nextMessage();
    expect(message.envelopeFrom).toBe("recovery@example.test");
    expect(message.envelopeTo).toEqual(["owner@example.test"]);
    const decodedMessage = decodeQuotedPrintable(message.data);
    expect(decodedMessage).toContain(
      "Subject: Reset your Found & Made password",
    );
    expect(decodedMessage).toContain("2026-08-11T18:15:00.000Z");
    const recoveryUrl = decodedMessage.match(
      /https:\/\/recipes\.example\.test\/recover\/[A-Za-z0-9_-]+/,
    )?.[0];
    expect(recoveryUrl).toBeTruthy();

    const token = new URL(recoveryUrl!).pathname.split("/").at(-1)!;
    await runtime.recoveryService.resetPassword(
      token,
      "replacement owner password",
      new Date("2026-08-11T18:05:00.000Z"),
    );
    await expect(
      runtime.recoveryService.resetPassword(
        token,
        "another replacement password",
        new Date("2026-08-11T18:06:00.000Z"),
      ),
    ).rejects.toThrow("already been used");
  });
});

interface CapturedMessage {
  data: string;
  envelopeFrom: string;
  envelopeTo: string[];
}

class SmtpSink {
  private readonly messages: CapturedMessage[] = [];
  private readonly waiters: Array<(message: CapturedMessage) => void> = [];

  private constructor(private readonly server: Server) {}

  get port(): number {
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("SMTP sink is not listening");
    return address.port;
  }

  static async start(): Promise<SmtpSink> {
    const server = createServer();
    const sink = new SmtpSink(server);
    server.on("connection", (socket) => sink.handle(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("SMTP sink did not bind an ephemeral port");
    }
    return sink;
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  nextMessage(): Promise<CapturedMessage> {
    const existing = this.messages.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise<CapturedMessage>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("SMTP sink did not receive a message")),
        2_000,
      );
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  private handle(socket: Socket): void {
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => socket.destroy());
    socket.write("220 localhost Found & Made test SMTP\r\n");
    let buffer = "";
    let dataMode = false;
    let envelopeFrom = "";
    const envelopeTo: string[] = [];

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      while (buffer) {
        if (dataMode) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          const message = {
            data: buffer.slice(0, end),
            envelopeFrom,
            envelopeTo: [...envelopeTo],
          };
          buffer = buffer.slice(end + 5);
          dataMode = false;
          this.publish(message);
          socket.write("250 2.0.0 queued\r\n");
          continue;
        }

        const lineEnd = buffer.indexOf("\r\n");
        if (lineEnd < 0) return;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        if (/^EHLO /i.test(line))
          socket.write("250-localhost\r\n250 SIZE 1048576\r\n");
        else if (/^MAIL FROM:/i.test(line)) {
          envelopeFrom = addressFromCommand(line);
          socket.write("250 2.1.0 sender accepted\r\n");
        } else if (/^RCPT TO:/i.test(line)) {
          envelopeTo.push(addressFromCommand(line));
          socket.write("250 2.1.5 recipient accepted\r\n");
        } else if (/^DATA$/i.test(line)) {
          dataMode = true;
          socket.write("354 end with <CRLF>.<CRLF>\r\n");
        } else if (/^QUIT$/i.test(line)) {
          socket.end("221 2.0.0 goodbye\r\n");
        } else socket.write("250 2.0.0 ok\r\n");
      }
    });
  }

  private publish(message: CapturedMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(message);
    else this.messages.push(message);
  }
}

function addressFromCommand(command: string): string {
  return command.match(/<([^>]+)>/)?.[1] ?? "";
}

function decodeQuotedPrintable(value: string): string {
  return value
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
}
