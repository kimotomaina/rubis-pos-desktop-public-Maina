# Phase 124 — Item 0: toolchain repaired, and what broke it

**Date:** 2026-09-23 · **Branch:** `staging` @ `8871592`

## Repair

```
git checkout -- package.json   → 28 scripts, 18 devDependencies, test/typecheck/dist present
npm run typecheck              → clean (node + web)
npm test                       → 89 files, 1384 tests, all passing
```

The restore leaves `package.json` identical to `HEAD`, so there is nothing in
it to commit. The commits that follow record the audit documents and the
Item 1 config, each on its own.

## Cause

**Almost certainly, one of this session's read-only investigation agents
extracted the packaged app's `package.json` over the repository's copy.**

| Evidence | Finding |
| --- | --- |
| The damaged file's shape | 1,051 bytes, with no `scripts`, no `devDependencies` and no trailing newline. |
| `package.json` inside `release/win-unpacked/resources/app.asar` | **1,051 bytes, with no `scripts`, no `devDependencies` and no trailing newline.** electron-builder strips exactly those two blocks when it packages the app. |
| Was there a build at 20:03? | No. `app.asar` and the release `.exe` files are dated 2026-09-12. Nothing else in the repository changed between 19:50 and 20:10 apart from this session's own docs. |
| Who was reading the packaged app then? | The "offline sync and fresh install" agent, which ran from about 19:59 to 20:03. Its report quotes the packaged `package.json` (*"The packaged `package.json` has no `productName`"*) and says it searched `app.asar`. |

The usual way to read one file out of an asar archive is
`asar extract-file <archive> package.json`. That command writes the file into
the **current directory**, which here was the repository root. It overwrites
`./package.json` with the packaged copy, which matches the evidence exactly.

**Limits of this finding.** The agents' transcripts were not kept, since their
task output files are empty, so the exact command cannot be quoted. The size,
the shape and the timing all point to this one agent.

**Lesson.** A "read-only" instruction to an agent that holds shell and write
tools is a request, not a control. As instructed, **no more parallel
investigation agents will run against this repository.** Audits are now done
directly.
