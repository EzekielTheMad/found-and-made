import {
  type AnySQLiteColumn,
  check,
  customType,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const sqliteDate = customType<{ data: Date; driverData: string }>({
  dataType() {
    return "date";
  },
  fromDriver(value) {
    return new Date(value);
  },
  toDriver(value) {
    return value.toISOString();
  },
});

export const authUsers = sqliteTable("user", {
  createdAt: sqliteDate("createdAt").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull(),
  id: text("id").primaryKey(),
  image: text("image"),
  name: text("name").notNull(),
  updatedAt: sqliteDate("updatedAt").notNull(),
});

export const authSessions = sqliteTable(
  "session",
  {
    createdAt: sqliteDate("createdAt").notNull(),
    expiresAt: sqliteDate("expiresAt").notNull(),
    id: text("id").primaryKey(),
    ipAddress: text("ipAddress"),
    token: text("token").notNull().unique(),
    updatedAt: sqliteDate("updatedAt").notNull(),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const authAccounts = sqliteTable(
  "account",
  {
    accessToken: text("accessToken"),
    accessTokenExpiresAt: sqliteDate("accessTokenExpiresAt"),
    accountId: text("accountId").notNull(),
    createdAt: sqliteDate("createdAt").notNull(),
    id: text("id").primaryKey(),
    idToken: text("idToken"),
    password: text("password"),
    providerId: text("providerId").notNull(),
    refreshToken: text("refreshToken"),
    refreshTokenExpiresAt: sqliteDate("refreshTokenExpiresAt"),
    scope: text("scope"),
    updatedAt: sqliteDate("updatedAt").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const authVerifications = sqliteTable(
  "verification",
  {
    createdAt: sqliteDate("createdAt").notNull(),
    expiresAt: sqliteDate("expiresAt").notNull(),
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    updatedAt: sqliteDate("updatedAt").notNull(),
    value: text("value").notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const appUsers = sqliteTable(
  "app_users",
  {
    createdAt: text("created_at").notNull(),
    role: text("role").notNull(),
    updatedAt: text("updated_at").notNull(),
    userId: text("user_id")
      .primaryKey()
      .references(() => authUsers.id, { onDelete: "cascade" }),
  },
  (table) => [
    check(
      "app_users_role_check",
      sql`${table.role} IN ('owner','editor','viewer')`,
    ),
  ],
);

export const invitations = sqliteTable(
  "invitations",
  {
    consumedAt: text("consumed_at"),
    createdAt: text("created_at").notNull(),
    email: text("email").notNull(),
    expiresAt: text("expires_at").notNull(),
    id: text("id").primaryKey(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => authUsers.id, { onDelete: "restrict" }),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
  },
  (table) => [
    check("invitations_role_check", sql`${table.role} IN ('editor','viewer')`),
    index("invitations_email_idx").on(table.email, table.expiresAt),
  ],
);

export const recoveryTokens = sqliteTable(
  "recovery_tokens",
  {
    consumedAt: text("consumed_at"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
  },
  (table) => [
    check("recovery_kind_check", sql`${table.kind} IN ('email','server')`),
    index("recovery_user_idx").on(table.userId, table.expiresAt),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    action: text("action").notNull(),
    actorId: text("actor_id"),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    metadata: text("metadata").notNull(),
    subjectId: text("subject_id"),
  },
  (table) => [index("audit_events_created_idx").on(table.createdAt)],
);

export const recipePublications = sqliteTable(
  "recipe_publications",
  {
    publishedAt: text("published_at"),
    publishedBy: text("published_by").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    recipeId: text("recipe_id")
      .primaryKey()
      .references(() => recipes.id, { onDelete: "cascade" }),
    reviewRequestedAt: text("review_requested_at"),
    reviewRequestedBy: text("review_requested_by").references(
      () => authUsers.id,
      { onDelete: "set null" },
    ),
    rightsAttestedAt: text("rights_attested_at"),
    rightsAttestedBy: text("rights_attested_by").references(
      () => authUsers.id,
      { onDelete: "set null" },
    ),
    status: text("status").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "recipe_publications_status_check",
      sql`${table.status} IN ('review','published')`,
    ),
  ],
);

export const mediaAssets = sqliteTable(
  "media_assets",
  {
    altText: text("alt_text").notNull(),
    caption: text("caption").notNull(),
    checksum: text("checksum").notNull(),
    componentId: text("component_id"),
    createdAt: text("created_at").notNull(),
    focalX: integer("focal_x").notNull().default(50),
    focalY: integer("focal_y").notNull().default(50),
    height: integer("height").notNull(),
    id: text("id").primaryKey(),
    originalPath: text("original_path").notNull().unique(),
    position: integer("position").notNull(),
    recipeId: text("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    socialPath: text("social_path").notNull().unique(),
    stepId: text("step_id"),
    updatedAt: text("updated_at").notNull(),
    webPath: text("web_path").notNull().unique(),
    width: integer("width").notNull(),
  },
  (table) => [
    check(
      "media_assets_role_check",
      sql`${table.role} IN ('hero','gallery','component','step')`,
    ),
    index("media_assets_recipe_idx").on(table.recipeId, table.position),
  ],
);

export const facetGroups = sqliteTable(
  "facet_groups",
  {
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    slug: text("slug").notNull().unique(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("facet_groups_position_idx").on(table.position)],
);

export const facetTerms = sqliteTable(
  "facet_terms",
  {
    createdAt: text("created_at").notNull(),
    groupId: text("group_id")
      .notNull()
      .references(() => facetGroups.id, { onDelete: "cascade" }),
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    parentId: text("parent_id").references(
      (): AnySQLiteColumn => facetTerms.id,
      {
        onDelete: "restrict",
      },
    ),
    position: integer("position").notNull().default(0),
    slug: text("slug").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("facet_terms_group_parent_idx").on(table.groupId, table.parentId),
    index("facet_terms_group_slug_idx").on(table.groupId, table.slug),
  ],
);

export const facetTermAliases = sqliteTable(
  "facet_term_aliases",
  {
    alias: text("alias").notNull(),
    termId: text("term_id")
      .notNull()
      .references(() => facetTerms.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("facet_term_aliases_alias_idx").on(table.alias),
    index("facet_term_aliases_term_idx").on(table.termId),
  ],
);

export const recipeTerms = sqliteTable(
  "recipe_terms",
  {
    recipeId: text("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    termId: text("term_id")
      .notNull()
      .references(() => facetTerms.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("recipe_terms_term_recipe_idx").on(table.termId, table.recipeId),
    index("recipe_terms_recipe_term_idx").on(table.recipeId, table.termId),
  ],
);

export const labels = sqliteTable("labels", {
  createdAt: text("created_at").notNull(),
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull().unique(),
  updatedAt: text("updated_at").notNull(),
});

export const recipeLabels = sqliteTable(
  "recipe_labels",
  {
    labelId: text("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
    recipeId: text("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("recipe_labels_label_recipe_idx").on(table.labelId, table.recipeId),
    index("recipe_labels_recipe_label_idx").on(table.recipeId, table.labelId),
  ],
);

export const collections = sqliteTable(
  "collections",
  {
    createdAt: text("created_at").notNull(),
    description: text("description").notNull(),
    id: text("id").primaryKey(),
    position: integer("position").notNull().default(0),
    title: text("title").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("collections_position_idx").on(table.position)],
);

export const collectionPublications = sqliteTable(
  "collection_publications",
  {
    collectionId: text("collection_id")
      .primaryKey()
      .references(() => collections.id, { onDelete: "cascade" }),
    publishedAt: text("published_at").notNull(),
    publishedBy: text("published_by").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("collection_publications_published_idx").on(table.publishedAt),
  ],
);

export const collectionRecipes = sqliteTable(
  "collection_recipes",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    recipeId: text("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("collection_recipes_collection_position_idx").on(
      table.collectionId,
      table.position,
    ),
    index("collection_recipes_recipe_idx").on(table.recipeId),
  ],
);

export const savedViews = sqliteTable(
  "saved_views",
  {
    createdAt: text("created_at").notNull(),
    criteria: text("criteria").notNull(),
    id: text("id").primaryKey(),
    isStarter: integer("is_starter", { mode: "boolean" })
      .notNull()
      .default(false),
    layout: text("layout").notNull(),
    name: text("name").notNull(),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    sort: text("sort").notNull(),
    updatedAt: text("updated_at").notNull(),
    userId: text("user_id").references(() => authUsers.id, {
      onDelete: "cascade",
    }),
  },
  (table) => [index("saved_views_user_idx").on(table.userId, table.name)],
);

export const userDefaultViews = sqliteTable("user_default_views", {
  savedViewId: text("saved_view_id").references(() => savedViews.id, {
    onDelete: "set null",
  }),
  updatedAt: text("updated_at").notNull(),
  userId: text("user_id")
    .primaryKey()
    .references(() => authUsers.id, { onDelete: "cascade" }),
});

export const homeSections = sqliteTable(
  "home_sections",
  {
    config: text("config").notNull(),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("home_sections_position_idx").on(table.position)],
);

export const systemSettings = sqliteTable("system_settings", {
  key: text("key").primaryKey(),
  updatedAt: text("updated_at").notNull(),
  value: text("value").notNull(),
});

export const jobs = sqliteTable(
  "jobs",
  {
    artifactRefs: text("artifact_refs").notNull().default("[]"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: text("available_at").notNull(),
    createdAt: text("created_at").notNull(),
    errorCode: text("error_code"),
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    leaseExpiresAt: text("lease_expires_at"),
    leaseOwner: text("lease_owner"),
    maxAttempts: integer("max_attempts").notNull().default(3),
    payload: text("payload").notNull(),
    progress: integer("progress").notNull().default(0),
    status: text("status").notNull(),
    type: text("type").notNull(),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull(),
  },
  (table) => [
    index("jobs_claim_idx").on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
    ),
  ],
);

export const importSessions = sqliteTable(
  "import_sessions",
  {
    createdAt: text("created_at").notNull(),
    currentStage: text("current_stage"),
    id: text("id").primaryKey(),
    jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
    progress: integer("progress").notNull().default(0),
    requestKey: text("request_key").notNull().unique(),
    requestedBy: text("requested_by").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    resultingRecipeId: text("resulting_recipe_id").references(
      () => recipes.id,
      { onDelete: "set null" },
    ),
    source: text("source").notNull(),
    sourceKind: text("source_kind").notNull(),
    status: text("status").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "import_sessions_status_check",
      sql`${table.status} IN ('queued','processing','review','completed','failed','cancelled','skipped')`,
    ),
    check(
      "import_sessions_progress_check",
      sql`${table.progress} >= 0 AND ${table.progress} <= 100`,
    ),
    index("import_sessions_requested_idx").on(
      table.requestedBy,
      table.updatedAt,
    ),
    index("import_sessions_status_idx").on(table.status, table.updatedAt),
  ],
);

export const importCheckpoints = sqliteTable(
  "import_checkpoints",
  {
    artifact: text("artifact").notNull(),
    artifactHash: text("artifact_hash").notNull(),
    completedAt: text("completed_at").notNull(),
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => importSessions.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
  },
  (table) => [
    uniqueIndex("import_checkpoints_session_stage_idx").on(
      table.sessionId,
      table.stage,
    ),
  ],
);

export const importReviews = sqliteTable("import_reviews", {
  confirmedBrandIngredientIds: text("confirmed_brand_ingredient_ids")
    .notNull()
    .default("[]"),
  draft: text("draft").notNull(),
  reviewedAt: text("reviewed_at").notNull(),
  reviewedBy: text("reviewed_by").references(() => authUsers.id, {
    onDelete: "set null",
  }),
  sessionId: text("session_id")
    .primaryKey()
    .references(() => importSessions.id, { onDelete: "cascade" }),
});

export const personalRecipeStates = sqliteTable(
  "personal_recipe_states",
  {
    cookedCount: integer("cooked_count").notNull().default(0),
    createdAt: text("created_at").notNull(),
    favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
    lastCookedAt: text("last_cooked_at"),
    lastViewedAt: text("last_viewed_at"),
    note: text("note").notNull().default(""),
    rating: integer("rating"),
    recipeId: text("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    updatedAt: text("updated_at").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.recipeId] }),
    check(
      "personal_recipe_states_rating_check",
      sql`${table.rating} IS NULL OR (${table.rating} >= 1 AND ${table.rating} <= 5)`,
    ),
    check(
      "personal_recipe_states_cooked_count_check",
      sql`${table.cookedCount} >= 0`,
    ),
    check("personal_recipe_states_version_check", sql`${table.version} >= 1`),
    index("personal_recipe_states_favorite_idx").on(
      table.userId,
      table.favorite,
      table.updatedAt,
    ),
    index("personal_recipe_states_viewed_idx").on(
      table.userId,
      table.lastViewedAt,
    ),
    index("personal_recipe_states_cooked_idx").on(
      table.userId,
      table.lastCookedAt,
    ),
  ],
);

export const personalAdjustments = sqliteTable(
  "personal_adjustments",
  {
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    note: text("note").notNull(),
    recipeId: text("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("personal_adjustments_user_recipe_idx").on(
      table.userId,
      table.recipeId,
      table.createdAt,
    ),
  ],
);

export const cookingHistory = sqliteTable(
  "cooking_history",
  {
    adjustmentId: text("adjustment_id").references(
      () => personalAdjustments.id,
      { onDelete: "set null" },
    ),
    cookedAt: text("cooked_at").notNull(),
    id: text("id").primaryKey(),
    recipeId: text("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("cooking_history_user_cooked_idx").on(table.userId, table.cookedAt),
    index("cooking_history_user_recipe_idx").on(
      table.userId,
      table.recipeId,
      table.cookedAt,
    ),
  ],
);

export const cookingSessions = sqliteTable(
  "cooking_sessions",
  {
    checkedIngredientIds: text("checked_ingredient_ids")
      .notNull()
      .default("[]"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
    guidedStepIndex: integer("guided_step_index").notNull().default(0),
    id: text("id").primaryKey(),
    recipeId: text("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    targetServings: real("target_servings").notNull(),
    timers: text("timers").notNull().default("[]"),
    updatedAt: text("updated_at").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check(
      "cooking_sessions_status_check",
      sql`${table.status} IN ('active','completed','abandoned')`,
    ),
    check(
      "cooking_sessions_target_servings_check",
      sql`${table.targetServings} > 0`,
    ),
    check(
      "cooking_sessions_guided_step_check",
      sql`${table.guidedStepIndex} >= 0`,
    ),
    check("cooking_sessions_version_check", sql`${table.version} >= 1`),
    index("cooking_sessions_user_updated_idx").on(
      table.userId,
      table.updatedAt,
    ),
    index("cooking_sessions_user_recipe_idx").on(
      table.userId,
      table.recipeId,
      table.updatedAt,
    ),
  ],
);

export const personalStateOperations = sqliteTable(
  "personal_state_operations",
  {
    appliedAt: text("applied_at").notNull(),
    clientOperationId: text("client_operation_id").notNull(),
    operationHash: text("operation_hash").notNull(),
    recipeId: text("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    result: text("result").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.clientOperationId] }),
    index("personal_state_operations_applied_idx").on(
      table.userId,
      table.appliedAt,
    ),
  ],
);

export const printProfiles = sqliteTable(
  "print_profiles",
  {
    config: text("config").notNull(),
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    updatedAt: text("updated_at").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check("print_profiles_version_check", sql`${table.version} >= 1`),
    index("print_profiles_user_name_idx").on(table.userId, table.name),
  ],
);

export const printCollections = sqliteTable(
  "print_collections",
  {
    createdAt: text("created_at").notNull(),
    description: text("description").notNull().default(""),
    globalLayout: text("global_layout").notNull(),
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    numberingMode: text("numbering_mode").notNull().default("modular"),
    outline: text("outline").notNull().default("[]"),
    profileId: text("profile_id").references(() => printProfiles.id, {
      onDelete: "set null",
    }),
    updatedAt: text("updated_at").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check(
      "print_collections_layout_check",
      sql`${table.globalLayout} IN ('classic-single-column','classic-two-column','step-linked','landscape-merge-grid','compact-card')`,
    ),
    check(
      "print_collections_numbering_check",
      sql`${table.numberingMode} IN ('modular','fixed')`,
    ),
    check("print_collections_version_check", sql`${table.version} >= 1`),
    index("print_collections_user_name_idx").on(table.userId, table.name),
  ],
);

export const printJobs = sqliteTable(
  "print_jobs",
  {
    artifactChecksum: text("artifact_checksum"),
    artifactMimeType: text("artifact_mime_type"),
    artifactPageCount: integer("artifact_page_count"),
    artifactRelativePath: text("artifact_relative_path"),
    artifactSizeBytes: integer("artifact_size_bytes"),
    collectionId: text("collection_id").references(() => printCollections.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull(),
    errorCode: text("error_code"),
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    profileId: text("profile_id").references(() => printProfiles.id, {
      onDelete: "set null",
    }),
    request: text("request").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull(),
    updatedAt: text("updated_at").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check(
      "print_jobs_status_check",
      sql`${table.status} IN ('queued','rendering','completed','failed')`,
    ),
    check(
      "print_jobs_page_count_check",
      sql`${table.artifactPageCount} IS NULL OR ${table.artifactPageCount} > 0`,
    ),
    check(
      "print_jobs_size_check",
      sql`${table.artifactSizeBytes} IS NULL OR ${table.artifactSizeBytes} > 0`,
    ),
    check("print_jobs_version_check", sql`${table.version} >= 1`),
    uniqueIndex("print_jobs_user_idempotency_idx").on(
      table.userId,
      table.idempotencyKey,
    ),
    index("print_jobs_user_created_idx").on(table.userId, table.createdAt),
    index("print_jobs_status_created_idx").on(table.status, table.createdAt),
  ],
);

export const mcpTokens = sqliteTable(
  "mcp_tokens",
  {
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => authUsers.id, { onDelete: "restrict" }),
    expiresAt: text("expires_at"),
    id: text("id").primaryKey(),
    lastUsedAt: text("last_used_at"),
    name: text("name").notNull(),
    revokedAt: text("revoked_at"),
    scopes: text("scopes").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
  },
  (table) => [
    index("mcp_tokens_expiry_idx").on(table.expiresAt, table.revokedAt),
  ],
);

export const mcpRecipeApprovals = sqliteTable("mcp_recipe_approvals", {
  approvedAt: text("approved_at").notNull(),
  approvedBy: text("approved_by")
    .notNull()
    .references(() => authUsers.id, { onDelete: "restrict" }),
  recipeId: text("recipe_id")
    .primaryKey()
    .references(() => recipes.id, { onDelete: "cascade" }),
});

export const mcpRateWindows = sqliteTable("mcp_rate_windows", {
  requestCount: integer("request_count").notNull().default(0),
  tokenId: text("token_id")
    .primaryKey()
    .references(() => mcpTokens.id, { onDelete: "cascade" }),
  windowStartedAt: text("window_started_at").notNull(),
});

export const mcpUseRecords = sqliteTable(
  "mcp_use_records",
  {
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    outcome: text("outcome").notNull(),
    resultCount: integer("result_count").notNull().default(0),
    tokenId: text("token_id").references(() => mcpTokens.id, {
      onDelete: "set null",
    }),
    tool: text("tool").notNull(),
  },
  (table) => [
    check(
      "mcp_use_records_outcome_check",
      sql`${table.outcome} IN ('success','denied','rate_limited','error')`,
    ),
    index("mcp_use_records_token_created_idx").on(
      table.tokenId,
      table.createdAt,
    ),
  ],
);

export const recipes = sqliteTable(
  "recipes",
  {
    aggregate: text("aggregate").notNull(),
    createdAt: text("created_at").notNull(),
    deletedAt: text("deleted_at"),
    fingerprint: text("fingerprint").notNull(),
    id: text("id").primaryKey(),
    sourceCanonicalUrl: text("source_canonical_url"),
    title: text("title").notNull(),
    updatedAt: text("updated_at").notNull(),
    variantOfId: text("variant_of_id"),
    version: integer("version").notNull(),
  },
  (table) => [
    index("recipes_active_updated_idx").on(table.deletedAt, table.updatedAt),
    index("recipes_fingerprint_idx").on(table.fingerprint),
    index("recipes_source_idx").on(table.sourceCanonicalUrl),
    index("recipes_variant_idx").on(table.variantOfId),
  ],
);

export const recipeRevisions = sqliteTable(
  "recipe_revisions",
  {
    createdAt: text("created_at").notNull(),
    id: text("id").primaryKey(),
    reason: text("reason").notNull(),
    recipeId: text("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    snapshot: text("snapshot").notNull(),
    version: integer("version").notNull(),
  },
  (table) => [
    index("recipe_revisions_recipe_idx").on(table.recipeId, table.version),
  ],
);
