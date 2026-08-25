import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import type { DatabaseHandle } from "#src/platform/db/database.server";
import { systemSettings } from "#src/platform/db/schema";

const INSTALLATION_ID_KEY = "installation.id";

export interface SystemStatus {
  installationId: string;
}

export class SystemService {
  public constructor(private readonly database: DatabaseHandle) {}

  public initialize(): SystemStatus {
    const existing = this.database.db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, INSTALLATION_ID_KEY))
      .get();

    if (existing) return { installationId: existing.value };

    const now = new Date().toISOString();
    const installationId = randomUUID();
    this.database.db
      .insert(systemSettings)
      .values({
        key: INSTALLATION_ID_KEY,
        updatedAt: now,
        value: installationId,
      })
      .onConflictDoNothing()
      .run();

    return this.getStatus();
  }

  public getStatus(): SystemStatus {
    const row = this.database.db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, INSTALLATION_ID_KEY))
      .get();

    if (!row) throw new Error("Installation record is not initialized");
    return { installationId: row.value };
  }
}
