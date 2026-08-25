import { createHash, randomBytes, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { hashPassword } from "better-auth/crypto";

export type RecoveryDelivery = (message: {
  email: string;
  expiresAt: string;
  token: string;
}) => Promise<void>;

interface RecoveryRow {
  consumedAt: string | null;
  expiresAt: string;
  id: string;
  userId: string;
}

export class RecoveryService {
  constructor(private readonly sqlite: Database.Database) {}

  issueServerOwnerRecovery(
    ownerEmail?: string,
    now = new Date(),
  ): { expiresAt: string; token: string } {
    const owner = this.findOwner(ownerEmail);
    if (!owner) throw new Error("Owner account not found");
    return this.issue(owner.id, "server", now);
  }

  async requestEmailReset(
    email: string,
    deliver: RecoveryDelivery,
    now = new Date(),
  ): Promise<void> {
    const normalized = email.trim().toLowerCase();
    const user = this.sqlite
      .prepare("SELECT id, email FROM user WHERE email = ?")
      .get(normalized) as { email: string; id: string } | undefined;
    if (!user) return;

    const recovery = this.issue(user.id, "email", now);
    await deliver({ email: user.email, ...recovery });
  }

  async resetPassword(
    token: string,
    newPassword: string,
    now = new Date(),
  ): Promise<void> {
    if (newPassword.length < 12 || newPassword.length > 128) {
      throw new Error("Password must be between 12 and 128 characters");
    }
    const passwordHash = await hashPassword(newPassword);

    this.sqlite
      .transaction(() => {
        const recovery = this.sqlite
          .prepare(
            `SELECT id, user_id AS userId, expires_at AS expiresAt,
                  consumed_at AS consumedAt
           FROM recovery_tokens WHERE token_hash = ?`,
          )
          .get(hashToken(token)) as RecoveryRow | undefined;
        if (!recovery || recovery.consumedAt) {
          throw new Error("Recovery link is invalid or has already been used");
        }
        if (Date.parse(recovery.expiresAt) <= now.getTime()) {
          throw new Error("Recovery link has expired");
        }
        const consumed = this.sqlite
          .prepare(
            "UPDATE recovery_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
          )
          .run(now.toISOString(), recovery.id);
        if (consumed.changes !== 1) {
          throw new Error("Recovery link is invalid or has already been used");
        }
        const updated = this.sqlite
          .prepare(
            `UPDATE account SET password = ?, updatedAt = ?
           WHERE userId = ? AND providerId = 'credential'`,
          )
          .run(passwordHash, now.toISOString(), recovery.userId);
        if (updated.changes !== 1)
          throw new Error("Local recovery credential not found");
        this.sqlite
          .prepare("DELETE FROM session WHERE userId = ?")
          .run(recovery.userId);
        this.recordAudit("recovery.completed", recovery.userId, now);
      })
      .immediate();
  }

  private issue(
    userId: string,
    kind: "email" | "server",
    now: Date,
  ): { expiresAt: string; token: string } {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
    this.sqlite
      .transaction(() => {
        this.sqlite
          .prepare(
            `UPDATE recovery_tokens SET consumed_at = ?
           WHERE user_id = ? AND consumed_at IS NULL`,
          )
          .run(now.toISOString(), userId);
        this.sqlite
          .prepare(
            `INSERT INTO recovery_tokens
           (id, token_hash, user_id, kind, expires_at, consumed_at, created_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?)`,
          )
          .run(
            randomUUID(),
            hashToken(token),
            userId,
            kind,
            expiresAt,
            now.toISOString(),
          );
        this.recordAudit(`recovery.${kind}.issued`, userId, now);
      })
      .immediate();
    return { expiresAt, token };
  }

  private findOwner(email?: string): { id: string } | undefined {
    if (email) {
      return this.sqlite
        .prepare(
          `SELECT u.id FROM user u
           JOIN app_users a ON a.user_id = u.id
           JOIN account c ON c.userId = u.id AND c.providerId = 'credential'
           WHERE a.role = 'owner' AND u.email = ?`,
        )
        .get(email.trim().toLowerCase()) as { id: string } | undefined;
    }
    const owners = this.sqlite
      .prepare(
        `SELECT u.id FROM user u
         JOIN app_users a ON a.user_id = u.id
         JOIN account c ON c.userId = u.id AND c.providerId = 'credential'
         WHERE a.role = 'owner' ORDER BY u.createdAt ASC`,
      )
      .all() as { id: string }[];
    if (owners.length !== 1) {
      throw new Error("Specify the Owner email when multiple Owners exist");
    }
    return owners[0];
  }

  private recordAudit(action: string, userId: string, now: Date): void {
    this.sqlite
      .prepare(
        `INSERT INTO audit_events
         (id, action, actor_id, subject_id, metadata, created_at)
         VALUES (?, ?, NULL, ?, '{}', ?)`,
      )
      .run(randomUUID(), action, userId, now.toISOString());
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
