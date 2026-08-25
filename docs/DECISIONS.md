# Architecture decision register

Last updated: 2026-07-30

## ADR-001: React Router Framework Mode with an Express composition root

Status: Accepted

Use the official Node custom-server pattern. React Router supplies SSR, typed route modules, progressive data mutations, and browser hydration; Express composes auth, security middleware, resource routes, MCP, and application lifecycle.

Rejected:

- Next.js App Router: its caching/RSC and custom-server constraints add complexity without a v1 requirement.
- A client-only SPA: cannot provide dependable public metadata, privacy-safe SSR, or crawler behavior.
- TanStack Start: not selected while its relevant full-stack surface is less mature for this release.

## ADR-002: SQLite plus Drizzle and one controlled data root

Status: Accepted

Use stable Drizzle with `better-sqlite3`, checked SQL migrations, explicit PRAGMAs, and `/data` as the only durable root.

Rejected:

- PostgreSQL: adds a service and backup surface contrary to the self-contained target.
- Prisma: adds generated/native deployment complexity without enough benefit for this SQLite-first product.
- LibSQL/Turso: introduces an unnecessary remote-capable dependency and divergent SQLite behavior.

## ADR-003: Vertical feature modules with shared application services

Status: Accepted

UI, REST, jobs, print, export, and MCP are adapters. They may depend on public feature services and DTOs, never tables or each other’s route handlers. Recipe scaling and publication policy have exactly one implementation.

## ADR-004: Exact rational quantities and projection-based scaling

Status: Accepted

Store exact rational range endpoints and typed units. Preserve original wording separately. Scale in a pure domain service and format only at presentation boundaries. Unit conversion is a separate transformation.

Rejected:

- Floating-point stored quantities: loses authored fraction fidelity.
- Mutating scaled copies in place: risks divergence between UI, print, export, and MCP.
- Scaling untyped numbers found in prose: would silently change times, temperatures, or pan sizes.

## ADR-005: Better Auth with explicit-only account linking

Status: Accepted

Use Better Auth’s React Router integration and Drizzle adapter. Disable implicit linking, different-email linking, open signup, and unlinking all methods. Add invitation, role, and Owner-local-recovery policies in the identity module.

The auth library handles protocols and sessions; application services remain authoritative for invitations, role permissions, recovery guarantees, and publication.

## ADR-006: SQLite lease-based durable jobs in the application process

Status: Accepted

Use a jobs table with atomic claims, leases, attempts, checkpoint artifacts, bounded retries, idempotency, and dead-letter state. Start the runner in the single server process; use bounded workers/children for heavy tools.

Rejected:

- Redis or a cloud queue: unnecessary second durable service.
- In-memory jobs: fail restart and recovery requirements.
- A separate container: violates the one-container deployment target.

## ADR-007: Explicit offline snapshots and mutation sync

Status: Accepted

Cache approved recipe snapshots and media; store cooking/personal state in per-user IndexedDB. Sync only personal/cooking mutations with idempotency and revisions. Do not queue shared recipe edits.

Rejected:

- Generic request replay: cannot enforce the product’s network-only operations safely.
- Full local database replication: far beyond v1 collaboration and conflict requirements.

## ADR-008: Browser-based print rendering from shared projections

Status: Accepted

Render React print documents with system Chromium and Playwright Core. Use the same projection and design tokens for preview and PDF.

Rejected:

- A separate PDF component model: likely to drift from preview and scaling behavior.
- Remote PDF service: unnecessary privacy and deployment dependency.

## ADR-009: Thin, read-only MCP adapter

Status: Accepted with protocol revalidation gate

Expose `/mcp` using the official TypeScript SDK and stable Streamable HTTP version confirmed with Hermes during milestone 8. Default to stateless JSON responses if compatible. Use separate bearer service tokens, Origin/Host validation, optional CIDR restriction, rate limiting, and approved read DTOs.

MCP never receives database, filesystem, import, private-note, draft, or mutation capabilities.

## ADR-010: Privacy policy precedes rendering and media resolution

Status: Accepted

Run visibility policy before selecting recipe fields, metadata, images, or cache keys. Private-link previews are built from an instance-only DTO rather than a redacted full-recipe DTO.

## ADR-011: Unraid is the production runtime target

Status: Accepted

Run the production amd64 container on the user's existing Unraid host. Mount the
Unraid appdata directory to `/data`, run as the host's non-root appdata identity,
and bind the approved host port only to the LAN address unless a later,
explicitly reviewed proxy configuration is added.

The development workstation may act as a temporary multi-architecture builder,
but it is not a hosting target and must not retain Found & Made containers,
volumes, images, or running Docker processes after verification. Server runtime
evidence and the arm64 build artifact are separate Milestone 1 gates.
