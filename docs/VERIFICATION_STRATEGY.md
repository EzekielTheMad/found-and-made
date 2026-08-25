# Found & Made v1 verification strategy

## Evidence model

Each requirement has:

- a stable requirement ID;
- an owning milestone and service boundary;
- deterministic automated coverage where practical;
- an end-to-end or manual evidence artifact when behavior crosses real browsers, OAuth providers, social unfurls, PDF engines, container architecture, or offline state;
- an explicit status in `docs/REQUIREMENTS_TRACEABILITY.md`.

Statuses are `Not started`, `Implemented`, `Automated`, `E2E verified`, `Externally blocked`, or `Resolved`. “Implemented” alone is never a release pass.

## Test layers

| Layer                | Purpose                                                                               |
| -------------------- | ------------------------------------------------------------------------------------- |
| Static               | formatting, lint, strict TypeScript, forbidden dependency/import boundaries           |
| Unit/property        | rational math, formatting, permissions, publication, reconciliation, pure projections |
| Database integration | migrations, repositories, constraints, transactions, job leases, revisions            |
| Service integration  | auth policies, import stages, media authorization, print/MCP DTO parity               |
| HTTP/SSR             | headers, cookies, CSRF, metadata privacy, status codes, rate limits                   |
| Browser E2E          | four product journeys, responsive behavior, offline/reconnect, accessibility          |
| Container            | boot, migration, PUID/PGID, health failure, persistence, signal shutdown              |
| Recovery             | upgrade fixtures, cold/online backup, restore, checksums and integrity                |
| External             | Google OIDC and compatible social unfurl/Hermes checks                                |

## Critical invariants

1. All projections use the same stored recipe revision and scaling service.
2. Temporary scaling cannot modify base recipe data.
3. Time, temperature, pan, appliance, and package settings never silently scale.
4. Authorization is enforced below routes and UI.
5. A private or unpublished identifier cannot produce recipe metadata or media.
6. Import jobs cannot publish.
7. Offline queues accept only the approved personal/cooking mutation set.
8. MCP service tokens cannot reach write services or private DTOs.
9. All durable artifacts needed for recovery reside below `/data`.

## Required fixtures

- canonical four-serving recipe with ranges, fractions, egg/package guidance, components, substitutions, equipment, mappings, temperature/time/pan metadata;
- Owner, Editor, Viewer, anonymous, expired invite, linked and unlinked identities;
- private, review-ready, published, trashed, conflicting-revision recipes;
- sanitized/unsanitized image corpus and malformed/mislabelled uploads;
- safe URL, redirects, rebinding simulation, private/link-local/metadata destinations;
- Mealie/Tandoor, website, text, scan, PDF, caption, audio/video import samples;
- offline cache and multi-device mutation scenarios;
- print overflow and every layout/page-size combination;
- database versions from each released migration boundary.

Fixtures must be synthetic or redistribution-safe and contain no credentials or personal data.

## Security and privacy tests

- CSRF rejection on cookie-authenticated mutations and strict same-origin checks;
- secure cookie and security-header inspection;
- generic authentication and recovery errors;
- URL parser, DNS answer, redirect, scheme, port, byte/time and decompression limits;
- upload magic-byte, parser failure, pixel/size and embedded payload cases;
- role matrix plus direct service invocation attempts;
- public/private HTML, JSON-LD, Open Graph, image, cache, crawler and error-body inspection;
- MCP bearer, expiry, revocation, scope, Origin, Host, CIDR, rate and unsupported-method rejection;
- logs and audit records checked for credential, token and private-content redaction.

## Accessibility and visual verification

- axe checks on every primary route and first-class state;
- keyboard-only navigation, ingredient mapping, check-offs, dialogs, reorder alternatives and focus return;
- 44px minimum targets, 56px cooking targets, AA globally and 7:1 cooking body text;
- reduced-motion screenshots and behavior;
- screenshots at 390px, 768px, desktop, and 1440px in both themes where applicable;
- print is always light and compared at representative page sizes;
- quantities/times/temperatures use IBM Plex Mono while ingredient names/UI use IBM Plex Sans;
- amber is interactive/active only; warnings always include a non-color cue.

## CI gates

## Efficient local loop

During implementation, run only the narrowest affected formatter, linter,
Vitest file, and Playwright spec. Do not rebuild between source-only test edits.
Use these bounded patterns:

```powershell
npm.cmd exec prettier -- --write path/to/changed-file.ts
npm.cmd exec eslint -- path/to/changed-file.ts
npx.cmd vitest run path/to/affected.test.ts
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test:e2e:spec -- tests/e2e/affected.spec.ts
```

Run `npm.cmd run check`, the production build/server verifier, the isolated
per-spec browser suite, and dependency/container gates once at the owning
milestone boundary. Browser specs receive separate temporary data roots and
server processes; the runner owns and records the exact server and Playwright
PIDs, caps startup at 20 seconds and the process at 90 seconds, and removes the
temporary data root in `finally`. Browser launch requires the explicit desktop
permission because the default sandbox rejects Chromium.

Pull-request CI runs static checks, unit/property tests, SQLite integration and migration smoke tests, the production build, focused Playwright smoke tests, and an amd64 image build.

Main/release CI adds the full browser/security suite, migration matrix,
backup/restore, and Buildx runtime gates for amd64 and QEMU-emulated arm64.
Release evidence records commands, versions, environment, exit status, and
artifact checksums.

## External verification

Google authentication, Discord-compatible unfurls, Hermes compatibility, and
native arm64 hardware acceptance require configured external systems. Tests use
mocks for deterministic protocol failure coverage, while CI boots the arm64
image under emulation. External release status remains open until representative
live workflows are exercised. No credentials enter the repository or captured
evidence.
