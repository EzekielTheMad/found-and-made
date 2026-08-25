import { describe, expect, it } from "vitest";

import { createSmtpRecoveryMailer } from "#src/platform/email/smtp-recovery.server";

describe("SMTP recovery configuration", () => {
  it("is optional and refuses partial or invalid configuration", () => {
    expect(createSmtpRecoveryMailer({})).toBeUndefined();
    expect(() =>
      createSmtpRecoveryMailer({ SMTP_HOST: "smtp.example.com" }),
    ).toThrow("SMTP_FROM");
    expect(() =>
      createSmtpRecoveryMailer({
        SMTP_FROM: "Found & Made <recipes@example.com>",
        SMTP_HOST: "smtp.example.com",
        SMTP_PASSWORD: "secret",
      }),
    ).toThrow("configured together");
    expect(() =>
      createSmtpRecoveryMailer({
        SMTP_FROM: "Found & Made <recipes@example.com>",
        SMTP_HOST: "smtp.example.com",
        SMTP_PORT: "0",
      }),
    ).toThrow("SMTP_PORT");
    expect(() =>
      createSmtpRecoveryMailer({
        SMTP_FROM: "Found & Made <recipes@example.com>",
        SMTP_HOST: "smtp.example.com",
      }),
    ).toThrow("PUBLIC_ORIGIN");
  });

  it("builds a TLS-requiring transport without connecting at startup", () => {
    const mailer = createSmtpRecoveryMailer({
      PUBLIC_ORIGIN: "https://recipes.example.com",
      SMTP_FROM: "Found & Made <recipes@example.com>",
      SMTP_HOST: "smtp.example.com",
      SMTP_PASSWORD: "secret",
      SMTP_PORT: "587",
      SMTP_USER: "mailer",
    });
    expect(mailer).toBeDefined();
    mailer?.close();
  });
});
