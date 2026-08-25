# Public release and Community Apps checklist

This is the maintainer runbook for publishing Found & Made without exposing
private development history or private UAT evidence.

## 1. Prepare the public repository

- Create the public repository `EzekielTheMad/found-and-made` from a clean,
  reviewed source snapshot rather than changing visibility on the private
  development repository. Build that snapshot with `git archive`; the checked
  `.gitattributes` excludes private process instructions, prototype handoff
  files, internal status evidence, and internal traceability evidence.
- Confirm the root contains `LICENSE`, `README.md`, `SECURITY.md`,
  `ca_profile.xml`, `icon.svg`, and `templates/found-and-made.xml`.
- Enable Issues and GitHub private vulnerability reporting.
- Set the description, homepage, and topics shown in the GitHub sidebar.
- Run a full source, history, filename, and artifact secret/privacy scan on the
  exact public snapshot.
- Confirm `AGENTS.md`, `design_handoff_found_and_made/`, `docs/STATUS.md`, and
  `docs/REQUIREMENTS_TRACEABILITY.md` are absent from the exported snapshot.

## 2. Publish the first container

- Confirm CI passes on the exact public commit.
- Create prerelease `v0.1.0-alpha.0` from that commit with notes derived from
  `CHANGELOG.md`.
- Wait for **Publish container** to produce `linux/amd64` and `linux/arm64`
  manifests and the `beta` tag.
- In GitHub Packages, make `found-and-made` public and confirm it is linked to
  the repository.
- Pull the public `beta` image without authentication and verify its digest,
  readiness, non-root identity, `/data` persistence, restart, and shutdown.

## 3. Verify the Unraid template

- Confirm every URL in `ca_profile.xml` and
  `templates/found-and-made.xml` is publicly reachable.
- Install the template on a clean Unraid appdata path using a LAN-only Public
  Origin and the default PUID/PGID.
- Complete first-run Owner setup, create a synthetic recipe, restart the
  container, and verify the recipe remains.
- Verify the WebUI shortcut, icon, screenshots, support link, project link,
  update detection, and complete removal behavior.
- Re-run the install behind HTTPS with the insecure-origin override disabled if
  that topology is part of the release claim.

## 4. Submit to Community Apps

- Sign in at <https://ca.unraid.net/submit/new>.
- Enter the public GitHub repository URL.
- Run **Validate**, resolve every error, then run **Scan**.
- Review the parsed profile, app description, image, category, icon,
  screenshots, paths, ports, and variables.
- Submit for moderator review.

Submitting the repository is an external representational action. Keep the
final portal review in the maintainer's authenticated session and do not submit
until the public image and clean-install evidence above pass.

## 5. After acceptance

- Install from the actual Community Apps listing on a clean path.
- Link an Unraid forum support thread from the template and `ca_profile.xml`
  when a stable thread exists.
- Watch the GitHub issue tracker and Community Apps moderator feedback.
- For each release, update `CHANGELOG.md`, publish a matching image tag, verify
  backup/upgrade/rollback behavior, and update the template only when its image
  channel or configuration contract changes.
