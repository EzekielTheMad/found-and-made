import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { AuthorizationPolicy } from "../identity/authorization.policy";
import { systemPrincipal, type Principal } from "../identity/identity.types";
import type { RecipeService } from "../recipes/recipe.service.server";
import type {
  DiscoveryFilters,
  DiscoveryLayout,
  DiscoverySort,
  CollectionDetail,
  CollectionSummary,
  FacetGroup,
  FacetTerm,
  HomeSection,
  LabelSummary,
  RecipeClassification,
  RecipeSearchResult,
  SavedView,
} from "./discovery.types";

const allowedSorts = new Set<DiscoverySort>(["recent", "title", "created"]);
const allowedLayouts = new Set<DiscoveryLayout>(["cards", "list"]);

export class DiscoveryService {
  private readonly policy = new AuthorizationPolicy();

  constructor(
    private readonly sqlite: Database.Database,
    private readonly recipes: RecipeService,
  ) {}

  createFacetGroup(
    principal: Principal,
    input: { name: string; position?: number; slug?: string },
    now = new Date(),
  ): string {
    this.policy.require(principal, "instance:manage");
    const name = requiredName(input.name, "Facet group name");
    const slug = normalizedSlug(input.slug ?? name);
    const id = randomUUID();
    const timestamp = now.toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO facet_groups (id, name, slug, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, name, slug, position(input.position), timestamp, timestamp);
    return id;
  }

  facetGroups(principal: Principal): FacetGroup[] {
    this.policy.require(principal, "recipe:read");
    return this.sqlite
      .prepare(
        `SELECT id, name, slug, position FROM facet_groups
         ORDER BY position, name COLLATE NOCASE, id`,
      )
      .all() as FacetGroup[];
  }

  createFacetTerm(
    principal: Principal,
    input: {
      aliases?: readonly string[];
      groupId: string;
      name: string;
      parentId?: string;
      position?: number;
      slug?: string;
    },
    now = new Date(),
  ): FacetTerm {
    this.policy.require(principal, "instance:manage");
    const name = requiredName(input.name, "Facet term name");
    const group = this.sqlite
      .prepare("SELECT id FROM facet_groups WHERE id = ?")
      .get(input.groupId);
    if (!group) throw new Error("Facet group not found");
    if (input.parentId) {
      const parent = this.sqlite
        .prepare("SELECT group_id AS groupId FROM facet_terms WHERE id = ?")
        .get(input.parentId) as { groupId: string } | undefined;
      if (!parent || parent.groupId !== input.groupId) {
        throw new Error("Facet parent must belong to the same group");
      }
    }
    const id = randomUUID();
    const timestamp = now.toISOString();
    const aliases = uniqueNames(input.aliases ?? []);
    this.sqlite
      .transaction(() => {
        this.sqlite
          .prepare(
            `INSERT INTO facet_terms
             (id, group_id, parent_id, name, slug, position, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.groupId,
            input.parentId ?? null,
            name,
            normalizedSlug(input.slug ?? name),
            position(input.position),
            timestamp,
            timestamp,
          );
        const insert = this.sqlite.prepare(
          "INSERT INTO facet_term_aliases (term_id, alias) VALUES (?, ?)",
        );
        for (const alias of aliases) insert.run(id, alias.toLowerCase());
      })
      .immediate();
    this.ensureStarterViews(systemPrincipal, now);
    return this.term(id);
  }

  terms(principal: Principal, groupId?: string): FacetTerm[] {
    this.policy.require(principal, "recipe:read");
    const rows = this.sqlite
      .prepare(
        `SELECT id, group_id AS groupId, parent_id AS parentId, name, slug, position
         FROM facet_terms ${groupId ? "WHERE group_id = ?" : ""}
         ORDER BY position, name`,
      )
      .all(...(groupId ? [groupId] : [])) as Array<TermRow>;
    return rows.map((row) => this.toTerm(row));
  }

  findTerms(principal: Principal, query: string): FacetTerm[] {
    this.policy.require(principal, "recipe:read");
    const needle = `%${query.trim().toLowerCase()}%`;
    if (needle === "%%") return [];
    const rows = this.sqlite
      .prepare(
        `SELECT DISTINCT t.id, t.group_id AS groupId, t.parent_id AS parentId,
          t.name, t.slug, t.position
         FROM facet_terms t LEFT JOIN facet_term_aliases a ON a.term_id = t.id
         WHERE lower(t.name) LIKE ? OR a.alias LIKE ? ORDER BY t.position, t.name`,
      )
      .all(needle, needle) as Array<TermRow>;
    return rows.map((row) => this.toTerm(row));
  }

  assignTerms(
    principal: Principal,
    recipeId: string,
    termIds: readonly string[],
  ): void {
    this.policy.require(principal, "recipe:edit");
    this.recipes.get(recipeId);
    const ids = uniqueIds(termIds);
    this.sqlite
      .transaction(() => {
        for (const termId of ids) this.term(termId);
        this.sqlite
          .prepare("DELETE FROM recipe_terms WHERE recipe_id = ?")
          .run(recipeId);
        const insert = this.sqlite.prepare(
          "INSERT INTO recipe_terms (recipe_id, term_id) VALUES (?, ?)",
        );
        for (const termId of ids) insert.run(recipeId, termId);
      })
      .immediate();
  }

  assignLabels(
    principal: Principal,
    recipeId: string,
    names: readonly string[],
    now = new Date(),
  ): void {
    this.policy.require(principal, "recipe:edit");
    this.recipes.get(recipeId);
    const labels = uniqueNames(names);
    const timestamp = now.toISOString();
    this.sqlite
      .transaction(() => {
        this.sqlite
          .prepare("DELETE FROM recipe_labels WHERE recipe_id = ?")
          .run(recipeId);
        const get = this.sqlite.prepare(
          "SELECT id FROM labels WHERE normalized_name = ?",
        );
        const create = this.sqlite.prepare(
          `INSERT INTO labels (id, name, normalized_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        );
        const attach = this.sqlite.prepare(
          "INSERT INTO recipe_labels (recipe_id, label_id) VALUES (?, ?)",
        );
        for (const name of labels) {
          const normalized = name.toLowerCase();
          const found = get.get(normalized) as { id: string } | undefined;
          const id = found?.id ?? randomUUID();
          if (!found) create.run(id, name, normalized, timestamp, timestamp);
          attach.run(recipeId, id);
        }
      })
      .immediate();
  }

  bulkUpdateClassification(
    principal: Principal,
    recipeIds: readonly string[],
    input: {
      labelNames: readonly string[];
      mode: "add" | "remove";
      termIds: readonly string[];
    },
    now = new Date(),
  ): void {
    this.policy.require(principal, "recipe:edit");
    const recipes = uniqueIds(recipeIds);
    const terms = uniqueIds(input.termIds);
    const labels = uniqueNames(input.labelNames);
    if (recipes.length < 1 || recipes.length > 500) {
      throw new Error("Bulk classification requires between 1 and 500 recipes");
    }
    if (terms.length === 0 && labels.length === 0) {
      throw new Error("Choose at least one taxonomy tag or freeform label");
    }
    for (const recipeId of recipes) this.recipes.get(recipeId);
    for (const termId of terms) this.term(termId);

    const timestamp = now.toISOString();
    this.sqlite
      .transaction(() => {
        if (input.mode === "add") {
          const attachTerm = this.sqlite.prepare(
            "INSERT OR IGNORE INTO recipe_terms (recipe_id, term_id) VALUES (?, ?)",
          );
          const getLabel = this.sqlite.prepare(
            "SELECT id FROM labels WHERE normalized_name = ?",
          );
          const createLabel = this.sqlite.prepare(
            `INSERT INTO labels (id, name, normalized_name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          );
          const attachLabel = this.sqlite.prepare(
            "INSERT OR IGNORE INTO recipe_labels (recipe_id, label_id) VALUES (?, ?)",
          );
          const labelIds = labels.map((name) => {
            const normalized = name.toLowerCase();
            const found = getLabel.get(normalized) as
              { id: string } | undefined;
            if (found) return found.id;
            const id = randomUUID();
            createLabel.run(id, name, normalized, timestamp, timestamp);
            return id;
          });
          for (const recipeId of recipes) {
            for (const termId of terms) attachTerm.run(recipeId, termId);
            for (const labelId of labelIds) attachLabel.run(recipeId, labelId);
          }
          return;
        }

        const detachTerm = this.sqlite.prepare(
          "DELETE FROM recipe_terms WHERE recipe_id = ? AND term_id = ?",
        );
        const detachLabel = this.sqlite.prepare(
          `DELETE FROM recipe_labels
           WHERE recipe_id = ? AND label_id IN (
             SELECT id FROM labels WHERE normalized_name = ?
           )`,
        );
        for (const recipeId of recipes) {
          for (const termId of terms) detachTerm.run(recipeId, termId);
          for (const label of labels)
            detachLabel.run(recipeId, label.toLowerCase());
        }
      })
      .immediate();
  }

  ensureAndAssignFacetTerms(
    principal: Principal,
    recipeId: string,
    input: {
      group: { name: string; slug: string };
      terms: ReadonlyArray<{ name: string; position: number; slug: string }>;
    },
    now = new Date(),
  ): string[] {
    this.policy.require(principal, "instance:manage");
    this.policy.require(principal, "recipe:edit");
    this.recipes.get(recipeId);
    const groupName = requiredName(input.group.name, "Facet group name");
    const groupSlug = normalizedSlug(input.group.slug);
    const terms = input.terms.map((term) => ({
      name: requiredName(term.name, "Facet term name"),
      position: position(term.position),
      slug: normalizedSlug(term.slug),
    }));
    const timestamp = now.toISOString();
    const result = this.sqlite
      .transaction(() => {
        let taxonomyChanged = false;
        let group = this.sqlite
          .prepare("SELECT id FROM facet_groups WHERE slug = ?")
          .get(groupSlug) as { id: string } | undefined;
        if (!group) {
          taxonomyChanged = true;
          group = { id: randomUUID() };
          this.sqlite
            .prepare(
              `INSERT INTO facet_groups
               (id, name, slug, position, created_at, updated_at)
               VALUES (?, ?, ?, 0, ?, ?)`,
            )
            .run(group.id, groupName, groupSlug, timestamp, timestamp);
        }
        const ids: string[] = [];
        for (const term of terms) {
          let found = this.sqlite
            .prepare(
              "SELECT id FROM facet_terms WHERE group_id = ? AND slug = ? LIMIT 1",
            )
            .get(group.id, term.slug) as { id: string } | undefined;
          if (!found) {
            taxonomyChanged = true;
            found = { id: randomUUID() };
            this.sqlite
              .prepare(
                `INSERT INTO facet_terms
                 (id, group_id, parent_id, name, slug, position, created_at, updated_at)
                 VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
              )
              .run(
                found.id,
                group.id,
                term.name,
                term.slug,
                term.position,
                timestamp,
                timestamp,
              );
          }
          this.sqlite
            .prepare(
              "INSERT OR IGNORE INTO recipe_terms (recipe_id, term_id) VALUES (?, ?)",
            )
            .run(recipeId, found.id);
          ids.push(found.id);
        }
        return { ids, taxonomyChanged };
      })
      .immediate();
    if (result.taxonomyChanged) this.ensureStarterViews(systemPrincipal, now);
    return result.ids;
  }

  labels(principal: Principal): LabelSummary[] {
    this.policy.require(principal, "recipe:read");
    return this.sqlite
      .prepare(
        `SELECT l.id, l.name, COUNT(rl.recipe_id) AS recipeCount
         FROM labels l LEFT JOIN recipe_labels rl ON rl.label_id = l.id
         GROUP BY l.id, l.name ORDER BY l.name COLLATE NOCASE, l.id`,
      )
      .all() as LabelSummary[];
  }

  recipeClassification(
    principal: Principal,
    recipeId: string,
  ): RecipeClassification {
    this.policy.require(principal, "recipe:read");
    this.recipes.get(recipeId);
    const termIds = this.sqlite
      .prepare(
        "SELECT term_id AS termId FROM recipe_terms WHERE recipe_id = ? ORDER BY term_id",
      )
      .all(recipeId)
      .map((row) => (row as { termId: string }).termId);
    const labelNames = this.sqlite
      .prepare(
        `SELECT l.name FROM labels l JOIN recipe_labels rl ON rl.label_id = l.id
         WHERE rl.recipe_id = ? ORDER BY l.name COLLATE NOCASE, l.id`,
      )
      .all(recipeId)
      .map((row) => (row as { name: string }).name);
    return { labelNames, termIds };
  }

  createCollection(
    principal: Principal,
    input: { description?: string; position?: number; title: string },
    now = new Date(),
  ): string {
    this.policy.require(principal, "instance:manage");
    const id = randomUUID();
    const timestamp = now.toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO collections (id, title, description, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        requiredName(input.title, "Collection title"),
        input.description?.trim() ?? "",
        position(input.position),
        timestamp,
        timestamp,
      );
    return id;
  }

  assignCollectionRecipes(
    principal: Principal,
    collectionId: string,
    recipeIds: readonly string[],
  ): void {
    this.policy.require(principal, "instance:manage");
    const exists = this.sqlite
      .prepare("SELECT id FROM collections WHERE id = ?")
      .get(collectionId);
    if (!exists) throw new Error("Collection not found");
    const ids = uniqueIds(recipeIds);
    this.sqlite
      .transaction(() => {
        for (const recipeId of ids) this.recipes.get(recipeId);
        this.sqlite
          .prepare("DELETE FROM collection_recipes WHERE collection_id = ?")
          .run(collectionId);
        const insert = this.sqlite.prepare(
          `INSERT INTO collection_recipes (collection_id, recipe_id, position)
           VALUES (?, ?, ?)`,
        );
        ids.forEach((recipeId, index) =>
          insert.run(collectionId, recipeId, index),
        );
      })
      .immediate();
  }

  collections(principal: Principal): CollectionSummary[] {
    this.policy.require(principal, "recipe:read");
    return this.sqlite
      .prepare(
        `SELECT c.id, c.title, c.description, c.position,
          COUNT(cr.recipe_id) AS recipeCount
         FROM collections c LEFT JOIN collection_recipes cr ON cr.collection_id = c.id
         GROUP BY c.id, c.title, c.description, c.position
         ORDER BY c.position, c.title COLLATE NOCASE, c.id`,
      )
      .all() as CollectionSummary[];
  }

  collection(principal: Principal, collectionId: string): CollectionDetail {
    this.policy.require(principal, "recipe:read");
    const summary = this.sqlite
      .prepare(
        `SELECT c.id, c.title, c.description, c.position,
          COUNT(cr.recipe_id) AS recipeCount
         FROM collections c LEFT JOIN collection_recipes cr ON cr.collection_id = c.id
         WHERE c.id = ? GROUP BY c.id, c.title, c.description, c.position`,
      )
      .get(collectionId) as CollectionSummary | undefined;
    if (!summary) throw new Error("Collection not found");
    const recipeIds = this.sqlite
      .prepare(
        `SELECT recipe_id AS recipeId FROM collection_recipes
         WHERE collection_id = ? ORDER BY position, recipe_id`,
      )
      .all(collectionId)
      .map((row) => (row as { recipeId: string }).recipeId);
    return { ...summary, recipeIds };
  }

  search(
    principal: Principal,
    filters: DiscoveryFilters = {},
    sort: DiscoverySort = "recent",
  ): RecipeSearchResult[] {
    this.policy.require(principal, "recipe:read");
    if (!allowedSorts.has(sort)) throw new Error("Unknown discovery sort");
    const include = uniqueIds(filters.includeTermIds ?? []);
    const exclude = uniqueIds(filters.excludeTermIds ?? []);
    const predicates = ["r.deleted_at IS NULL"];
    const parameters: unknown[] = [];
    const search = filters.search?.trim();
    if (search) {
      parameters.push(ftsQuery(search));
    }
    if (include.length) {
      predicates.push(
        `r.id IN (
          SELECT rt.recipe_id FROM recipe_terms rt WHERE rt.term_id IN (
            WITH RECURSIVE descendants(id) AS (
              SELECT id FROM facet_terms WHERE id IN (${placeholders(include.length)})
              UNION ALL SELECT t.id FROM facet_terms t JOIN descendants d ON t.parent_id = d.id
            ) SELECT id FROM descendants
          ) GROUP BY rt.recipe_id HAVING COUNT(DISTINCT rt.term_id) >= ?
        )`,
      );
      parameters.push(...include, include.length);
    }
    if (exclude.length) {
      predicates.push(
        `r.id NOT IN (
          SELECT rt.recipe_id FROM recipe_terms rt WHERE rt.term_id IN (
            WITH RECURSIVE descendants(id) AS (
              SELECT id FROM facet_terms WHERE id IN (${placeholders(exclude.length)})
              UNION ALL SELECT t.id FROM facet_terms t JOIN descendants d ON t.parent_id = d.id
            ) SELECT id FROM descendants
          )
        )`,
      );
      parameters.push(...exclude);
    }
    const order =
      sort === "title"
        ? "r.title COLLATE NOCASE, r.id"
        : sort === "created"
          ? "r.created_at DESC, r.id"
          : "r.updated_at DESC, r.id";
    const rows = this.sqlite
      .prepare(
        `SELECT r.id, r.title, r.updated_at AS updatedAt FROM recipes r
         ${search ? "JOIN recipe_search ON recipe_search.recipe_id = r.id AND recipe_search MATCH ?" : ""}
         WHERE ${predicates.join(" AND ")} ORDER BY ${order}`,
      )
      .all(...parameters) as RecipeSearchResult[];
    return rows;
  }

  createSavedView(
    principal: Principal,
    input: {
      criteria?: DiscoveryFilters;
      layout?: DiscoveryLayout;
      name: string;
      pinned?: boolean;
      sort?: DiscoverySort;
    },
    now = new Date(),
  ): SavedView {
    this.policy.require(principal, "user-data:manage");
    const userId = requireUser(principal);
    return this.insertView(
      {
        criteria: input.criteria ?? {},
        isStarter: false,
        layout: input.layout ?? "cards",
        name: input.name,
        pinned: input.pinned ?? false,
        sort: input.sort ?? "recent",
        userId,
      },
      now,
    );
  }

  ensureStarterViews(principal: Principal, now = new Date()): SavedView[] {
    this.policy.require(principal, "instance:manage");
    const starters = [
      {
        name: "Weeknight Dinner",
        criteria: { excludeTermIds: this.termIdsByName("Holiday") },
      },
      {
        name: "Breakfast",
        criteria: { includeTermIds: this.termIdsByName("Breakfast") },
      },
      {
        name: "Lunch",
        criteria: { includeTermIds: this.termIdsByName("Lunch") },
      },
      {
        name: "Dessert",
        criteria: { includeTermIds: this.termIdsByName("Dessert") },
      },
      {
        name: "Holiday & Seasonal",
        criteria: {
          includeTermIds: this.termIdsByName("Holiday", "Season", "Seasonal"),
        },
      },
      { name: "Quick Recipes", criteria: { search: "quick" } },
      { name: "Recently Added", criteria: {} },
    ];
    for (const starter of starters) {
      const existing = this.sqlite
        .prepare("SELECT id FROM saved_views WHERE is_starter = 1 AND name = ?")
        .get(starter.name) as { id: string } | undefined;
      if (!existing) {
        this.insertView(
          {
            criteria: starter.criteria,
            isStarter: true,
            layout: "cards",
            name: starter.name,
            pinned: starter.name === "Weeknight Dinner",
            sort: starter.name === "Recently Added" ? "created" : "recent",
          },
          now,
        );
      } else {
        this.sqlite
          .prepare(
            `UPDATE saved_views
             SET criteria = ?, sort = ?, layout = 'cards', pinned = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            JSON.stringify(normalizeCriteria(starter.criteria)),
            starter.name === "Recently Added" ? "created" : "recent",
            starter.name === "Weeknight Dinner" ? 1 : 0,
            now.toISOString(),
            existing.id,
          );
      }
    }
    return this.listSavedViews(principal);
  }

  listSavedViews(principal: Principal): SavedView[] {
    this.policy.require(principal, "recipe:read");
    const userId = principal.kind === "user" ? principal.userId : null;
    const rows = this.sqlite
      .prepare(
        `SELECT id, name, criteria, sort, layout, pinned, is_starter AS isStarter,
          user_id AS userId FROM saved_views
         WHERE is_starter = 1 OR user_id = ? ORDER BY is_starter DESC, pinned DESC, name`,
      )
      .all(userId) as Array<SavedViewRow>;
    return rows.map(toSavedView);
  }

  setDefaultView(
    principal: Principal,
    viewId: string | undefined,
    now = new Date(),
  ): void {
    this.policy.require(principal, "user-data:manage");
    const userId = requireUser(principal);
    if (!viewId) {
      this.sqlite
        .prepare("DELETE FROM user_default_views WHERE user_id = ?")
        .run(userId);
      return;
    }
    const view = this.sqlite
      .prepare(
        `SELECT id FROM saved_views
         WHERE id = ? AND (is_starter = 1 OR user_id = ?)`,
      )
      .get(viewId, userId);
    if (!view) throw new Error("Saved view is not available to this user");
    this.sqlite
      .prepare(
        `INSERT INTO user_default_views (user_id, saved_view_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET saved_view_id = excluded.saved_view_id,
           updated_at = excluded.updated_at`,
      )
      .run(userId, viewId, now.toISOString());
  }

  defaultView(principal: Principal): SavedView | undefined {
    this.policy.require(principal, "user-data:manage");
    const userId = requireUser(principal);
    const row = this.sqlite
      .prepare(
        `SELECT v.id, v.name, v.criteria, v.sort, v.layout, v.pinned,
          v.is_starter AS isStarter, v.user_id AS userId
         FROM user_default_views d JOIN saved_views v ON v.id = d.saved_view_id
         WHERE d.user_id = ? AND (v.is_starter = 1 OR v.user_id = ?)`,
      )
      .get(userId, userId) as SavedViewRow | undefined;
    return row ? toSavedView(row) : undefined;
  }

  configureHomeSection(
    principal: Principal,
    input: { config: Record<string, unknown>; position: number; title: string },
    now = new Date(),
  ): HomeSection {
    this.policy.require(principal, "instance:manage");
    if (!Number.isInteger(input.position) || input.position < 0) {
      throw new Error("Home section position must be non-negative");
    }
    const id = randomUUID();
    const timestamp = now.toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO home_sections (id, title, position, config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        requiredName(input.title, "Home section title"),
        input.position,
        JSON.stringify(input.config),
        timestamp,
        timestamp,
      );
    return {
      config: input.config,
      id,
      position: input.position,
      title: input.title.trim(),
    };
  }

  homeSections(principal: Principal): HomeSection[] {
    this.policy.require(principal, "recipe:read");
    const rows = this.sqlite
      .prepare(
        "SELECT id, title, position, config FROM home_sections ORDER BY position, id",
      )
      .all() as Array<{
      config: string;
      id: string;
      position: number;
      title: string;
    }>;
    return rows.map((row) => ({
      ...row,
      config: JSON.parse(row.config) as Record<string, unknown>,
    }));
  }

  private insertView(input: Omit<SavedView, "id">, now: Date): SavedView {
    if (!allowedSorts.has(input.sort) || !allowedLayouts.has(input.layout)) {
      throw new Error("Unknown saved view presentation");
    }
    const id = randomUUID();
    const timestamp = now.toISOString();
    const criteria = normalizeCriteria(input.criteria);
    this.sqlite
      .prepare(
        `INSERT INTO saved_views
         (id, user_id, name, criteria, sort, layout, pinned, is_starter, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.userId ?? null,
        requiredName(input.name, "Saved view name"),
        JSON.stringify(criteria),
        input.sort,
        input.layout,
        input.pinned ? 1 : 0,
        input.isStarter ? 1 : 0,
        timestamp,
        timestamp,
      );
    return { ...input, criteria, id };
  }

  private term(id: string): FacetTerm {
    const row = this.sqlite
      .prepare(
        `SELECT id, group_id AS groupId, parent_id AS parentId, name, slug, position
         FROM facet_terms WHERE id = ?`,
      )
      .get(id) as TermRow | undefined;
    if (!row) throw new Error("Facet term not found");
    return this.toTerm(row);
  }

  private toTerm(row: TermRow): FacetTerm {
    const aliases = this.sqlite
      .prepare(
        "SELECT alias FROM facet_term_aliases WHERE term_id = ? ORDER BY alias",
      )
      .all(row.id) as Array<{ alias: string }>;
    return {
      aliases: aliases.map((item) => item.alias),
      groupId: row.groupId,
      id: row.id,
      name: row.name,
      ...(row.parentId ? { parentId: row.parentId } : {}),
      position: row.position,
      slug: row.slug,
    };
  }

  private termIdsByName(...names: string[]): string[] {
    if (!names.length) return [];
    return this.sqlite
      .prepare(
        `SELECT id FROM facet_terms WHERE lower(name) IN (${placeholders(names.length)})`,
      )
      .all(...names.map((name) => name.toLowerCase()))
      .map((row) => (row as { id: string }).id);
  }
}

interface TermRow {
  groupId: string;
  id: string;
  name: string;
  parentId: string | null;
  position: number;
  slug: string;
}

interface SavedViewRow {
  criteria: string;
  id: string;
  isStarter: 0 | 1;
  layout: DiscoveryLayout;
  name: string;
  pinned: 0 | 1;
  sort: DiscoverySort;
  userId: string | null;
}

function toSavedView(row: SavedViewRow): SavedView {
  return {
    criteria: normalizeCriteria(JSON.parse(row.criteria) as DiscoveryFilters),
    id: row.id,
    isStarter: Boolean(row.isStarter),
    layout: row.layout,
    name: row.name,
    pinned: Boolean(row.pinned),
    sort: row.sort,
    ...(row.userId ? { userId: row.userId } : {}),
  };
}

function requiredName(value: string, label: string): string {
  const name = value.trim();
  if (!name || name.length > 120)
    throw new Error(`${label} is required and must be at most 120 characters`);
  return name;
}

function uniqueNames(values: readonly string[]): string[] {
  const names = values.map((value) => requiredName(value, "Name"));
  return [...new Map(names.map((name) => [name.toLowerCase(), name])).values()];
}

function uniqueIds(values: readonly string[]): string[] {
  if (values.some((value) => !value))
    throw new Error("Identifiers cannot be empty");
  return [...new Set(values)];
}

function normalizedSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  if (!slug) throw new Error("A usable slug is required");
  return slug;
}

function position(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0)
    throw new Error("Position must be a non-negative integer");
  return value;
}

function placeholders(length: number): string {
  return Array.from({ length }, () => "?").join(", ");
}

function ftsQuery(value: string): string {
  const terms = value.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!terms.length) throw new Error("Search needs letters or numbers");
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function normalizeCriteria(criteria: DiscoveryFilters): DiscoveryFilters {
  return {
    ...(criteria.search?.trim() ? { search: criteria.search.trim() } : {}),
    ...(criteria.includeTermIds?.length
      ? { includeTermIds: uniqueIds(criteria.includeTermIds) }
      : {}),
    ...(criteria.excludeTermIds?.length
      ? { excludeTermIds: uniqueIds(criteria.excludeTermIds) }
      : {}),
  };
}

function requireUser(principal: Principal): string {
  if (principal.kind !== "user")
    throw new Error("Saved views require a user account");
  return principal.userId;
}
