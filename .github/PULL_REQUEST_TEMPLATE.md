<!-- Title: a Conventional Commit, e.g. "fix(council): keep the queue after a kernel restart". It becomes the squash commit on main and the changelog line (CONTRIBUTING.md). -->

## What and why

<!-- What changes for teachers, students or operators, and why. Link the issue: "Closes #123". -->

## How it was verified

<!-- Commands you ran and what you checked by hand. For UI changes, attach before/after screenshots or a short recording. -->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes. A bug fix adds a test that fails without it.
- [ ] User-facing text goes through `tr()`, with both `ru` and `en` in `shared/locales/`. Nothing is hard-coded.
- [ ] UI changes were tried in the browser in both languages and both themes. Screenshots are attached, and `make ui` was run where it applies.
- [ ] Permissions are enforced on the server, not only hidden in the UI
- [ ] Docs are updated where behaviour changed (README, `docs/pages/ru` and `docs/pages/en`, then `python3 docs/build.py`)
- [ ] The title is a Conventional Commit (`feat`, `fix`, `perf`, `docs`, … with `!` if it breaks something) that reads well as a changelog line. `CHANGELOG.md` and versions are left to release-please.
- [ ] No new dependency, or the reason for it is given above
- [ ] Comments explain *why*, and the comments next to changed code are still true
- [ ] No secrets, `.env`, `data/`, `workspace/` or screenshots of real classes are committed
