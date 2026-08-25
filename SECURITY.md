# Security policy

## Supported version

Found & Made is in public beta. Only the latest published release is supported
with security fixes. Older images should be upgraded together with a verified
backup of the complete `/data` volume.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include private
recipe data, tokens, credentials, database files, backups, server addresses, or
unredacted logs in a report.

Use GitHub's private **Report a vulnerability** workflow for this repository.
Include the affected release, deployment shape, reproduction steps, expected
and observed behavior, and the smallest redacted evidence needed to understand
the boundary. If private reporting is unavailable, contact the repository owner
without publishing technical details and wait for a private channel.

## Deployment boundary

The `/mcp` endpoint is disabled by default and should remain LAN/VPN-bound.
`/data` must never be mounted as static web content. Public deployments require
HTTPS, an exact `PUBLIC_ORIGIN`, private-by-default content, and the documented
Host, Origin, proxy, upload, and backup controls in
[docs/OPERATIONS.md](docs/OPERATIONS.md).
