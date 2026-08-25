# Efficient verification workflow

Found & Made uses a validation ladder. Run the smallest check that can disprove
the current change, then move outward once. Do not repeatedly run the complete
release gate while files are still changing.

## Validation ladder

1. Run the directly affected Vitest file or files with a 30-second command
   ceiling.
2. Run formatting, lint, or type checking only for the boundary changed.
3. For user journeys, build once and run the single affected Playwright spec.
4. After a coherent batch is stable, run `npm run check` and one production
   build.
5. At release-candidate time, reuse that build for one full browser suite,
   built-server verification, backup/restore proof, and the container gate.

Useful commands on Windows:

```powershell
npm.cmd exec vitest run tests/unit/example.test.ts
npm.cmd run build
npm.cmd run test:e2e:spec -- tests/e2e/recipe-core.spec.ts
npm.cmd run test:e2e:built
npm.cmd run verify:server
npm.cmd run verify:https-proxy
```

`test:e2e` builds first. Prefer `test:e2e:built` when the current production
bundle has already passed `npm run build`. Each browser spec gets an isolated
data directory and process tree, so a failure cannot contaminate the next spec.

## Runtime budgets and hang prevention

- Playwright process: 90 seconds per targeted run.
- Full-suite coordinator: 105 seconds per isolated spec.
- Browser/server cleanup: 5 seconds, exact PID tree only.
- GitHub application job: 15 minutes.
- GitHub container job: 30 minutes.
- Remote container verifier: 15 minutes by default, with both local and remote
  kill guards.

The runners emit structured start/complete events, PIDs, working directories,
and per-spec elapsed time. A nonzero Windows `taskkill` result is checked and
falls back to a bounded exact-child kill. No cleanup path may wait indefinitely
for a process exit.

If a command exceeds its expected range, stop at the last emitted event. Check
that exact PID, its children, port 4173, and its temporary data directory before
rerunning. Never kill all Node or browser processes by executable name.

## Reference timings

On the current Windows development host before final release hardening, the
normal ranges were:

| Gate                                            |   Reference time |
| ----------------------------------------------- | ---------------: |
| Focused Vitest batch                            |      3-6 seconds |
| Production build                                |      4-5 seconds |
| Full unit/integration check                     | about 42 seconds |
| Built-server, recovery, and backup verification | about 13 seconds |
| Seven-spec browser suite                        | about 68 seconds |
| Trusted HTTPS reverse-proxy verification        | about 11 seconds |

These are diagnostic baselines, not pass criteria. CI and the server may differ,
but a several-minute jump should identify a named step before another full run.

## CI and server responsibility

Pull requests build once, run the fast recipe browser smoke journey, and verify
the amd64 container. Main/release runs the full browser suite and boots the
arm64 image under QEMU to verify migration, readiness, non-root execution,
restart persistence, and graceful shutdown.
The desktop is a development client, not the deployment target. Final container
verification belongs on the intended server or an equivalent Linux builder and
must use the isolated remote verifier; it never writes to the protected
production appdata path or leaves its temporary image/container behind.

Optional visual checkpoints can be captured from the accessibility spec by
setting `VISUAL_CAPTURE_DIR`. Normal CI does not create them:

```powershell
$env:VISUAL_CAPTURE_DIR='C:\tmp\found-made-visual-review'
npm.cmd run test:e2e:spec -- tests/e2e/accessibility-responsive.spec.ts
```
