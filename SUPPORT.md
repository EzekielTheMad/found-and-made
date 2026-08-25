# Support

Use [GitHub Issues](https://github.com/EzekielTheMad/found-and-made/issues) for
installation help, configuration questions, and reproducible non-sensitive
bugs.

Include:

- Found & Made release tag and image tag;
- Unraid version or Docker/Compose version;
- CPU architecture (`amd64` or `arm64`);
- whether access is direct LAN HTTP or behind an HTTPS reverse proxy;
- the smallest reproduction steps and sanitized error text;
- whether `/health/ready` reports healthy.

Do not attach a database, backup, recipe export, full environment dump, browser
storage, cookies, credentials, private recipe text, or unredacted logs. Replace
hostnames, public origins, email addresses, IP addresses, tokens, and file paths
with clear placeholders.

For Unraid, first confirm that **Public Origin** exactly matches the address in
the browser, including scheme and non-default port. See
[docs/UNRAID.md](docs/UNRAID.md) for the installation checklist and common
failures.

Suspected vulnerabilities must use the private reporting process in
[SECURITY.md](SECURITY.md), not a public support issue.
