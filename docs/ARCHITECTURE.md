# Found & Made v1 technical architecture

Status: Accepted baseline for implementation

Authority: `docs/PRD.md`

Last updated: 2026-07-30

## System shape

Found & Made is one TypeScript modular monolith delivered as one `linux/amd64` and `linux/arm64` container. One Node process, supervised by `tini`, owns:

- an Express 5 HTTP composition root;
- a React Router Framework Mode SSR application;
- REST/resource routes and Better Auth endpoints;
- a stateless Streamable HTTP MCP endpoint;
- a SQLite-backed durable job runner;
- bounded worker threads or child processes for CPU-heavy media, extraction, and PDF work.

All entrypoints call the same application service layer. Recipe interpretation, scaling, visibility, authorization, printing, exports, and MCP projections are not reimplemented at transport boundaries.

```text
Browser / PWA      Public crawlers      Hermes
      |                   |                |
      +----------- Express composition root -----------+
                          |
          React Router / REST / Auth / MCP adapters
                          |
             Application services and policies
        +---------+----------+----------+---------+
        | recipe  | identity | imports  | print   |
        | media   | taxonomy | cooking  | export  |
        +---------+----------+----------+---------+
                          |
          Repositories / job runner / file services
                          |
             SQLite + controlled /data files
```

## Selected stack

| Concern          | Selection                                                                     |
| ---------------- | ----------------------------------------------------------------------------- |
| Full-stack UI    | React 19, React Router Framework Mode 8.3, Vite                               |
| HTTP composition | Express 5 custom server                                                       |
| Validation       | Zod at transport and persisted-data boundaries                                |
| Authentication   | Better Auth 1.6 with email/password and optional Google                       |
| Persistence      | SQLite, Drizzle ORM 0.45, `better-sqlite3`                                    |
| PWA/offline      | Workbox through `vite-plugin-pwa`, IndexedDB through Dexie                    |
| Media            | Sharp plus magic-byte inspection                                              |
| PDF              | Shared React print projection rendered by Playwright Core and system Chromium |
| MCP              | `@modelcontextprotocol/server` 2.0, Streamable HTTP                           |
| Tests            | Vitest, Playwright, axe, property-based tests                                 |

Exact dependency versions are locked in the package lock and updated deliberately. The MCP adapter uses the stable 2026-07-28 server entry and its stateless 2025-era compatibility path for current Hermes clients; both share one tool factory so their surfaces cannot drift.

## Source layout

```text
app/
  components/              shared accessible UI
  routes/                  React Router screens and resource routes
  styles/                  tokens, themes, print and responsive styles
server/
  index.ts                 startup and HTTP composition root
  middleware/              headers, CSRF, limits, request context
src/
  modules/
    identity/
    recipes/
    taxonomy/
    media/
    imports/
    cooking/
    printing/
    integrations/
    recovery/
  platform/
    db/
    jobs/
    files/
    security/
    observability/
  shared/
    errors/
    ids/
    time/
drizzle/                   immutable forward migrations
tests/
  fixtures/
  integration/
  e2e/
  security/
```

Each feature module may expose domain types, application services, repository ports, and approved read models. Modules may not reach through another module to its tables.

## Persistence and data root

Production uses `/data` exclusively:

```text
/data/
  db/found-and-made.sqlite
  media/originals/
  media/web/
  imports/
  exports/
  print/
  keys/
  backups/
```

SQLite enables foreign keys, WAL, a bounded busy timeout, and short transactions. Durability-sensitive production operation uses `synchronous=FULL`. Startup:

1. validates the data-root path and ownership;
2. creates only known subdirectories;
3. creates first-boot secrets atomically with restrictive permissions;
4. refuses a database newer than the application;
5. creates a pre-migration snapshot and applies forward migrations;
6. runs a database-backed readiness check;
7. starts HTTP and the job loop.

The container entrypoint performs the narrow root-only ownership setup needed for configured PUID/PGID, then drops privileges before application startup.

## Canonical recipe boundary

The current recipe aggregate contains recipe identity and visibility, numeric base yield and descriptive yield, components, ingredient lines, steps, ingredient-to-step mappings, sub-recipe edges, equipment, taxonomy assignments, provenance references, media references, and an optimistic revision.

Quantities are lossless structured values:

- optional exact rational lower and upper endpoints;
- unit and physical dimension;
- count/package semantics;
- original source wording and private provenance;
- optional explicit conversion equivalents.

Text-only quantities such as “to taste” remain representable. Scaling is a pure projection using `target yield / base yield`; it never mutates stored values. Temperature, time, pan, appliance, and package values are typed separately and never silently scaled. Count/package impracticalities produce guidance.

`RecipeProjectionService` and `ScalingService` produce approved DTOs for Classic, Guided, Grid, cooking, print, export, and MCP. Revision snapshots are append-only; current rows remain queryable. Writes require the expected revision and return a conflict instead of silently overwriting concurrent edits.

## Identity, authorization, and publication

- First run atomically creates the initial Owner with a local password.
- Later accounts require a hashed, expiring, single-use invitation.
- Email/password is always enabled. Google is optional and requests only `openid`, `email`, and `profile`.
- Google identity is keyed by its stable provider subject and requires verified email.
- Implicit email-based linking is disabled. A signed-in user links Google explicitly.
- Different-email linking and unlinking the final method are disabled. An additional application guard preserves an Owner local-credential recovery path.
- Authorization is enforced by application policies for Owner, Editor, Viewer, anonymous, and service-token principals.
- New and imported recipes are private. Publication is an explicit Owner operation.

Public SSR loaders call `PublishingPolicy` before constructing HTML, JSON-LD, Open Graph, or image URLs. Unpublished URLs return generic instance/sign-in metadata only. Media is served through authorization-aware routes and `/data` is never static-mounted.

Anonymous publication uses a dedicated `PublicRecipeDto`; private provenance,
source wording, fingerprints, classification state, and revisions never cross
that projection. Publication is an explicit Owner-only operation recorded in
the audit trail.
Canonical, recovery, invitation, and social metadata URLs derive from the
validated `PUBLIC_ORIGIN`, never an untrusted request Host header.

## Durable jobs and imports

The SQLite job table records type, status, attempts, `available_at`, lease owner/expiry, idempotency key, progress, error category, and artifact references. Workers claim using an atomic immediate transaction, renew leases, resume expired work, retry with bounds, and dead-letter terminal failures.

Import jobs checkpoint:

`acquire -> extract -> structure -> normalize -> map -> duplicate -> prepare -> save`

The prepared result is saved automatically as a private recipe; warnings and
original wording remain available for later edits, and publishing never occurs
in the import job. Native Mealie backup images and discovered website recipe
photos are sanitized through the shared media service and attached as hero
images. Exact active source/fingerprint duplicates finish as skipped jobs,
while recycled recipes remain importable. Source categories and keywords map
to at most three terms from the managed Recipe type vocabulary; arbitrary
source tags never become taxonomy. The acquisition service never accepts
browser cookies. Its safe fetcher resolves and validates public
addresses, pins the approved destination, revalidates every redirect and DNS
result, limits bytes/time/redirects, and blocks loopback, private, link-local,
multicast, and metadata ranges.

## Offline boundary

The service worker caches the shell, approved media derivatives, and explicit per-user recipe snapshot responses. It does not cache authenticated SSR documents as the durable data model.

IndexedDB is namespaced by instance and user. It stores cached recipe/index snapshots, cooking sessions, timers, private personal notes, and pending personal-state mutations. Each mutation has a device ID, client mutation ID, idempotency key, aggregate revision, and field timestamp. The server deduplicates operations and returns reconciliation state.

Shared recipe-content editing, publishing, imports, and administration remain network-only. Logout or account switch purges the user namespace and protected caches. Timers persist `startedAt`, duration, and status so reload/sleep recovery is derived from time rather than an interval counter.

## Media, printing, exports, backup

Uploads pass through a streaming multipart boundary with aggregate, per-file,
per-field, file-count, field-count, and part-count limits even when content
length is absent or chunked. Aborted or oversized bodies cancel their reader
and create no temporary artifact. Accepted files are identified by magic bytes
before decode. Images are re-encoded to remove EXIF while retaining a
print-resolution sanitized original; derivatives are generated from it. Media
records own captions, alt text, ordering, crop, focal point, checksums, and
authorization.

Printing consumes the same recipe and scaling projections as the app. A worker renders controlled React print templates to static HTML, blocks external network requests, resolves only authorized local media, and asks system Chromium for PDF output with resource/page/time limits.

Cold backup is the authoritative recovery method: stop the container and copy all `/data`. The online backup command inventories durable files, uses SQLite’s backup API, copies controlled trees, and rejects the generation if the durable-file inventory changes across the snapshot window. Restore occurs while stopped into an absent or empty separate volume, then verifies SQLite integrity, schema compatibility, expected files, checksums, and application readiness before that volume replaces the prior mount.

## Observability and health

Logs are structured and redact secrets, auth headers, imported content, and private data. Audit events cover sign-in/security events, invitations, role and publication changes, service-token lifecycle/use, recovery, backup/restore, and import outcomes.

Liveness proves the process loop is responsive. Readiness performs a bounded database query and validates required writable directories. Dependency failures produce generic client errors with an internal correlation ID.

Every database open validates the immutable migration journal before serving a
request. Fresh and legacy histories move forward transactionally; future,
divergent, and unmanaged histories fail closed. A failed migration leaves the
prior schema and journal state intact.
