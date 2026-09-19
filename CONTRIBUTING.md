# Contributing to Colloq

Thanks for helping. Colloq is a self-hosted live notebook for teaching: one
class link, shared notebooks, one Python kernel per notebook. It is maintained
by one person, so a clear issue or a small, well-verified pull request goes a
long way.

- Found a security problem? Do not open an issue. Follow [SECURITY.md](SECURITY.md).
- Have a question? See [SUPPORT.md](SUPPORT.md).
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

For anything larger than a bug fix, such as a new room mode, a new deployment
path, a new dependency or a change to the permission model, open an issue first
so we can agree on the approach before you write the code.

## Set up a development checkout

You need:

- **Node.js 22 or newer** and npm. Node 22 is also what the Docker image and
  the pip package require.
- **Docker** with a running daemon: Docker Desktop, colima or Docker Engine.
  Each class runs its Python kernel in its own container, even in development.
- **GNU Make** and **Python 3**. Python runs the documentation build, the
  release tooling and the pip packaging.

```bash
npm ci
make dev
```

On first launch, `make dev` writes a minimal `.env` with a fresh kernel token.
Every other setting is documented in `.env.example`. It then builds the room
kernel image (`colloq-kernel:<env>`) if it is missing or stale. After that it
runs the server with reload on `:3000` and Vite on `:5173`, and opens the
browser. Set `OPEN=0` if you don't want the browser opened. Claim the instance
at `/admin` with the setup token from `data/setup-token`, then create a class.

Ctrl+C saves the notebook and stops the session and its kernels. The database
and class files stay in `data/` and `workspace/`, and both are gitignored. You
can also use `make run` to run the optimized build in the background (`make
stop` ends it), or `make up` to run the whole stack inside Docker. `make help`
lists every target.

The development backend talks to the Docker socket. It is meant for a trusted
workstation, not as a production security boundary.

## Repository map

| Path | What lives there |
| --- | --- |
| `server/` | Express API, WebSockets, the server's Yjs participant, SQLite persistence, execution queues, kernel backends (`server/src/kernel/`) and the Oracle (AI assistant). |
| `web/` | Svelte 5 + Vite UI: the room, the teacher's console, the admin panel (`web/src/admin/`). Logic that needs no DOM lives in `web/src/lib/` so it can be tested. |
| `shared/` | Code used by server, web and CLI: notebook schema, room rules and permissions, protocol, i18n runtime and message catalogs (`shared/locales/`). |
| `cli/` | The `colloq` command and the session supervisor behind `make dev` and `colloq start`. |
| `python/` | The pip package: a standard-library shim that finds Node and runs the bundled app. `make pack` puts the app inside it. |
| `runtime/` | The private room broker for production (k3s). Node built-ins only. See [runtime/README.md](runtime/README.md). |
| `kernel/` | Kernel Dockerfile, base requirements and `kernel/environments/*.txt`. |
| `deploy/` | The single-node k3s guide (`deploy/k3s/README.md`), the one-image vast.ai deployment (`deploy/vast/`, see its README) and systemd units. `scripts/release.py` renders the Kubernetes manifests. |
| `scripts/` | Release build and validation, cluster install, backups, hosting (`host.sh`), and the e2e, perf, load and UI harnesses. Some scripts are maintainer-only (see below). |
| `docs/` | The public guides: article sources in `docs/pages/ru/` and `docs/pages/en/`, and `docs/build.py`, which renders them into `site/docs/`. The Markdown files are operator notes. |
| `site/` | The colloq.ru landing page and the generated docs, deployed by `.github/workflows/pages.yml`. |
| `tests/` | Unit tests on Node's built-in test runner. See [tests/README.md](tests/README.md). |

## Checks

```bash
npm run typecheck
npm test
```

`make check` runs both. CI (`.github/workflows/ci.yml`) runs the same checks
on every pull request. It also builds the pip wheel and the Docker images. To
run one file:

```bash
node --import tsx --import ./tests/_cli.mts --test --test-force-exit --test-concurrency=1 tests/<name>.test.mts
```

Keep all three flags and the preload. `--test-concurrency=1` is there because
the concurrent run silently under-reported tests. `tests/_cli.mts` keeps the
last results from being lost at forced exit. [tests/README.md](tests/README.md)
explains both.

The unit tests need no live server, browser or kernel. The end-to-end, perf and
load harnesses (`npm run e2e`, `npm run perf`, `make load`) need a running
**disposable** instance. Never point them at a real class.

Depending on what you change:

- Frontend or server build: `npm run build`. For the precompressed production
  build, run `npm run build:optimized`.
- Public guides: edit the article in `docs/pages/ru/` (Russian is the
  canonical set) and its English counterpart in `docs/pages/en/` if there is
  one. The page template lives in `docs/build.py`. Run `python3 docs/build.py`
  and commit the regenerated `site/docs/` together with the sources. See
  [docs/README.md](docs/README.md).
- The pip package: `make wheel`.

## Conventions that matter here

**Comments explain why.** The existing comments are in Russian. They are dense
and often record the incident or measurement behind a decision. When you change
code, keep the comment next to it true. Write new comments in the language of
the file around them. If Russian is a barrier, write them in English and say so
in the pull request. A clear reason matters more than the language.

**Every user-facing string is translated.** Text a person reads is a key in
`shared/locales/*.ts` with both `ru` and `en`, and it is rendered with
`tr(key, params)` from `shared/i18n.ts`. In Svelte, call `tr()` where the text
is shown, not in a module-level constant, so that a live language switch
updates it. Protocol values, file names and user content are never translated.
Three tests enforce this:

- `tests/i18n.test.mts` checks that both languages exist and have matching
  `{parameters}`.
- `tests/language-room.test.mts` rejects hard-coded Russian in room templates.
- `tests/admin-language.test.mts` checks the admin catalog.

**The server enforces permissions.** Hiding a button is not access control. A
new action needs a server-side check against the room's rules
(`shared/rules.ts`).

**Dependencies are added reluctantly.** Say in the pull request why a new
dependency is worth it. Some parts deliberately have none:

- the runtime broker uses only Node built-ins;
- the Python scripts and the pip shim use only the standard library;
- the pip package has no Python dependencies.

If `package-lock.json` changes, commit it; CI uses `npm ci`.

**Test without a browser where possible.** Move logic that needs no DOM into a
plain module and test it from `tests/`. A bug fix should come with a test that
fails without it.

**Formatting.** No formatter or linter is enforced. `.prettierrc` records the
TypeScript house style: single quotes, no semicolons, width 100. Match the file
you are in, and don't reformat code you are not otherwise changing.

## Verifying UI changes

Types and unit tests can't tell you whether a button works. For a UI change:

- Try it in `make dev` in both languages (the globe menu in `/admin`) and both
  colour themes. Where it matters, check it at phone and tablet widths.
- Run `make ui`. It builds the app, starts its own temporary instance and
  drives Chrome over the DevTools protocol (`scripts/ui-check.mts`). Set
  `CHROME=/path/to/chrome` if Chrome is not in the default macOS location, and
  `HEADED=1` to watch it. `make sync` checks that the lecture projector follows
  the teacher's console.
- Attach before and after screenshots, or a short recording, to the pull
  request.

## Commits and pull requests

- Keep one topic per pull request.
- Update the README or the guides (`docs/pages/`) when behaviour they
  describe changes.
- Never commit `.env`, `data/`, `workspace/`, `backups/`, keys or screenshots
  of real classes.
- Don't bump versions or edit [CHANGELOG.md](CHANGELOG.md), not even the
  maintainer. Both come from the release pull request that
  [release-please](https://github.com/googleapis/release-please) keeps open, as
  described in [RELEASING.md](RELEASING.md).

### The pull request title is a Conventional Commit

Pull requests are squash-merged, and the title becomes the commit on `main`.
release-please reads those commits to choose the next version and to write the
changelog, so **the title must be a
[Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/)**. The
commits on your branch can say anything; only the title lands on `main`. The
*PR title* check fails until the title has this form:

```text
type(scope): subject
type(scope)!: subject      <- a breaking change
```

- **subject**: an imperative English phrase about the effect a teacher,
  student or operator would notice, for example
  `fix(council): keep the queue after a kernel restart`. It becomes the
  changelog line, so write it for them, not for the diff. Use the pull request
  description to say why.
- **scope** is optional: the area you changed. Use one of `council`, `cli`,
  `server`, `web`, `docs`, `runtime` or `deploy`, or another short lowercase
  name when none fits (`oracle`, `kernel`, `i18n`).
- **type** decides the changelog section and the version bump:

| Type | Use it for | Changelog section | Bump while below 1.0 |
| --- | --- | --- | --- |
| `feat` | New behaviour people can use | Features | minor (0.2.0 → 0.3.0) |
| `fix` | A bug fix | Bug Fixes | patch (0.2.0 → 0.2.1) |
| `perf` | Faster or lighter, same behaviour | Performance | patch |
| `revert` | Undoing an earlier change: `revert: <the original title>` | Reverts | patch |
| `docs` | README, guides, operator notes | Documentation | patch |
| `refactor`, `style`, `test`, `build`, `ci`, `chore` | Everything users don't see | not listed | none on its own |

A user-visible change of behaviour is a `feat` or a `fix`, not a `refactor`:
anything under a hidden type never reaches the release notes. A pull request
with only hidden types doesn't start a release by itself; it rides along with
the next visible one.

**Breaking changes** get a `!` after the type or scope:
`feat(cli)!: drop the vast command`. They are listed under *⚠ BREAKING
CHANGES* in the release notes. Until 1.0, a breaking change bumps the minor
version, like a `feat`. Put the `!` in the title; a `BREAKING CHANGE:` footer
in a branch commit does not survive the squash merge.

GitHub's own revert button titles the pull request `Revert "..."`. Rename it to
`revert: <the original title>` before merging.

Some examples:

```text
feat(council): show an attempt to the class with its author
fix(web): keep the notebook where it was after a single run
perf(server): compress the first sync frame
docs(deploy): k3s upgrade steps
feat(runtime)!: require an explicit kernel memory limit
chore: update the Svelte toolchain
```

By submitting a contribution you agree that it is licensed under the project's
[MIT License](LICENSE).

## Maintainer-only tooling

Some scripts operate the maintainer's own infrastructure. They stay in the
repository because they show how the project runs its own deployment, but they
will not work for you as-is:

- `scripts/dns.sh`: the colloq.ru DNS zone on Cloudflare.
- `scripts/publish-site.mts` and `site/CNAME`: the colloq.ru site on GitHub
  Pages.

Others are shaped by the maintainer's setup but can be configured:

- The relay scripts (`relay-setup.sh`, `relay-assets.py`, `relay-capy.py`,
  `relay-offline.html`) are meant for any operator ("Your own relay" in the
  README), but they default to the project's `*.colloq.ru` zone. Run
  `relay-setup.sh` with `DOMAIN=your.zone`. It passes that zone on to the asset
  mirror it installs.
- `scripts/activity-sheet.py` exports class activity to the Google Sheet named
  by `ACTIVITY_SHEET_ID`, through an authorized `gws` CLI.
- `scripts/course-from-sheet.mts` imports a course plan from a published Google
  Sheet laid out like the maintainer's semester schedule.

Pull requests that make these usable for other operators are welcome. Issues
about the maintainer-only scripts failing on your own infrastructure have low
priority.
