# Public release status

Found & Made is a public beta candidate. The core application and container are
implemented and release-gated; publication and Community Apps acceptance are
separate distribution steps.

## Verified release boundaries

- TypeScript, lint, formatting, deterministic unit/integration tests, and the
  production build;
- seven production browser journeys covering recipe lifecycle, imports, media,
  account and organization flows, offline cooking, exports/Hermes boundaries,
  and cookbook printing;
- trusted HTTPS proxy behavior, canonical origin enforcement, secure cookies,
  CSRF rejection, and forwarded-client rate limiting;
- fresh install, forward migrations, database-backed readiness, non-root
  storage ownership, restart persistence, graceful shutdown, backup creation,
  verification, and cold restore;
- `linux/amd64` runtime behavior and `linux/arm64` runtime behavior under QEMU;
- responsive and accessibility checks at phone, tablet, and desktop widths.

## External beta limitations

The following checks need representative third-party credentials, services, or
physical devices and are not claimed as complete:

- Google OAuth sign-in against a maintainer-controlled production client;
- social preview/unfurl behavior against a compatible public service;
- a live Hermes client against an explicitly enabled deployment;
- install, sleep, and wake behavior on representative physical mobile devices;
- representative physical duplex printing.

These integrations are optional. The local recipe library, local Owner
recovery, imports, cooking views, exports, backup/restore, and printing do not
require a cloud account.

## Distribution gates

Before the Community Apps submission is final:

1. publish a clean public source snapshot;
2. publish the signed-off prerelease and public multi-architecture GHCR image;
3. pull the image anonymously and complete a clean Unraid template install;
4. verify WebUI, persistence, restart, icon, screenshots, update behavior, and
   support links;
5. run Validate and Scan in the Community Apps submission portal, review the
   parsed listing, and submit it for moderation.

The exact maintainer checklist is in [PUBLIC_RELEASE.md](PUBLIC_RELEASE.md).
