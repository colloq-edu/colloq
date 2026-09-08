# Isolated execution and versioned single-node deployment

User intent: mandatory room isolation; remove unrestricted runtime control from the web application; practical deployment to a university VM and Vast.ai VM; deliberate versions and recovery.

## Chosen boundary

Production runs on one k3s node. The web app is unprivileged, has no Docker/containerd socket and no Kubernetes credentials. A small private runtime service accepts room intent over an authenticated API. It resolves an operator-controlled digest catalog and creates a fixed Pod and ClusterIP Service for each room. It does not accept Pod templates, commands, mounts, arbitrary images, namespaces or service accounts.

The app intentionally owns the room data. The runtime service is part of the trusted control plane. Student Python is untrusted. Isolation means separate Jupyter servers, tokens, filesystem views and network policy, with explicit CPU/memory/process limits. Pods still share a Linux kernel. This is not a per-room VM sandbox and does not promise immunity to kernel vulnerabilities. A single-node local volume is not HA or a filesystem-enforced per-room disk quota.

## Runtime contract

`shared/runtime.ts` is the one API/catalog contract. A catalog has schemaVersion 1, a release identifier, defaultEnvironment, and environment revisions. Images must be registry references pinned by sha256 digest. At most one current revision exists per environment name; older revisions can remain for existing rooms. The app pins a room's revision in persistent state. A missing revision fails rather than silently substituting a new image.

Private API (Bearer token, constant-time comparison, bounded JSON bodies, no generic proxy):
- GET /v1/health -> {ok, reason}
- GET /v1/catalog -> validated catalog
- GET /v1/rooms -> {rooms: [{sessionId, instanceId, phase, environment, revision, reason?}]}
- POST /v1/rooms/:sessionId -> {environment, revision?}; returns {url, token, instanceId, environment, revision}
- DELETE /v1/rooms/:sessionId -> stop, await actual deletion; room may later reopen
- DELETE /v1/rooms/:sessionId?retire=true -> persist a retirement reservation, stop the Pod; later ensure returns 410, including after broker restart. Explicit restore reconciles these reservations before allowing writers.

Lifecycle is serialized per room. Ensure requests coalesce; deletion invalidates an earlier ensure. Kubernetes 404 means absence, other errors do not. Delete uses Pod UID preconditions and waits for termination. Pod UID becomes the endpoint instance identity so a replaced Pod cannot reuse old PTY metadata behind the same Service DNS.

No normal execution path falls back to the instance-wide Jupyter endpoint. A deliberate test backend is accepted only under NODE_ENV=test. A legacy Docker backend can remain explicitly for local development, with per-room containers mandatory; production defaults to the private runtime service.

## Kubernetes workload policy

One namespace and a shared workspace PVC on a single node keep the existing filesystem API. The app mounts all workspaces; each kernel mounts only its validated session subPath at /workspace/<id>. The runtime has no storage mutation authority. App data is a separate PVC. Both use Retain semantics and UID/GID 1000 ownership.

Only the runtime receives a scoped service-account token. Neither app nor kernels mount Kubernetes tokens. Runtime RBAC allows only get/list/create/delete on Pods and Services in the designated namespace. Namespace Pod Security restricted is installed by the operator. Kernel specs fix a non-root UID, no privilege escalation, all capabilities dropped, RuntimeDefault seccomp, bounded resources, writable temporary directories, and no extra containers/host mounts/secret projections. Image and volume selection remain broker-controlled.

NetworkPolicy allows Jupyter ingress from the app and runtime readiness probe only and denies room-to-room/private service access. Public egress is a deliberate operator profile, not an unrestricted default. Standard NetworkPolicy has a local-node traffic exception; a host firewall or host-policy-capable CNI is required for node-address restrictions. Deployment documentation and checks must state this limitation rather than promise that NetworkPolicy alone blocks host access.

GPU rooms request one nvidia.com/gpu device with the NVIDIA RuntimeClass. GPU sharing is never implicit. Vast VM GPU compatibility must be verified with nvidia-smi and an actual CUDA operation; nested KVM and gVisor RTX support are not assumed.

## Environment management and releases

Production environment images are built outside the web process. The panel lists catalog revisions and can choose a default independently of build permissions. It explains the external build/import action instead of presenting an unavailable privileged Build operation.

A release manifest records exact application/runtime images, environment catalog, source commit, tested k3s/tooling versions, and data compatibility metadata. CI generates real digests; source must not contain fabricated release digests. Install/update require an explicit manifest/version. Reusing current mutable working-tree contents is not a release.

## Operations and Vast

Keep VM-only/on-demand Vast selection, named-instance state, SSH identity checks, backups per name, price/destruction confirmations and existing relay names. Vast VMs cannot attach Vast Volumes. Application data resides on the VM disk and is exported independently of k3s datastore state. Installation restores before starting the app and publishes only the application through the existing proxy/relay.

Updates are controlled single-replica replacements, not zero-downtime claims. Preserve prior release metadata and images. Image rollback is allowed only with an explicit compatible schema contract; otherwise recover the matching backup. A consistent portable backup stops all writers, including room Pods. Live SQLite backup plus changing-file archive must be labelled as such, not as an atomic snapshot.

No paid Vast resource is created as part of local development without a separate allocation instruction. Local runtime tests and a documented Vast preflight/smoke path are required.

## Acceptance

- Production cannot select shared Jupyter or fall back when runtime/network/auth/catalog is invalid.
- Web app has no Docker CLI/socket or cluster-admin credentials in the production image/manifests.
- Runtime validates the whole request; clients cannot supply images/mounts/commands/templates.
- Room Pods get distinct tokens and filesystem subPaths; no sibling ingress; no mounted SA token.
- Concurrent ensure/delete and replaced-Pod PTY identity are covered by behavioral tests.
- Existing room revision survives default/catalog update; missing image revision fails clearly.
- Versioned install/update/Vast paths and backup/restore have executable validation, with unsupported configurations rejected explicitly.
- Existing application tests/typecheck/build pass; migration changes are documented.
