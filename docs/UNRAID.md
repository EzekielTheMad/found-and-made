# Unraid installation and operations

This guide covers the Found & Made Community Apps template. General Docker,
backup, restore, reverse-proxy, and optional integration details remain in
[OPERATIONS.md](OPERATIONS.md).

## Install

After the listing is accepted:

1. Open the Unraid **Apps** tab.
2. Search for **Found & Made** and choose **Install**.
3. Review the template fields below, especially **Public Origin**.
4. Apply the template and wait for the container health state to become
   healthy.
5. Open **WebUI** and create the first local Owner.

The first Owner is the durable local recovery identity. Google sign-in is
optional and does not replace it.

## Template fields

| Field                        | Default                            | Meaning                                                                                                      |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| WebUI Port                   | `3000`                             | Host port mapped to container port 3000. If changed, use the changed port in Public Origin.                  |
| Appdata                      | `/mnt/user/appdata/found-and-made` | Complete persistent `/data` tree. Back up the whole directory.                                               |
| Public Origin                | required, blank                    | Exact browser-facing origin, including `http://` or `https://` and any non-default port. No path is allowed. |
| Allow insecure public origin | `true`                             | Required for intentional HTTP LAN installs. Set `false` for HTTPS.                                           |
| PUID                         | `99`                               | Non-root process and storage owner user ID.                                                                  |
| PGID                         | `100`                              | Non-root process and storage owner group ID.                                                                 |
| Timezone                     | `Etc/UTC`                          | Optional IANA timezone such as `America/Phoenix`.                                                            |
| Trusted proxy ranges         | blank                              | Optional exact reverse-proxy IP addresses or CIDRs. Leave blank for direct LAN access.                       |

### Public Origin examples

Direct LAN install using the default port:

```text
http://UNRAID-IP:3000
```

HTTPS reverse proxy:

```text
https://recipes.example.com
```

The value must match what appears in the browser address bar. A mismatch can
cause setup, sign-in, or state-changing requests to be rejected by the origin
and CSRF boundary.

## Persistent data

The template maps one Unraid appdata directory to `/data`. Found & Made owns
the layout beneath that mount. Do not map the database or media subdirectories
individually, and never expose the directory through a static web server.

The default template also keeps the container root filesystem read-only and
uses a bounded temporary filesystem for `/tmp`.

## LAN versus public access

An HTTP Public Origin is accepted only when **Allow insecure public origin** is
`true`; this is intended for a trusted LAN. Do not forward the LAN port directly
to the public internet.

For public access:

1. terminate HTTPS at a maintained reverse proxy;
2. set Public Origin to the exact external HTTPS origin;
3. set Allow insecure public origin to `false`;
4. set Trusted proxy ranges only to the real proxy peer addresses or CIDRs;
5. preserve the Host and Origin headers described in [OPERATIONS.md](OPERATIONS.md).

Never use `0.0.0.0/0` as a trusted proxy range.

## Updates

The Community Apps beta follows the container tag `beta`. Before applying an
update:

1. create and verify a Found & Made backup;
2. record the currently running full image tag or digest;
3. retain the matching pre-upgrade backup outside the container;
4. apply the update and confirm `/health/ready` is healthy;
5. exercise sign-in, one representative recipe, and one media read.

Database migrations are forward-only. Reverting the image after a migration
also requires restoring the matching pre-upgrade backup.

## Backup and recovery

Use the application backup command documented in [OPERATIONS.md](OPERATIONS.md)
and keep a second copy outside the appdata directory. A complete stopped copy of
the appdata directory is also authoritative.

When SMTP recovery is not configured, the local Owner can create a short-lived
recovery URL from the Unraid terminal:

```sh
docker exec found-and-made node server.js recover-owner owner@your-domain.invalid
```

Treat the printed URL as a credential. It is single-use and replaces the local
password while revoking existing sessions.

## Optional variables

Google sign-in, SMTP, an OpenAI-compatible import provider, and the read-only
Hermes MCP endpoint are intentionally not included in the basic Community Apps
form. Add only the variables you need from [.env.example](../.env.example), and
follow [OPERATIONS.md](OPERATIONS.md) before enabling them.

## Troubleshooting

### Container does not start

- Confirm Public Origin is non-empty and is an absolute HTTP or HTTPS origin.
- For HTTP, confirm Allow insecure public origin is exactly `true`.
- Confirm the appdata directory is writable by PUID and PGID.
- Check for a host-port conflict on the selected WebUI port.

### Setup or sign-in returns an origin/CSRF error

Compare Public Origin character-for-character with the browser origin. Check
scheme, hostname or IP, and port. Do not include a trailing path.

### WebUI shortcut opens the wrong port

Edit the container, confirm the WebUI Port mapping, and put the same host port
in Public Origin.

### Health is unhealthy

Inspect only the recent container logs and redact private values before sharing
them. Readiness verifies the database and required writable data paths; storage
ownership or a full/unavailable appdata share is more likely than a UI problem.

For support, use the checklist in [../SUPPORT.md](../SUPPORT.md).
