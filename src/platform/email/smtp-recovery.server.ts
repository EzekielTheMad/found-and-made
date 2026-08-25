import nodemailer, { type Transporter } from "nodemailer";

import type { RecoveryDelivery } from "../../modules/recovery/recovery.service.server";
import { publicOriginFromEnv, publicUrl } from "../http/public-origin.server";

export class SmtpRecoveryMailer {
  constructor(
    private readonly buildPublicUrl: (pathname: string) => string,
    private readonly from: string,
    private readonly transporter: Transporter,
  ) {}

  readonly deliver: RecoveryDelivery = async ({ email, expiresAt, token }) => {
    const url = this.buildPublicUrl(`/recover/${token}`);
    await this.transporter.sendMail({
      disableFileAccess: true,
      disableUrlAccess: true,
      from: this.from,
      subject: "Reset your Found & Made password",
      text: `Use this single-use link before ${expiresAt}:\n\n${url}\n\nIf you did not request this, ignore this message.`,
      to: email,
    });
  };

  close(): void {
    this.transporter.close();
  }
}

export function createSmtpRecoveryMailer(
  environment: NodeJS.ProcessEnv = process.env,
): SmtpRecoveryMailer | undefined {
  const host = environment.SMTP_HOST?.trim();
  if (!host) return undefined;
  const from = environment.SMTP_FROM?.trim();
  if (!from)
    throw new Error("SMTP_FROM is required when SMTP_HOST is configured");
  const port = parsePort(environment.SMTP_PORT ?? "587");
  const secure = environment.SMTP_SECURE
    ? parseBoolean(environment.SMTP_SECURE, "SMTP_SECURE")
    : port === 465;
  const user = environment.SMTP_USER?.trim();
  const password = environment.SMTP_PASSWORD;
  if (Boolean(user) !== Boolean(password)) {
    throw new Error("SMTP_USER and SMTP_PASSWORD must be configured together");
  }
  const publicOrigin = publicOriginFromEnv(environment);
  const transporter = nodemailer.createTransport({
    ...(user && password ? { auth: { pass: password, user } } : {}),
    disableFileAccess: true,
    disableUrlAccess: true,
    host,
    port,
    requireTLS: secure ? false : true,
    secure,
  });
  return new SmtpRecoveryMailer(
    (pathname) => publicUrl(pathname, { PUBLIC_ORIGIN: publicOrigin }),
    from,
    transporter,
  );
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SMTP_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseBoolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}
