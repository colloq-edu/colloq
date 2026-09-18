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
