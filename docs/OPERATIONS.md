# Found & Made operations

Found & Made is deployed as one server container. The desktop development
environment is only a build and verification workspace; it is not the runtime
target. All durable production state belongs in the server volume mounted at
`/data`.

## Public origin and reverse proxy

Set `PUBLIC_ORIGIN` to the one exact browser-facing origin. Production requires
HTTPS unless `ALLOW_INSECURE_PUBLIC_ORIGIN=true` is deliberately set for a
local/LAN-only HTTP installation. The application rejects incomplete Google
configuration and derives OAuth, invitation, recovery, canonical, and social
URLs from this value rather than request forwarding headers.

Unsafe browser requests must carry matching Origin/Fetch Metadata. Rate limits
are process-local and partition authentication, upload/import, and general
traffic. If a reverse proxy supplies client addresses, list only its explicit
addresses or CIDRs in `TRUSTED_PROXY_RANGES`; otherwise forwarded addresses are
ignored. The proxy should preserve the original Host, enforce HTTPS, cap request
bodies at or below the application's 101 MiB import and 21 MiB media envelopes,
and apply a bounded request timeout. The application still streams and enforces
its own tighter per-file limits.

Do not weaken the emitted Content Security Policy to add arbitrary external
scripts or media. HSTS is emitted on HTTPS production responses. Private and
API responses are `no-store`, `/data` is never web-mounted, and unexpected
errors expose only a correlation ID.

## Hermes MCP

The `/mcp` endpoint is disabled by default. Enable it only on the server and
keep it on a LAN, VPN, or comparably private network boundary. Do not publish it
through an unrestricted Internet-facing proxy.

Required environment variables:

```text
MCP_ENABLED=true
MCP_ALLOWED_HOSTS=recipes.internal.example
MCP_ALLOWED_ORIGINS=http://hermes.internal
MCP_REQUEST_RATE_LIMIT=120
```

`MCP_ALLOWED_HOSTS` contains comma-separated Host header names without schemes,
paths, or ports. `MCP_ALLOWED_ORIGINS` contains comma-separated exact origins.
Hermes must send one of those exact values as its `Origin` header. Optionally
restrict the direct peer addresses as well:

```text
MCP_ALLOWED_CIDRS=10.20.30.0/24,fd00:1234::/64
```

CIDR checks use the socket peer address and deliberately ignore forwarding
headers. When a reverse proxy is unavoidable, allow only the proxy's internal
address and enforce the end-client network boundary at that proxy.

After the server starts, an Owner uses **Integrations** to approve individual
recipes and issue a separate expiring `recipes:read` token. The raw token is
shown once. Configure Hermes with:

- Streamable HTTP URL: `https://recipes.internal.example/mcp`
- `Authorization: Bearer <clear-once token>`
- `Origin: http://hermes.internal`

Publication does not imply Hermes approval. Revoking a token or removing a
recipe approval takes effect on the next request. The endpoint exposes only the
six documented read-only tools and supports the stable 2026 protocol plus the
stateless 2025-era Streamable HTTP requests used by current Hermes clients.

## Exports

Signed-in readers can download an authorized recipe JSON document from
**Exports**. An Owner can create a complete checksummed library and sanitized
media export. Complete exports remain under `/data/exports`; the web application
shows only the opaque artifact name and manifest checksum and never mounts that
directory for HTTP access.

## Backup

A cold copy of the entire stopped `/data` volume remains the authoritative
backup. The image also includes a bounded online backup command that uses
SQLite's backup API and checksums the other durable files:

```sh
docker exec found-and-made node backup-cli.js create
docker exec found-and-made node backup-cli.js verify /data/backups/backup-...
```

The online command prints structured JSON. Record the generation name and move
a verified copy off the server according to the server's normal backup policy.

Restore is intentionally a stopped, separate-volume operation. Stop the web
container, mount the verified backup as a source, mount a different empty volume
at `/restore`, and run the image with its backup command instead of the normal
server command:

```sh
docker run --rm \
  -e PUID=1000 -e PGID=1000 \
  -v /server/backup-source:/backup:ro \
  -v /server/restore-parent:/restore-parent \
  found-and-made:local \
  node backup-cli.js restore \
    /backup/backup-... \
    /restore-parent/empty-restore-volume
```

Mount the restore target's parent rather than the empty target itself. Restore
verification stages a sibling directory and atomically renames it into place;
a container mount point cannot be renamed. Prepare the empty target so the
configured `PUID:PGID` can write its parent and the same identity can read the
backup source. If server backup policy intentionally makes the manifest
root-readable only, run this stopped, one-shot restore utility as root and
return the restored tree to the configured application ownership before it is
mounted by the web container. The restore command refuses the configured live
`DATA_DIR`, a non-empty target, schema mismatch, symlinks, extra files,
traversal, or checksum failure. After a successful restore, mount the restored
volume as `/data`, start the normal container, and verify readiness plus
representative users, recipes, media, views, tokens, and print profiles before
retiring the previous volume.

## Upgrade and rollback

Treat an application upgrade and its automatic forward migration as one
change. Before replacing the running container:

1. Create and verify an online backup, then copy that generation off the
   application volume.
2. Record the current immutable image ID and keep that image available.
3. Build or pull the candidate image and exercise it against an isolated copy
   or restored backup before production cutover.
4. Stop and replace only the Found & Made container, preserving the exact
   `/data` mount, `PUID:PGID`, `PUBLIC_ORIGIN`, proxy, and optional integration
   configuration.
5. Verify `/health/ready`, the installation identity, sign-in, a private recipe
   and image, current migration count, and a clean startup log before declaring
   the change complete.

Application migrations are forward-only. If the new image must be abandoned
after it has migrated `/data`, stop it and restore the pre-upgrade backup into
a separate empty volume before starting the retained prior image. Never point
an older image at a database migrated by a newer release, and never copy only
the SQLite file while omitting keys, media, imports, exports, print artifacts,
or other durable state.
