# Security policy

Colloq runs untrusted Python for a room of people, so we take isolation bugs
seriously. Please report them privately.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a vulnerability.**

Report it through GitHub's private vulnerability reporting: open the
repository's **Security** tab and choose **Report a vulnerability**. You can
also go straight to <https://github.com/colloq-edu/colloq/security/advisories/new>.
Only the maintainers can see the report, and we can work on a fix together in a
private fork.

A useful report includes:

- **Version.** The output of `colloq --version`. For a k3s release, the release
  version and `sourceCommit` from `release.json`. For a container image, its tag
  or digest.
- **Install type.** pip package (`colloq start`), source checkout (`make dev`,
  `make run`, `make up`), k3s release, the vast.ai image (`deploy/vast/`), or
  `make vast-up`.
- **The boundary crossed**, from the list below, and what an attacker needs
  first: a class link, a teacher link, execution rights in a room, and so on.
- **Minimal reproduction steps** and the impact you observed.
- **Logs with secrets removed.** Redact API keys, `SESSION_SECRET`, the setup
  token, teacher sign-in links, relay and cloud tokens, and kernel or runtime
  tokens.

Test only against an instance you run yourself. Classes on `*.colloq.ru` are
real classes with real students. Do not probe them, load-test them or join them
uninvited.

## What to expect

Colloq has one maintainer, so these are targets, not guarantees:

- We acknowledge a report within **7 days**.
- We confirm whether it is a vulnerability, and how severe it is, within
  **14 days**.
- We agree a disclosure date with you. The default is **90 days** after the
  report, or earlier if a fix ships sooner.
- We credit you in the advisory and the changelog, unless you prefer not to be
  named.

## Supported versions

Colloq is pre-1.0. Security fixes land on `main` and ship in the next release.
We do not backport them.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| `main` | Yes (fixes land here first) |
| Older releases | No. Upgrade to the latest release. |

## Trust model: what is and isn't a vulnerability

Colloq isolates **classes from each other**. It does not isolate the **people
inside a class** from each other. The full boundary is described in
[runtime/README.md](runtime/README.md) and in the "Isolation and limits" guide
at <https://colloq.ru/docs/en/security.html> (Russian original:
<https://colloq.ru/docs/security.html>).

### In scope

- **Crossing between classes.** Code or a participant in one class reads or
  changes another class's files, kernel, terminal, notebook, discussion or
  database rows.
- **Escaping the class workspace through the application**, for example with
  path traversal, symlinks or hard links in file APIs, uploads, imports or
  publishing.
- **Authentication and authorization bypass.** Examples: a student acting as
  the teacher, a teacher acting as the owner, forging or replaying session
  cookies, or bypassing a room rule that the server is supposed to enforce.
- **Secrets reaching a browser or log** that should never see them: Jupyter or
  runtime tokens, AI provider keys, `SESSION_SECRET`, the setup token.
- **Script or style injection that runs in other participants' browsers**,
  through notebook cells, Markdown or HTML, outputs, file previews, published
  pages or link cards. Interactive `plotly` figures are the one piece of cell
  output a third-party library renders, and they are confined to a frame with
  an opaque origin, no cookies, no storage, no access to the page and no
  network (`server/src/plotly-frame.ts`). Anything escaping that frame — into
  the application's origin, or out to the network — is in scope.
- **Oracle tool calls that exceed the requesting participant's permissions**
  in the room.
- **A competition's hidden answers or metric code reaching an entrant.**
  `solution.csv` and the teacher's `score()` live in the competition's own
  directory under `DATA_DIR`, never under `WORKSPACE_DIR`, and they are mounted
  only into the second, metric-only container — never into the one that runs a
  submitted notebook. Any door, path or response that hands either of them to an
  entrant or to an anonymous visitor is in scope, and so is the split seed: with
  it, the private share stops being hidden.
- **Reaching another entrant's submissions**: their notebook, their traceback,
  their teacher-only error text, or choosing, cancelling or re-running a
  submission that is not yours. The private score before the final leaderboard
  opens counts as the same thing.
- **An entry key that outlives its rotation.** Issuing a new key must end the
  old key and every session signed with it, on every device.
- **The production runtime broker.** Examples: accepting pod templates, images
  or host paths outside its fixed template and trusted catalog, or leaking its
  Kubernetes credentials.
- **Release and install tooling** that accepts tampered release manifests,
  images or deployment bundles.
- **A single unauthenticated request that crashes the server** or takes it down
  for every class.

### Out of scope (by design or documented limits)

- **What participants of the same class can do to each other through code.** A
  class shares one Python kernel, one filesystem and one terminal. Anyone
  allowed to run code can reach the class's files from Python, whatever the
  Files panel allows. Individual Council sheets are a teaching tool, not
  sandboxes.
- **Getting past the "Dangerous commands" rule.** That rule refuses the lines
  that end a shared kernel or wipe its variables by accident — `exit()`,
  `os._exit()`, a fatal signal aimed at the kernel itself, `%reset`,
  `!kill -9 -1`, `shutdown`, `rm -rf` of the class folder — and it is a speed
  bump, not a sandbox. It works by replacing functions inside the kernel
  process, so `ctypes`, reloading `os` through `importlib`, a fork bomb, a
  segfault in a native library and `globals().clear()` all walk past it by
  design, and the room's terminal is not covered at all. A way around it is not
  a vulnerability; a way to make a *guarded* call go through without the
  refusal reaching the person who made it is a bug worth reporting.
- **What an owner or teacher can do on an instance they control.** This
  includes reading their own classes' data.
- **A competition is not an exam.** It scores a notebook; it does not attest to
  who wrote it. Two entrants submitting one solution under two names, one person
  holding two entry keys, or a key passed to someone else are all outside what
  the server can see, and a competition that decides a grade needs invigilation
  of its own. Fitting the public leaderboard by submitting repeatedly is a
  strategy, not an attack; the private share and the daily quota exist to make
  it expensive, not impossible.
- **A submission's container is a throwaway, not an attested sandbox.** It runs
  with no network, with data read-only, under the same hardening as a room
  container (uid 1000, no capabilities, no-new-privileges, a process ceiling,
  read-only root, memory and CPU caps) and it is destroyed after one submission.
  That is the same boundary rooms get, and it is a boundary against accidents
  and ordinary code, not against an attacker who has a Docker or kernel escape.
  Submitted code is code the teacher chose to execute.
- **Local classes are "my class, my computer."** `colloq start`, `make dev` and
  `make up` use the Docker development backend, which has access to the Docker
  socket. It is meant for a trusted workstation, not as a boundary against its
  own operator. The vast.ai image (`deploy/vast/`) and `make vast-up` without a
  k3s release run the same backend on the rented machine's Docker socket, so
  the server there controls the machine by design. A participant reaching the
  server process, or crossing between classes, is still in scope. So is a room
  container on this backend that holds Linux capabilities, can regain
  privileges, or opens a connection to a local address (RFC 1918, CGNAT,
  link-local and cloud metadata, loopback, the host itself, another room)
  while `COLLOQ_ROOM_NETWORK=open` is not set: every room gets that hardened
  profile, and rooms refuse to start when the block cannot be installed
  (see `server/src/kernel/perimeter.ts`). Out of scope here: DNS on port 53,
  which stays open to any address by design; rooms started by a version
  before the profile, until their container stops; and the writable root
  filesystem and unlimited disk of a local room.
- **Linux kernel or container runtime escapes.** Room containers and Pods share
  the host kernel, and this is not VM isolation. Report these upstream. A
  Colloq configuration that makes an escape easier (added capabilities,
  writable host mounts, a missing seccomp profile) *is* in scope.
- **Documented operator responsibilities:**
  - traffic from a room to services on its own node, which the standard
    NetworkPolicy local-node exception allows (add a host firewall or a CNI
    with host policy);
  - disk use, since PVC size is not a per-room quota;
  - capacity planning.
- **A leaked class link or teacher link.** These links grant access by design.
  Keep teacher links and the setup token private.
- **Browser bans and rate limits**, which are abuse controls, not identity
  verification.
- **Vulnerabilities in dependencies** without a demonstrated exploit path
  through Colloq. Report those upstream; dependency updates land here with a release.
- **Missing hardening headers or best practices** without a concrete attack.
- **Findings against the maintainer's own infrastructure** (the colloq.ru site,
  the relay, DNS). Report them privately as above, but do not test them
  actively.
