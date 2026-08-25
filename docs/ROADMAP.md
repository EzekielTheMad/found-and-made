# Found & Made v1 implementation roadmap

Every milestone must leave the repository integrated and testable. Dependent scope starts only after the previous milestone’s release gate is evidenced in `docs/STATUS.md`.

## Milestone 1: Foundations

Deliver:

- Git repository, AGPL license, package and module structure;
- React Router/Express TypeScript application;
- Drizzle/SQLite connection, migrations, health/readiness;
- `/data` contract, first-boot secrets, PUID/PGID entrypoint;
- embedded durable-job skeleton;
- multi-stage multi-architecture Dockerfile;
- lint, format, type, unit/integration, and CI jobs.

Gate:

- clean install and migration;
- a real database write/read through an application service;
- job claim/restart smoke test;
- healthy and deliberately unhealthy readiness checks;
- production build and container build exercised.

## Milestone 2: Recipe core

Deliver:

- canonical recipe aggregate, provenance, equipment, revisions, variants, trash;
- atomic, version-checked bulk moves to the recoverable recycle bin;
- manual editor with ingredient-to-step mapping and conflict detection;
- exact scaling, formatting, conversion boundary, impractical-count guidance;
- Classic, Guided, and Merge Grid projections and screens.

Gate:

- authored four-serving fixture agrees in all three views;
- 6/8/12 serving property and acceptance tests;
- ranges scale; time/temp/pan/package do not;
- base recipe remains unchanged and variant is independent;
- revisions, conflict, trash, and restore are exercised.

## Milestone 3: Identity and collaboration

Deliver:

- first-run Owner setup, local auth, optional Google auth;
- invitations, explicit account linking, session management;
- Owner/Editor/Viewer policies and shared/personal data boundaries;
- public mode, publication review, stable public route;
- SMTP reset and server-side single-use recovery command.

Gate:

- authorization matrix across services and routes;
- invite/link/unlink/recovery race and expiry tests;
- local first install exercised;
- Google flow exercised with representative configured credentials or a documented external verification blocker;
- private and published SSR outputs inspected.

## Milestone 4: Media and discovery

Deliver:

- sanitized originals, web derivatives, captions/alt/crop/focal/reorder;
- controlled Categories with aliases, user-defined Labels, collections, search, and saved views;
- bulk Category and Label addition/removal from filtered library results;
- authenticated and public home configuration;
- Schema.org, Open Graph, social cards, privacy-safe previews.

Gate:

- hero and step-photo flow plus EXIF proof;
- Weeknight view excludes holiday content;
- published and unpublished crawler/media rejection cases;
- responsive home/library and empty/loading/denied states.

## Milestone 5: Imports

Deliver:

- durable staged import pipeline with progress, retry, automatic private save,
  and retained warnings;
- source-aware text, website, image, PDF, audio/video and social-URL adapters;
- bounded bulk JSON/ZIP adapters for Mealie, Tandoor Recipes, Nextcloud
  Cookbook, and Schema.org/JSON-LD-compatible exports;
- official metadata-first acquisition and blocked-source fallback;
- safely acquired and sanitized website hero images;
- bounded standardized Recipe type inference, exact-duplicate skipping, and
  batch failure summaries with retry-all-failed;
- OpenAI-compatible provider boundary;
- ingredient normalization, provenance, confidence, duplicates, mappings.

Gate:

- representative source matrix automatically creates private recipes;
- crash/lease recovery and idempotent retry;
- blocked sources preserve user material and offer fallback;
- brand-sensitive normalization preserves original wording and an editable best
  guess;
- imports remain private and never auto-publish.
- bulk migration expansion is atomic, imports native Mealie hero images, and
  every recipe remains independently editable.
- website images use the shared SSRF/media boundaries, arbitrary source tags do
  not create arbitrary Categories or Labels, and exact active duplicates do not create another copy.

## Milestone 6: Cooking and offline PWA

Deliver:

- installable PWA and controlled cache policy;
- cooking mode, wake lock, timers, check-offs, progress;
- favorites, recent state, notes, ratings, cooking history;
- offline index/snapshots and personal-state reconciliation.

Gate:

- install and offline launch;
- lock/reload timer and step-state continuity;
- cached/uncached distinctions;
- reconnect sync is idempotent;
- logout/account switch removes protected local state;
- network-only operations reject offline queueing.

## Milestone 7: Printing and cookbooks

Deliver:

- individual and bulk selection;
- five layouts, per-recipe serving/layout overrides;
- reusable print profiles and collections;
- builder outline, preview, fit checker, covers/dividers/notes;
- modular unnumbered defaults and optional fixed edition.

Gate:

- every layout produces a readable PDF;
- preview and PDF scaling agree with recipe services;
- high-resolution authorized images and dependable breaks;
- overflow reports a specific remediation;
- Letter, A4, and Half-Letter representative output.

## Milestone 8: MCP, exports, backup and restore

Deliver:

- current Hermes-compatible Streamable HTTP MCP;
- six typed read-only tools and scoped token lifecycle/audit;
- recipe and full-library/media exports;
- online backup command, cold backup and restore procedures.

Gate:

- initialization, discovery, search/get/scaled calls;
- anonymous, expired, revoked, forbidden-Origin and mutation rejection;
- no draft/private-note/path leakage;
- fresh restore retains users, content, media, views, tokens, profiles;
- integrity and checksum validation.

## Milestone 9: Release hardening

Deliver:

- SSRF, redirect/DNS, upload, OAuth, CSRF, cookie, header, and rate-limit hardening;
- migration fixtures and recovery testing;
- WCAG AA, cooking AAA, keyboard, focus and reduced-motion review;
- 390/768/1440 responsive and high-fidelity visual review;
- full acceptance suite and operations documentation.

Gate:

- every v1 traceability row is verified or explicitly resolved;
- CI and production image checks pass;
- fresh install, upgrade, backup, and restore pass;
- end-to-end journeys and negative privacy/authorization cases pass;
- task-owned processes are stopped and limitations are documented.
