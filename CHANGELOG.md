# Changelog

All notable changes to Colloq are documented in this file. It follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); the version lives
in the root `package.json`.

From 0.2.0 on, this file is written by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) on
`main`: each release pull request adds a section at the top, and merging it
tags the release. Do not edit it by hand in feature pull requests; see
[CONTRIBUTING.md](CONTRIBUTING.md) for commit messages and
[RELEASING.md](RELEASING.md) for the release flow. The 0.1.0 section below was
written by hand before that.

## [0.3.0](https://github.com/colloq-edu/colloq/compare/v0.2.0...v0.3.0) (2026-09-23)


### Features

* **cli:** one sign-in link with the token, like Jupyter, and the logs go to the log file ([b7155a4](https://github.com/colloq-edu/colloq/commit/b7155a4bc3b38250412e041201529be2ed3f5f84))


### Bug Fixes

* **cli:** name the port that is actually taken, and say how to start on another ([e42f2ae](https://github.com/colloq-edu/colloq/commit/e42f2ae12935e7833f85f785b8ee9b002e1029ef))

## [0.2.0](https://github.com/colloq-edu/colloq/compare/v0.1.0...v0.2.0) (2026-09-23)


### Features

* **admin:** planned course topics from the panel, and the logo leads to the class list ([7728f0b](https://github.com/colloq-edu/colloq/commit/7728f0b4d65f075c35a8008bb95a3218d981f2fd))
* **cli:** the teacher's CLI only, and one-command sharing ([a944cf6](https://github.com/colloq-edu/colloq/commit/a944cf60995405042d3fa07b66b2413975808b18))
* **competitions:** add pinned dependency sets and lightweight ML environment ([797218e](https://github.com/colloq-edu/colloq/commit/797218e5a1b3afc72fca75cd0932a5a188dea77e))
* **competitions:** notebook competitions with a public and a final leaderboard ([65a3e45](https://github.com/colloq-edu/colloq/commit/65a3e4562c120c2c285c8fb29c3d91e31ebecc47))
* council rules, live room resources and hardened room containers ([7728f0b](https://github.com/colloq-edu/colloq/commit/7728f0b4d65f075c35a8008bb95a3218d981f2fd))
* **council:** a rules sheet in the teacher's console with a time limit per run and a pause between runs ([7728f0b](https://github.com/colloq-edu/colloq/commit/7728f0b4d65f075c35a8008bb95a3218d981f2fd))
* **council:** an attempt cannot end the class — exit(), memory, process state, tensors ([261579b](https://github.com/colloq-edu/colloq/commit/261579b789e790674f2b85b0a588daf943a27bfe))
* **council:** every attempt runs on personal copies of the room's data ([c761504](https://github.com/colloq-edu/colloq/commit/c7615047d0245a3d93be60bbd9296eeeefb011d1))
* **deploy:** colloq-vast, a single image for a rented vast.ai VM ([837af10](https://github.com/colloq-edu/colloq/commit/837af10a0003271cf82e6cbf1f7d9f9bef4fa0d4))
* **deploy:** colloq.cc mirrors colloq.ru through a Cloudflare Worker ([ab6d840](https://github.com/colloq-edu/colloq/commit/ab6d840139d80ef05a60bb245fb9837d74639991))
* **editor:** hovering a module says what the package is ([758ab0d](https://github.com/colloq-edu/colloq/commit/758ab0da7b47a8a94e5fbe680ef68e238cf074de))
* **editor:** hovering a variable shows its type and shape in one line ([0b704a6](https://github.com/colloq-edu/colloq/commit/0b704a60f25ebf5e61b22cea451b56127ba462ba))
* **editor:** the signature flows by parameter instead of one per line ([87c77d3](https://github.com/colloq-edu/colloq/commit/87c77d390215fed890c300dce09fa2e8c8835b74))
* **editor:** the signature help shows the whole answer, in a window that scrolls ([4253e9a](https://github.com/colloq-edu/colloq/commit/4253e9acd6e16d18e9891567962223281fecc2ea))
* execute competitions through k3s broker ([869ec83](https://github.com/colloq-edu/colloq/commit/869ec83ada551128c6274edbb784e630fb80a963))
* **files:** a context menu for files and folders; copy the path, duplicate, rename ([986a9a8](https://github.com/colloq-edu/colloq/commit/986a9a8820524f7eba62dbef54825c739e6b4ebb))
* **kernel:** an honest word about a dead kernel, and a run limit that covers ordinary cells ([0737f1d](https://github.com/colloq-edu/colloq/commit/0737f1dc5bd40b73e6d6c975169c29de3c6b98ed))
* **kernel:** dangerous commands do not run, and the class is told why ([f1e5be9](https://github.com/colloq-edu/colloq/commit/f1e5be976cc03b70d0850e0f81bea202fc809afd))
* **kernel:** every notebook has a kernel of its own; students' notebooks run in a separate container without the GPU ([fb1d7c1](https://github.com/colloq-edu/colloq/commit/fb1d7c117427c92a5f338bc8d38eb16ac4f693c9))
* **kernel:** room containers drop every privilege, cap processes and cannot reach local networks ([7728f0b](https://github.com/colloq-edu/colloq/commit/7728f0b4d65f075c35a8008bb95a3218d981f2fd))
* **kernel:** the signature help answers before the import cell has run, and says why when it cannot ([8f66976](https://github.com/colloq-edu/colloq/commit/8f669761a546d0e5ea6302788bb248f5e619072c))
* **notebook:** interactive plotly charts, drawn in a sandboxed frame ([f3ff588](https://github.com/colloq-edu/colloq/commit/f3ff5889ad80ab25eb8ea403317669f0f97b79cf))
* **oracle:** it answers before anyone has written a line, knows the students by name, and never thinks forever ([e7f6c90](https://github.com/colloq-edu/colloq/commit/e7f6c906f065bfd156dccefdf1e673a43d6c7397))
* **oracle:** the class oracle answers questions about the whole class, drafts included ([de2fff4](https://github.com/colloq-edu/colloq/commit/de2fff4b33d888d8815643433128ae9225e594d6))
* **pult:** a council console that fits a phone and a 900×700 window, with a fixed reply dock ([0e3bd35](https://github.com/colloq-edu/colloq/commit/0e3bd35d29fe29302e6c0e51635a264ae641e738))
* **pult:** a link to the console for a phone, a real window, one console for every cell ([60abce3](https://github.com/colloq-edu/colloq/commit/60abce3761960c6fa4f612f651e1e0a506a32399))
* **room:** access is set per notebook, and students may be allowed notebooks of their own ([f21a6de](https://github.com/colloq-edu/colloq/commit/f21a6debd9c86e6794595321fbfcfa61564463bf))
* **room:** personal notebooks get resources of their own, idle kernels go away, and the rules say what they do ([5bb87dc](https://github.com/colloq-edu/colloq/commit/5bb87dc87524ef52dbe20ea619b9638191e65051))
* **runtime:** room memory and CPU change live on k3s without restarting the kernel ([7728f0b](https://github.com/colloq-edu/colloq/commit/7728f0b4d65f075c35a8008bb95a3218d981f2fd))
* **site:** a bilingual landing with animated scenes and an install block ([ba069cc](https://github.com/colloq-edu/colloq/commit/ba069cc34dff06db71390fb947edde83ff8b7e9b))
* **site:** link previews in English on colloq.cc and /en/, drawn by a generator ([ceabac7](https://github.com/colloq-edu/colloq/commit/ceabac748a4fd53ed6314c05e86890b118b67d12))
* **vast:** answer the rent question with an offer number, or name it with OFFER= ([938d11c](https://github.com/colloq-edu/colloq/commit/938d11c81b2c0acd209c64628059527b1b4e7a9c))
* **web:** one continuous splash instead of a notebook-shaped skeleton ([725d35e](https://github.com/colloq-edu/colloq/commit/725d35e01837e81556761a9ec41f22882c6134dd))


### Bug Fixes

* address product audit findings across state, execution and recovery ([509453d](https://github.com/colloq-edu/colloq/commit/509453de686ccf55c60e224c691a57e5a2ed4c20))
* **admin:** room limits use Docker's memory, not the host's ([7728f0b](https://github.com/colloq-edu/colloq/commit/7728f0b4d65f075c35a8008bb95a3218d981f2fd))
* **admin:** the panel fits a phone — class list, running-now plate, environments, teachers, new class ([efc19c7](https://github.com/colloq-edu/colloq/commit/efc19c724b29fcbbf7129d3af580f6b46fac4963))
* **editor:** the help opens on imports, module aliases and the name being called — nowhere else ([92508e5](https://github.com/colloq-edu/colloq/commit/92508e5174a6af0f146f96f42cc5d1ec78064930))
* **gate:** the walk budget grows with the document, so a large room reconnects ([4efe54e](https://github.com/colloq-edu/colloq/commit/4efe54ec58254739316352957e6a2497b02004fd))
* **kernel:** a test server starts no real containers unless told to ([492cc1a](https://github.com/colloq-edu/colloq/commit/492cc1aba8f2a58a78d63efc988edc84bf061f09))
* **kernel:** the kernel badge tells the truth, and the help waits by itself ([24d11a8](https://github.com/colloq-edu/colloq/commit/24d11a8aefb5906789b78f7975df7c214faeba70))
* **kernel:** the kernel indicator no longer blinks for the whole room on every typed letter ([8cbccfa](https://github.com/colloq-edu/colloq/commit/8cbccfae839fd8153ea5b00796736d973354103d))
* **make:** targets write a local .env instead of copying the production template ([7728f0b](https://github.com/colloq-edu/colloq/commit/7728f0b4d65f075c35a8008bb95a3218d981f2fd))
* **notebook:** the sheet follows a text cell the way it follows a code cell ([8be6d9c](https://github.com/colloq-edu/colloq/commit/8be6d9c6d8e016cf17cd7f0291e11028e4caa547))
* **oracle:** the oracle feed never scrolls sideways; only code blocks and tables do, inside themselves ([70fed19](https://github.com/colloq-edu/colloq/commit/70fed1905de0b06bdd8d7003e1436a5438b2ce56))
* **pult:** the remove-from-class menu opens above the council console ([9624323](https://github.com/colloq-edu/colloq/commit/9624323b3ff6b5013a37dec8b1780cd6e6c4b4c8))
* **pult:** who, what state, where in the pile — and no flash of an empty cell ([d555ee1](https://github.com/colloq-edu/colloq/commit/d555ee1a2ee79d206368ba6f66c0e31b15cbe040))
* **room:** a solution on the class screen outlives the council being closed ([85b77fa](https://github.com/colloq-edu/colloq/commit/85b77fa35169c7a24bfe689a4662950fe24878bd))
* **room:** bringing a file into the room does not make it that student's personal notebook ([b9eebca](https://github.com/colloq-edu/colloq/commit/b9eebcad716344c8111787cd5b044b826ecb806b))
* **room:** the copy slot in the cell toolbar copies the text, it no longer duplicates the cell ([ebc9aa8](https://github.com/colloq-edu/colloq/commit/ebc9aa8c0c9bca08612dc3a9603713e07e329e26))
* **room:** the presence dots keep clear of the file menu, and the delete row drops its truncated warning ([bc31afb](https://github.com/colloq-edu/colloq/commit/bc31afb7b467a59023f4992d1b03335bd419f58b))
* **runtime:** the teacher learns why a room cannot be scheduled ([7728f0b](https://github.com/colloq-edu/colloq/commit/7728f0b4d65f075c35a8008bb95a3218d981f2fd))
* **site:** a real favicon, site name markup, robots.txt and a sitemap for search engines ([51b4019](https://github.com/colloq-edu/colloq/commit/51b4019953b5c91b19f29454cd164766219afb66))
* **site:** drop the contact block and the join-screen demo from the landing ([6551571](https://github.com/colloq-edu/colloq/commit/65515718cf09a2b9f5046784d3bf72c9fa074fb0))
* **vast:** a session receipt from the laptop no longer stops the machine from going public ([13f145d](https://github.com/colloq-edu/colloq/commit/13f145d0b2ff2457cd45f43d4fb1d36e6ff6b560))
* verify scoped k3d checksum path in CI ([91f49ca](https://github.com/colloq-edu/colloq/commit/91f49caa4edab89185d477af6a70e210b46e6cf8))


### Documentation

* English documentation with a language switch, and a README with animated scenes ([ba326ba](https://github.com/colloq-edu/colloq/commit/ba326baa09d4fa8dfc2580fa85954859aa6ae928))
* move the repository to colloq-edu/colloq and the English docs to colloq.cc ([d2ad173](https://github.com/colloq-edu/colloq/commit/d2ad173205ad85a77b8398ea1e3eddc595e64a15))
* README in English and Russian with a language switch, pip install first ([4ead8f5](https://github.com/colloq-edu/colloq/commit/4ead8f531a85715ac8c75b0c4e34d63a029c5c5f))
* **readme:** the animated scenes in Russian, and copies for the landing ([57a3e38](https://github.com/colloq-edu/colloq/commit/57a3e38753135114cad35f8a2cd0ab547bd7c329))
* record Linux k3s competition smoke proof ([deacbd1](https://github.com/colloq-edu/colloq/commit/deacbd177170382cb19faeab5c13dca8bcac6bef))

## [0.1.0](https://github.com/sleep3r/colloq/releases/tag/v0.1.0) (2026-09-13)

First tagged version.

### Added

- Classes shared by link: students join by name, without accounts, and edit the
  same notebooks live (Yjs) with presence, cursors and multiple notebooks per
  class. `.ipynb` import and export.
- One Jupyter kernel per class with a visible run queue; outputs reach everyone,
  and late arrivals see the notebook as it stands. Code completion and signature
  hints from the class's kernel.
- Class files: a folder tree with drag and drop, uploads, a collaborative text
  and code editor with tabs, running scripts, image and PDF preview, and a shared
  terminal that records who ran each command.
- The Oracle, an AI assistant on any OpenAI-compatible endpoint that reads the
  notebook context. **Ask** answers and proposes edits; **Do** reads and edits
  files and runs code with a visible record of its steps, within action, time
  and rate limits.
- Teaching presets: **Lab**; **Lecture**, with projection, a tablet remote with
  pen annotations and a laser pointer, and synchronized PDF presentation; and
  **Council**, an individual sheet per student that the teacher reviews and can
  show to the class, with teacher-approved execution requests.
- Room rules enforced by the server: who edits, runs, restructures, uploads,
  reads history and restarts the kernel; per-cell locks; ending a class
  (read-only for students) and resuming it with its rules intact.
- Notebook history with authorship and restore, and an activity journal with
  attendance, runs, Oracle requests and submissions.
- The teaching panel at `/admin`: classes, courses, teachers with personal
  sign-in links, Python environments, Oracle settings and a setup-token claim
  for the first owner.
- Python environments as package lists with inheritance and a per-environment
  Python version; per-class memory and GPU limits.
- Publication of class material as static pages, and link preview cards drawn
  per room.
- A Russian and an English interface for the whole instance.
- Deployment paths: local development with Docker, a systemd host service, a
  single-node k3s installation from digest-pinned immutable releases
  (`release.json`) with GPU support, vast.ai rental scripts, a relay for
  exposing a class from behind NAT, and backup and restore.

### Security

- Every class runs in its own kernel container with only its own folder
  mounted; the server refuses to execute code when isolation is unavailable.
- Fixes from internal security reviews, including workspace path and symlink
  escapes, role spoofing in rooms, per-download tokens and bans for abusive
  participants.
