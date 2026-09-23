# Releasing Colloq

Releases are made by [release-please](https://github.com/googleapis/release-please).
Nobody bumps the version by hand, the maintainer included:

1. Pull requests are squash-merged into `main`, and each title is a
   [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/)
   (`feat(council): …`, `fix: …`; see [CONTRIBUTING.md](CONTRIBUTING.md)).
2. On every push to `main`, the **Release Please** workflow opens or updates a
   pull request titled `chore(main): release X.Y.Z`. It is authored by you,
   through your personal token. It bumps every copy of the version, adds the
   `CHANGELOG.md` section, and CI runs on it like on any other pull request.
3. You review the version and the changelog. When you want to release, you merge
   it.
4. On that merge, release-please tags `vX.Y.Z` on the merge commit and creates
   the GitHub Release, with the notes from the pull request.
5. In the same run, the **Publish** workflow builds the pip wheel, attaches it to
   the release, and uploads to PyPI and GHCR if those are switched on.

Until you merge it, the release pull request just stays open and follows `main`.
Nothing is released by merging ordinary pull requests.

## Where the version lives

The version is stored in one place: `"version"` in the root `package.json`. It
uses [SemVer](https://semver.org/). The only pre-release labels allowed are
`-alpha.N`, `-beta.N` and `-rc.N`, because those are the ones PEP 440
understands too (`0.3.0-rc.1` becomes the wheel version `0.3.0rc1`).

| Kind | Where | Kept in step by |
| --- | --- | --- |
| **Source** | `package.json` | release-please (`release-type: node`) |
| Copy | `package-lock.json`: the root `version` and `packages[""]` | release-please (`release-type: node`) |
| Copy | `package-lock.json`: `packages["server" / "web" / "runtime" / "cli"]` | release-please, `extra-files` (JSON path) |
| Copy | `server/`, `web/`, `runtime/`, `cli/`, `shared/package.json` | release-please, `extra-files` (JSON path) |
| Copy | `python/colloq/_version.py` (hatchling reads the wheel version from here) | release-please, `extra-files` (the line marked `x-release-please-version`), and `scripts/pack.mts`, which writes the same text |
| Copy | `.release-please-manifest.json` (the last released version) | release-please |
| Derived | Teaching panel wordmark (`v0.1.0` next to the logo) | Vite `define` at build time |
| Derived | Server: `GET /api/health` → `"version"`, and the `colloq X ready` log line | JSON import, inlined by esbuild |
| Derived | `colloq --version` in the pip package | `scripts/pack.mts` writes `app/cli/package.json` |
| Derived | Git tag `vX.Y.Z` and the GitHub Release | release-please creates them; `publish.yml` checks the tag |
| Derived | Images `…:vX.Y.Z` and `release.json` for k3s | `scripts/release-build.py` defaults to `v` + `package.json` at the source commit and rejects any other `--version` |
| Derived | vast.ai image `ghcr.io/<owner>/colloq-vast:X.Y.Z` | `publish.yml` |

`make version` prints the version and fails if anything disagrees; CI runs the
same check (`node --import tsx scripts/version.mts check`) on every pull request,
the release pull request included. Besides comparing the copies, it:

- checks that `.release-please-manifest.json` matches `package.json`, so a
  version raised by hand, outside the release pull request, fails;
- checks that the top section of `CHANGELOG.md` is the current version and that
  no section appears twice;
- rehearses the edit release-please will make, offline, and fails if any copy
  would be left behind. A new workspace, or a new file that carries the
  version, must be added to `extra-files` in `release-please-config.json` in
  the same pull request that introduces it.

If a copy drifted, `node --import tsx scripts/version.mts sync` rewrites every
copy to the root `package.json` version. It never touches the manifest.

## How the next version is chosen

release-please reads the commits on `main` since the last release. Because pull
requests are squash-merged, each commit is one pull request title. Commits that
are not Conventional Commits are ignored.

| Commits since the last release | Below 1.0 (now) | From 1.0 on |
| --- | --- | --- |
| Any breaking change (`!`) | minor: 0.2.0 → 0.3.0 | major: 1.2.0 → 2.0.0 |
| Any `feat` | minor: 0.2.0 → 0.3.0 | minor: 1.2.0 → 1.3.0 |
| Only `fix`, `perf`, `revert`, `docs` | patch: 0.2.0 → 0.2.1 | patch |
| Only `refactor`, `style`, `test`, `build`, `ci`, `chore` | no release pull request | no release pull request |

Below 1.0 a breaking change bumps the minor version, like a `feat`
(`bump-minor-pre-major: true`), and a `feat` never shrinks to a patch
(`bump-patch-for-minor-pre-major: false`). The changelog shows *Features*,
*Bug Fixes*, *Performance*, *Reverts* and *Documentation*, plus
*⚠ BREAKING CHANGES*. The other types are hidden (`changelog-sections` in
`release-please-config.json`).

### Choosing the version yourself

- **A `Release-As` footer** (preferred, applies once). When you squash-merge a
  pull request, add a last line `Release-As: 0.4.0` to the commit description in
  the *Squash and merge* dialog. The next release pull request proposes exactly
  that version. The footer works on any type. With nothing else to release, a
  pull request titled `chore: release 0.4.0` carrying the footer is enough: a
  commit with the footer is listed in the notes (under *Chores*) even though
  `chore` is otherwise hidden, and that opens the release pull request.
- **`release-as` in `release-please-config.json`** (under `packages["."]`).
  It overrides any footer and pins every future release pull request to that
  version until you remove it, so remove it right after the release. It is used
  for the first release, below.

Going to 1.0.0 is always a deliberate `Release-As: 1.0.0`.

### Pre-releases

A pre-release is a `Release-As` with a label: `Release-As: 0.3.0-rc.0`. The
tag is `v0.3.0-rc.0`, the wheel is `0.3.0rc0`, `publish.yml` marks the GitHub
Release as a pre-release, and `:latest` of the vast.ai image does not move.
`pip` installs it only with `--pre` or an exact `==` pin.

When release-please bumps a pre-release it keeps the label (a `feat` after
`0.3.0-rc.0` would propose `0.4.0-rc.0`), so give every next pre-release, and
the final release, its own footer: `Release-As: 0.3.0-rc.1`, then
`Release-As: 0.3.0`.

## The first release (0.2.0)

The history is being rewritten before the first release, and the old commit
messages are not Conventional Commits. So the first release is pinned:
`release-please-config.json` has `"release-as": "0.2.0"` and a
`pull-request-header` that reminds you to remove it, and the manifest says
`0.1.0`.

1. **Set up the token and the repository settings** (next section).
2. **Push the rewritten `main`.** It needs at least one commit that appears in
   the changelog (`feat`, `fix`, `perf`, `revert`, `docs`, any type with `!`,
   or any commit with a `Release-As:` footer). Otherwise release-please logs
   "No user facing commits found" and opens nothing, `release-as` or not.

   Where release-please starts reading: it looks for the release of the
   manifest version, a GitHub Release or tag `v0.1.0`. If that tag is on the
   rewritten history, it reads the commits after it. If the tag is gone, or it
   points at a commit that is no longer on `main`, it reads the whole history,
   up to 500 commits (`commit-search-depth`). For 0.2.0 either is fine. To start
   later, set `"bootstrap-sha": "<sha>"` at the top level of the config: the
   commits after that one are read, and it is only used while no earlier
   release is found.
3. **Release Please opens `chore(main): release 0.2.0`.** Check the version,
   the files and the notes. The notes on the GitHub Release are taken from the
   pull request description (between the two `---` lines) at the moment you
   merge. You can replace them there, and the `CHANGELOG.md` section on the
   release branch, with hand-written notes. release-please rewrites both
   whenever `main` moves, so do it just before merging.
4. **Merge it.** The same run tags `v0.2.0`, creates the release and publishes.
5. **Unpin, before anything else is merged.** Open a pull request titled
   `chore(release): stop pinning the first release` that deletes `release-as`
   and `pull-request-header` from `release-please-config.json`, and merge it.
   It is a `chore`, so it does not open a release pull request by itself.

   If you forget, the next `feat` or `fix` on `main` makes release-please
   propose `release 0.2.0` again. CI fails on it (`CHANGELOG.md has two sections
   for 0.2.0`), and `make version` prints a note while `release-as` equals the
   current version. Close that pull request and do step 5.

## One-time setup (repository owner)

### The token: `RELEASE_PLEASE_TOKEN`

The workflow runs release-please with your fine-grained personal access token,
never with the workflow's `GITHUB_TOKEN`. There are two reasons:

- A pull request opened or updated with `GITHUB_TOKEN` does not trigger
  workflows, so the release pull request would have no CI.
- Its commits and the release would be authored by `github-actions[bot]`.

If the secret is missing, the job fails with an error saying so. It does not
fall back to `GITHUB_TOKEN`.

1. **Create the token** (Settings → Developer settings → Personal access tokens
   → Fine-grained tokens → Generate new token):
   - Resource owner: you.
   - Repository access: **Only select repositories** → this repository.
   - Repository permissions:

     | Permission | Access | Why |
     | --- | --- | --- |
     | Contents | Read and write | Release branch, its commit, tags and releases |
     | Pull requests | Read and write | Open and update the release pull request |
     | Issues | Read and write | The `autorelease: pending` / `autorelease: tagged` labels and the comment on the merged pull request (labels live in the issues API) |
     | Metadata | Read | Added automatically |

     Nothing else. It does not need *Workflows*: the release pull request never
     touches `.github/workflows`.
   - Expiration: set one and note the date. When the token expires, the job
     fails with `Bad credentials` and nothing is released half-way. Create a new
     token and replace the secret.
2. **Store it as the repository secret `RELEASE_PLEASE_TOKEN`** (Settings →
   Secrets and variables → Actions → Secrets → New repository secret). Only the
   release-please step receives it. That job has no checkout and runs no npm, so
   no third-party code runs next to the token. The action is pinned to a commit
   SHA, unlike the other actions here, for the same reason.

**"Allow GitHub Actions to create and approve pull requests"** (Settings →
Actions → General → Workflow permissions) is **not needed**. That setting only
controls `GITHUB_TOKEN`, and the release pull request is created with your
token. Leave it off.

### Merge settings

Settings → General → Pull Requests:

- **Allow squash merging**, with **Default commit message: Pull request title**.
  The title becomes the commit on `main`. The description stays out, so text in
  a description (a stray `BREAKING CHANGE:` or `Release-As:`) cannot change the
  version by accident.
- Turn off **Allow merge commits** and **Allow rebase merging**. A merge commit
  or rebased branch commits would put non-conventional messages on `main`.
- Optional: **Automatically delete head branches**. release-please creates its
  branch again for the next release.

### Branch and tag rules

- **`main`.** The release pull request is an ordinary pull request, so a ruleset
  on `main` needs **no bypass** for releases: nothing pushes to `main` directly
  any more. Required status checks work on it, because your token opens it and
  CI runs. You can require *Typecheck and tests*, *Build the pip wheel*,
  *Build Docker images (no push)* and *Conventional Commit title*. A **required
  approval** does not work for a single maintainer: you cannot approve your own
  pull requests, the release pull request included. Leave approvals at 0.
- **Tags.** Recommended: a tag ruleset on `v*` that restricts **updates** and
  **deletions**, so a published tag cannot be moved. If it also restricts
  **creations**, add yourself (or the *Repository admin* role) to its bypass
  list. release-please creates the tag through the API as you.

### PyPI and GHCR

Both are off until you switch them on. A version on PyPI or an image tag can
never be replaced, and the first release should not take the package name by
accident.

1. **Repository variables** (Settings → Secrets and variables → Actions →
   Variables):
   - `PUBLISH_PYPI` = `true` turns on the PyPI job.
   - `PUBLISH_IMAGES` = `true` turns on the vast.ai image job.

   If a variable is unset or has any other value, its job is skipped.
2. **PyPI API token.** Create a token on pypi.org (*Account settings → API
   tokens*), scoped to the project `colloq` once it exists, and store it as the
   secret `PYPI_API_TOKEN` of the **`pypi` environment**, not of the
   repository: only the approved PyPI job can read it.

   ```
   gh secret set PYPI_API_TOKEN -R colloq-edu/colloq --env pypi
   ```

   Trusted Publishing (no stored token) was the first plan and is still
   possible: `release-please.yml` starts `publish.yml` from the new tag with
   `workflow_dispatch` rather than calling it as a reusable workflow, which
   PyPI does not support — the one reusable attempt (v0.2.0) was refused with
   `invalid-publisher`. To switch, add a publisher on pypi.org with Owner
   `colloq-edu` (the GitHub owner, not the PyPI login), Repository `colloq`,
   Workflow `publish.yml`, Environment `pypi`; then give the job
   `id-token: write` and drop `password:`.
3. **GitHub environment `pypi`** (Settings → Environments). Add yourself as a
   required reviewer, so every PyPI upload waits for your approval. Under
   *Deployment branches and tags*, allow the tag pattern `v*`. Every publish
   runs on the tag.
4. **GHCR visibility.** The first image push creates the package
   `ghcr.io/<owner>/colloq-vast`. If vast.ai should pull it without credentials,
   make the package public in its package settings. Otherwise, add registry
   credentials to the vast.ai template. How operators run the image is in
   [deploy/vast/README.md](deploy/vast/README.md).

> Leave GitHub's *immutable releases* setting off. release-please publishes the
> release first, and the wheel and the k3s files are attached to it afterwards,
> which an immutable release does not allow.

## Authorship

The repository owner wants to be its only contributor, and GitHub counts
contributors by commit author. In this flow:

- **The release pull request's commit** is created by release-please through
  the GitHub API with your token, so you are its author and committer. Its
  message is the pull request title, `chore(main): release X.Y.Z`, with no
  trailer. release-please adds `Signed-off-by` only when `signoff` is
  configured, and it is not.
- **The commit on `main`** is your squash merge of that pull request. GitHub
  adds `Co-authored-by` trailers to a squash commit only when the pull request
  has commits by other people; this one has only yours.
- **The tag and the GitHub Release** are created by release-please as you.
- **Nothing pushes commits with `GITHUB_TOKEN`.** `publish.yml` uses it only to
  upload the wheel to the release, and an asset uploader does not count as a
  contributor.

## The workflows

`.github/workflows/release-please.yml` (*Release Please*), on every push to
`main` and on demand:

| Job | What it does | Permissions |
| --- | --- | --- |
| `release-please` | Fails early if `RELEASE_PLEASE_TOKEN` is missing. Runs `googleapis/release-please-action` (v4, pinned by SHA) with that token. If a release pull request was just merged, it tags `vX.Y.Z` and creates the GitHub Release. Otherwise it opens or updates the release pull request. Skipped in forks. | none for `GITHUB_TOKEN` |
| `publish` | Only when a release was created in this run: starts `publish.yml` on the new tag (`workflow_dispatch`). | `actions: write` |

The runs queue up and are never cancelled half-way (concurrency group
`release-please`).

`.github/workflows/publish.yml` (*Publish*) has no tag trigger. A tag created
with your token would start it a second time, with a second PyPI approval. So
it runs only when called from *Release Please*, or by hand for an existing tag.

| Job | What it does | Gate |
| --- | --- | --- |
| `build` | Checks that the tag, `package.json`, every copy and the changelog agree. Checks that the workflow publishing the tag is the one committed in it (the same `.github` as the tag). Runs the typecheck and tests. Runs `make wheel` with `SOURCE_DATE_EPOCH` set to the commit time, installs the wheel in a clean venv, checks `colloq --version`, and checks that the build left the tree clean. Then builds the four [platform wheels](#platform-wheels) and runs the Linux x64 one. | always |
| `smoke` | Installs each of the other three platform wheels into a clean venv on its own runner (`macos-15`, `macos-15-intel`, `ubuntu-24.04-arm`) and runs it. | always |
| `github-release` | Attaches every wheel and `python-SHA256SUMS` to the release that release-please created, once `smoke` has passed. Refuses if there is no release: it never creates one, because the notes are release-please's. Marks `-rc.N` versions as pre-releases. Keeps files that are already attached. | always |
| `pypi` | Downloads the wheels **attached to the release**, checks that each one is listed in `python-SHA256SUMS` and matches it, and uploads them with the `pypi` environment secret `PYPI_API_TOKEN`. | `vars.PUBLISH_PYPI == 'true'`, plus approval in the `pypi` environment |
| `image` | Builds `deploy/vast/Dockerfile` for linux/amd64, with provenance, an SBOM and OCI labels. Pushes `ghcr.io/<owner>/colloq-vast:X.Y.Z`, and also `:latest` for non-pre-releases. Skips the build if that version already exists. The only job with `packages: write`. | `vars.PUBLISH_IMAGES == 'true'` |

`.github/workflows/pr-title.yml` (*PR title*) fails a pull request whose title
is not a Conventional Commit with one of the types above. The release pull
request's title passes it.

### Platform wheels

A release carries five wheels. The universal one, `py3-none-any`, needs Node.js
22+ on the machine and installs the server's `node_modules` on the first run.
The four platform wheels bring both with them, so after `pip install colloq`
only Docker is needed:

| Wheel tag | Who gets it |
| --- | --- |
| `macosx_14_0_arm64`, `macosx_14_0_x86_64` | macOS 14 or newer |
| `manylinux_2_28_x86_64`, `manylinux_2_28_aarch64` | Linux with glibc 2.28 or newer (Ubuntu 20.04+, Debian 10+, RHEL 8+, WSL 2) |

pip picks the most specific tag that fits, and falls back to the universal
wheel everywhere else (macOS 13, Alpine, other architectures).

`scripts/platform-wheels.py build` (or `make wheels`) builds all four on one
machine from the universal wheel: Node.js from the archive pinned in
`scripts/node-runtime.json` (checked by sha256), and `node_modules` from
`npm ci --omit=dev -w @colloq/server --os --cpu --libc` against the root
`package-lock.json`. No install script runs; every native binary is checked
against the target's architecture before it goes into a wheel.
`scripts/platform-wheels.py smoke --wheel <file>` installs a wheel into a clean
venv, with the system Node kept off `PATH`, and runs it.

To move to a newer Node.js, change `version` and the four archives in
`scripts/node-runtime.json`, with the sums from that version's
`SHASUMS256.txt`.

Each platform wheel is about 60 MB, so a release adds about 250 MB to the
project on PyPI. PyPI limits a project to 10 GB by default; ask for more
(<https://github.com/pypi/support>) before the releases add up, or delete the
files of old versions.

### Verify a release

```sh
gh release view v0.3.0                                  # notes and assets
git log -1 --format='%an <%ae>%n%B' v0.3.0              # your name, no trailers
pip install colloq==0.3.0 && colloq --version           # if PyPI is on
docker buildx imagetools inspect ghcr.io/<owner>/colloq-vast:0.3.0   # if images are on
curl -s https://<your-host>/api/health | jq .version    # a running instance
```

The version also appears in the teaching panel, next to the Colloq wordmark in
the sidebar.

## The k3s immutable release (optional)

`.github/workflows/release.yml` ("Publish immutable release") produces what
`scripts/cluster.sh` installs on a k3s VM:

- digest-pinned app, broker and kernel images;
- `release.json`;
- `colloq-deploy.tar.gz`;
- `SHA256SUMS`.

It is a separate, manual step after the release, not part of it. Two of its
inputs cannot be derived from a tag: an exact k3s version that you have
smoke-tested, and the NVIDIA toolkit and device-plugin pins for GPU
environments.

After the release pull request is merged and the release exists, open Actions →
*Publish immutable release* → *Run workflow*, and enter these inputs:

| Input | Value |
| --- | --- |
| `version` | the tag, `vX.Y.Z` (it must equal `v` + `package.json` at that tag) |
| `k3s_version` | an exact tested release, for example `v1.36.4+k3s1` |
| `environments` | `base,cv,gpu`, or a subset |
| `gpu_toolkit_version`, `gpu_device_plugin_image` | required when a GPU environment is selected |

The workflow runs the same version check. It then builds and pushes
`ghcr.io/<owner>/colloq-{app,runtime,kernel}` and attaches its files to the
release.

The workflow never creates or replaces anything:

- If the tag has no GitHub Release, it refuses before building anything. Only
  release-please creates releases.
- If the release already has a `release.json`, it refuses.
- It never overwrites an existing asset.

Operators then follow `deploy/k3s/README.md`.

To build the same thing from a workstation, run the command below. `--version`
defaults to `v` + the `package.json` version at `--source-commit`, and the
script rejects any other value.

```sh
python3 scripts/release-build.py --registry ghcr.io/<owner>/colloq \
  --source-commit "$(git rev-parse v0.3.0^{commit})" --k3s-version <tested k3s>
```

## When something goes wrong

- **"Repository secret RELEASE_PLEASE_TOKEN is not set".** Create the token and
  the secret as described in [The token](#the-token-release_please_token), then
  re-run the workflow (Actions → *Release Please* → *Run workflow*).
- **`Bad credentials` or `Resource not accessible by personal access token`.**
  The token expired, was revoked, or lacks one of the three permissions (a
  missing *Issues* permission shows up when labelling). Fix the token and re-run.
- **No release pull request appears.** Nothing since the last release shows up
  in the changelog: only hidden types, or titles that are not Conventional
  Commits. The job log says "Considering: 0 commits" or "No user facing commits
  found". To see which commits it skipped as unparseable, re-run the job with
  *Enable debug logging*.
- **The release pull request proposes the version that was just released.**
  `release-as` is still in the config. Close the pull request and remove it
  (step 5 of [The first release](#the-first-release-020)).
- **The release pull request was merged, but no release was created.**
  release-please finds the merged pull request by its `autorelease: pending`
  label and its `chore(main): release X.Y.Z` title. If either was changed, put
  it back and re-run *Release Please*.
- **The release exists, but publishing failed or a job was skipped.** Re-run
  the failed jobs from the run page, or open Actions → *Publish* → *Run
  workflow*, pick the tag itself under *Use workflow from*, and enter the same
  tag (`gh workflow run publish.yml --ref v0.3.0 -f tag=v0.3.0`). A manual run
  from a branch is refused unless its `.github` is identical to the tag's,
  because the workflow that publishes a tag must be the one committed in it.
  The workflow publishes only the missing parts:
  - an existing wheel on the release is kept;
  - PyPI uses `skip-existing`;
  - an existing image version is not rebuilt.

  This is also how to publish an earlier tag after turning on `PUBLISH_PYPI` or
  `PUBLISH_IMAGES`.
- **Never move a tag.** A tag other people may have fetched should always mean
  the same commit. Fix the problem on `main` and release a new patch version.
- **A bad release reached users.**
  - PyPI: yank the version on pypi.org. A yanked version stays installable only
    with an exact pin, and its file can never be replaced.
  - vast.ai image: point `:latest` back to the previous version with
    `docker buildx imagetools create -t ghcr.io/<owner>/colloq-vast:latest ghcr.io/<owner>/colloq-vast:<previous>`.
  - k3s: follow `make rollback RELEASE=…`, described in `deploy/k3s/README.md`.
  - Then merge a `fix:` and release the patch version.
