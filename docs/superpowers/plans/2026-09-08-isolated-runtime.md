# Isolated Runtime Implementation Plan

**Goal:** enforce isolated room execution and ship a reproducible single-node deployment path.
**Architecture:** private runtime broker with a Kubernetes backend; unprivileged application; operator-owned catalog, cluster policy and persistent storage. Explicit development/test backends do not become production fallback.
**Tech Stack:** TypeScript/Node, Kubernetes REST, k3s/containerd, shell/Python deployment tooling, existing SQLite/Yjs/Jupyter application.
**Spec:** docs/superpowers/specs/2026-09-08-isolated-runtime.md

## Tasks

- [x] Define and test shared runtime/catalog validation and protocol.
- [x] Implement private runtime service and fixed Kubernetes resource/lifecycle controller; test malformed/auth/concurrency/API failures.
- [x] Integrate application runtime client, strict backend selection, revision persistence, health and endpoint incarnation handling.
- [x] Replace production environment-build privileges with catalog capabilities and persistent default selection.
- [x] Add production images, Kubernetes manifests, pinned release tooling and reproducible local smoke path.
- [x] Adapt install/update/status/backup/restore and Vast workflow to explicit releases, preserving account and instance safeguards.
- [x] Verify complete tests/build, local workload isolation where executable, migration/recovery instructions and independent review.

Each implementation task begins with a failing behavioral test when logic changes. Existing test-only Jupyter fixtures remain explicitly confined to NODE_ENV=test. No paid resource or live deployment is modified during this work.

Verification evidence and remaining VM-only validation: [local deployment proof](../../deployment-proof-2026-09-09.md).
