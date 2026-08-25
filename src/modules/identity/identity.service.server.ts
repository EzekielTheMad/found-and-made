import { createHash, randomBytes, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { hashPassword } from "better-auth/crypto";

import { AuthorizationPolicy } from "./authorization.policy";
import type {
  AppRole,
  AppUserSummary,
  ContributorSummary,
  InviteRole,
  Principal,
} from "./identity.types";

interface AccountInput {
  email: string;
  name: string;
  password: string;
}

interface InvitationRow {
  consumedAt: string | null;
  email: string;
  expiresAt: string;
  id: string;
  role: InviteRole;
}

interface UserRow {
  email: string;
  emailVerified: number;
  id: string;
  name: string;
  role: AppRole;
}

export class IdentityService {
  readonly policy = new AuthorizationPolicy();

  constructor(private readonly sqlite: Database.Database) {}

  needsInitialOwner(): boolean {
    const row = this.sqlite
      .prepare("SELECT COUNT(*) AS count FROM app_users")
      .get() as {
      count: number;
    };
    return row.count === 0;
  }

  async createInitialOwner(
    input: AccountInput,
    now = new Date(),
  ): Promise<AppUserSummary> {
    const account = validateAccountInput(input);
    const passwordHash = await hashPassword(account.password);

    return this.sqlite
      .transaction(() => {
        if (!this.needsInitialOwner()) {
          throw new Error("Initial Owner setup has already been completed");
        }
        const user = this.insertLocalUser(account, "owner", passwordHash, now);
        this.recordAudit("owner.created", user.id, user.id, {}, now);
        return user;
      })
      .immediate();
  }

  createInvitation(
    principal: Principal,
    input: { email: string; expiresInHours?: number; role: InviteRole },
    now = new Date(),
  ): { expiresAt: string; token: string } {
    this.policy.require(principal, "people:manage");
    if (principal.kind !== "user")
      throw new Error("Invitations require an Owner");
    if (input.role !== "editor" && input.role !== "viewer") {
      throw new Error("Invitations may grant only Editor or Viewer access");
    }
    const email = normalizeEmail(input.email);
    const hours = input.expiresInHours ?? 72;
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
      throw new Error("Invitation expiry must be between 1 and 168 hours");
    }
    const token = createToken();
    const expiresAt = new Date(
      now.getTime() + hours * 60 * 60 * 1000,
    ).toISOString();
    const actorId = principal.userId;

    this.sqlite
      .transaction(() => {
        const existingUser = this.sqlite
          .prepare("SELECT 1 AS present FROM user WHERE email = ?")
          .get(email);
        if (existingUser)
          throw new Error("An account already exists for that email");
        this.sqlite
          .prepare(
            `INSERT INTO invitations
           (id, token_hash, email, role, invited_by, expires_at, consumed_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
          )
          .run(
            randomUUID(),
            hashToken(token),
            email,
            input.role,
            actorId,
            expiresAt,
            now.toISOString(),
          );
        this.recordAudit(
          "invitation.created",
          actorId,
          email,
          { expiresAt, role: input.role },
          now,
        );
      })
      .immediate();

    return { expiresAt, token };
  }

  async acceptInvitation(
    token: string,
    input: AccountInput,
    now = new Date(),
  ): Promise<AppUserSummary> {
    const account = validateAccountInput(input);
    const passwordHash = await hashPassword(account.password);

    return this.sqlite
      .transaction(() => {
        const invitation = this.sqlite
          .prepare(
            `SELECT id, email, role, expires_at AS expiresAt, consumed_at AS consumedAt
           FROM invitations WHERE token_hash = ?`,
          )
          .get(hashToken(token)) as InvitationRow | undefined;
        if (!invitation || invitation.consumedAt) {
          throw new Error("Invitation is invalid or has already been used");
        }
        if (Date.parse(invitation.expiresAt) <= now.getTime()) {
          throw new Error("Invitation has expired");
        }
        if (invitation.email !== account.email) {
          throw new Error("Invitation email does not match");
        }

        const consumed = this.sqlite
          .prepare(
            "UPDATE invitations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
          )
          .run(now.toISOString(), invitation.id);
        if (consumed.changes !== 1) {
          throw new Error("Invitation is invalid or has already been used");
        }

        const user = this.insertLocalUser(
          account,
          invitation.role,
          passwordHash,
          now,
        );
        this.recordAudit(
          "invitation.accepted",
          user.id,
          invitation.id,
          { role: invitation.role },
          now,
        );
        return user;
      })
      .immediate();
  }

  principalForUser(userId: string): Principal {
    const row = this.sqlite
      .prepare("SELECT role FROM app_users WHERE user_id = ?")
      .get(userId) as { role: AppRole } | undefined;
    if (!row) throw new Error("Authenticated user has no application role");
    return { kind: "user", role: row.role, userId };
  }

  listUsers(principal: Principal): AppUserSummary[] {
    this.policy.require(principal, "people:manage");
    return (
      this.sqlite
        .prepare(
          `SELECT u.id, u.name, u.email, u.emailVerified, a.role
           FROM user u JOIN app_users a ON a.user_id = u.id
           ORDER BY u.createdAt ASC`,
        )
        .all() as UserRow[]
    ).map(toSummary);
  }

  contributorNames(
    principal: Principal,
    userIds: readonly string[],
  ): ContributorSummary[] {
    this.policy.require(principal, "recipe:read");
    const ids = [...new Set(userIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0) return [];
    const contributors: ContributorSummary[] = [];
    for (let index = 0; index < ids.length; index += 500) {
      const batch = ids.slice(index, index + 500);
      const placeholders = batch.map(() => "?").join(",");
      contributors.push(
        ...(this.sqlite
          .prepare(`SELECT id, name FROM user WHERE id IN (${placeholders})`)
          .all(...batch) as ContributorSummary[]),
      );
    }
    return contributors.sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  changeRole(
    principal: Principal,
    userId: string,
    role: AppRole,
    now = new Date(),
  ): void {
    this.policy.require(principal, "people:manage");
    if (!(["owner", "editor", "viewer"] as const).includes(role)) {
      throw new Error("Unknown role");
    }

    this.sqlite
      .transaction(() => {
        const current = this.sqlite
          .prepare("SELECT role FROM app_users WHERE user_id = ?")
          .get(userId) as { role: AppRole } | undefined;
        if (!current) throw new Error("User not found");
        if (current.role === "owner" && role !== "owner") {
          const owners = this.sqlite
            .prepare(
              "SELECT COUNT(*) AS count FROM app_users WHERE role = 'owner'",
            )
            .get() as { count: number };
          if (owners.count <= 1)
            throw new Error("The final Owner cannot be demoted");
        }
        this.sqlite
          .prepare(
            "UPDATE app_users SET role = ?, updated_at = ? WHERE user_id = ?",
          )
          .run(role, now.toISOString(), userId);
        this.recordAudit(
          "role.changed",
          principal.kind === "user" ? principal.userId : null,
          userId,
          { from: current.role, to: role },
          now,
        );
      })
      .immediate();
  }

  assertCanUnlink(userId: string, providerId: string): void {
    const accounts = this.sqlite
      .prepare("SELECT providerId FROM account WHERE userId = ?")
      .all(userId) as { providerId: string }[];
    if (accounts.length <= 1)
      throw new Error("The final sign-in method cannot be removed");

    const role = this.sqlite
      .prepare("SELECT role FROM app_users WHERE user_id = ?")
      .get(userId) as { role: AppRole } | undefined;
    if (role?.role === "owner" && providerId === "credential") {
      throw new Error("Owners must retain a local recovery credential");
    }
  }

  unlinkAccount(
    principal: Principal,
    providerId: string,
    now = new Date(),
  ): void {
    if (principal.kind !== "user")
      throw new Error("A user session is required");
    if (
      !providerId ||
      (providerId === "credential" && principal.role === "owner")
    ) {
      throw new Error("Owners must retain a local recovery credential");
    }
    this.sqlite
      .transaction(() => {
        this.assertCanUnlink(principal.userId, providerId);
        const removed = this.sqlite
          .prepare("DELETE FROM account WHERE userId = ? AND providerId = ?")
          .run(principal.userId, providerId);
        if (removed.changes !== 1)
          throw new Error("Connected account not found");
        this.recordAudit(
          "account.unlinked",
          principal.userId,
          principal.userId,
          { providerId },
          now,
        );
      })
      .immediate();
  }

  private insertLocalUser(
    input: AccountInput,
    role: AppRole,
    passwordHash: string,
    now: Date,
  ): AppUserSummary {
    const userId = randomUUID();
    const timestamp = now.toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO user
         (id, name, email, emailVerified, image, createdAt, updatedAt)
         VALUES (?, ?, ?, 0, NULL, ?, ?)`,
      )
      .run(userId, input.name, input.email, timestamp, timestamp);
    this.sqlite
      .prepare(
        `INSERT INTO account
         (id, accountId, providerId, userId, password, createdAt, updatedAt)
         VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
      )
      .run(randomUUID(), userId, userId, passwordHash, timestamp, timestamp);
    this.sqlite
      .prepare(
        "INSERT INTO app_users (user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(userId, role, timestamp, timestamp);
    return {
      email: input.email,
      emailVerified: false,
      id: userId,
      name: input.name,
      role,
    };
  }

  private recordAudit(
    action: string,
    actorId: string | null,
    subjectId: string | null,
    metadata: Record<string, unknown>,
    now: Date,
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO audit_events
         (id, action, actor_id, subject_id, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        action,
        actorId,
        subjectId,
        JSON.stringify(metadata),
        now.toISOString(),
      );
  }
}

function validateAccountInput(input: AccountInput): AccountInput {
  const name = input.name.trim();
  const email = normalizeEmail(input.email);
  if (name.length < 1 || name.length > 100) throw new Error("Name is required");
  if (input.password.length < 12 || input.password.length > 128) {
    throw new Error("Password must be between 12 and 128 characters");
  }
  return { email, name, password: input.password };
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("A valid email address is required");
  }
  return normalized;
}

function createToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function toSummary(row: UserRow): AppUserSummary {
  return {
    email: row.email,
    emailVerified: row.emailVerified === 1,
    id: row.id,
    name: row.name,
    role: row.role,
  };
}
