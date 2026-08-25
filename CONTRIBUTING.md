# Contributing to Found & Made

Thanks for helping improve Found & Made. Small, focused changes with a clear
user outcome are easiest to review.

## Before opening an issue

- Use [SUPPORT.md](SUPPORT.md) for installation and configuration questions.
- Search existing issues for the symptom or feature.
- Remove recipe content, email addresses, credentials, public origins, IP
  addresses, database files, and complete logs from anything public.
- Report suspected vulnerabilities privately through the process in
  [SECURITY.md](SECURITY.md).

## Development setup

Use Node.js 24 and npm:

```sh
npm ci
cp .env.example .env
npm run check
npm run build
npm run test:e2e:built:smoke
```

The complete browser and container gates are documented in
[docs/TESTING.md](docs/TESTING.md). Product scope comes from
[docs/PRD.md](docs/PRD.md), and architecture decisions come from
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/DECISIONS.md](docs/DECISIONS.md).

## Pull requests

- Keep recipe, scaling, publishing, privacy, and authorization rules in shared
  application services rather than duplicating them in routes or UI code.
- Keep server-only code in `.server` modules or server-only directories.
- Add deterministic regression coverage for behavior changes.
- Never commit secrets, real user content, production OAuth settings, databases,
  or private deployment evidence.
- Update user documentation and traceability when the behavior or release gate
  changes.

By contributing, you agree that your contribution is licensed under the
repository's AGPL-3.0-only license.
