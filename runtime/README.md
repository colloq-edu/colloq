# Private room runtime

The web app sends room intent to this service. Only this service receives a
namespaced Kubernetes service-account token. It creates a fixed kernel Pod and
private ClusterIP Service; it has no generic Kubernetes proxy or image-build API.

Build with `npm run build --prefix runtime`; start with
`node runtime/dist/runtime.js`. Only Node built-ins are runtime dependencies.

## Configuration

Required files:

- `RUNTIME_TOKEN_FILE`: private app-to-runtime Bearer credential.
- `RUNTIME_ROOM_SECRET_FILE`: separate persistent key deriving per-room Jupyter tokens.
- `RUNTIME_CATALOG_FILE`: JSON catalog validated by `shared/runtime.ts`.

Generate each credential independently with `openssl rand -hex 32`. Secrets must
contain at least 32 random bytes encoded as hex or base64url. Keep the room secret
across runtime updates; changing it replaces room Pods on their next ensure.
Secret and catalog files are reread on requests, supporting atomic file updates.

| Variable                    | Default                                                |
| --------------------------- | ------------------------------------------------------ |
| `RUNTIME_PORT`              | `8787`                                                 |
| `RUNTIME_NAMESPACE`         | `colloq`                                               |
| `RUNTIME_WORKSPACE_CLAIM`   | `colloq-workspace`                                     |
| `RUNTIME_KUBE_URL`          | `https://kubernetes.default.svc`                       |
| `RUNTIME_KUBE_TOKEN_FILE`   | `/var/run/secrets/kubernetes.io/serviceaccount/token`  |
| `RUNTIME_KUBE_CA_FILE`      | `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` |
| `RUNTIME_IMAGE_PULL_SECRET` | unset                                                  |
| `RUNTIME_KERNEL_MEMORY`     | `2Gi`                                                  |
| `RUNTIME_KERNEL_CPU`        | `2`                                                    |
| `RUNTIME_KERNEL_EPHEMERAL`  | `2Gi`                                                  |

Memory accepts integral Mi/Gi from 64Mi to 256Gi; ephemeral storage accepts 64Mi
to 1Ti (expressed in Gi/Mi); CPU accepts cores or millicores above zero through 64.
Requests equal limits. GPU environments additionally request exactly one
`nvidia.com/gpu` with RuntimeClass `nvidia`. GPU shared memory is 1Gi; CPU shared
memory is 64Mi; memory-backed volumes consume the Pod memory limit. The operator
sets the node PID limit and namespace quota. PVC capacity is not a per-room quota.

Kubernetes requests verify the configured CA and reread projected credentials
on every request. Redirects are not followed. Requests have a 10-second timeout,
256KiB request bound, and 2MiB response bound. Kubernetes error messages expose
only status/reason, never arbitrary API response bodies.

## HTTP contract

Every endpoint requires `Authorization: Bearer <credential>`. Credential digests
are compared in constant time. Keep port 8787 private using NetworkPolicy and do
not publish it through the public ingress. This HTTP API is intended for the
private cluster network; use a secured transport boundary for remote access.

| Method and path                    | Request                    | Response                                                         |
| ---------------------------------- | -------------------------- | ---------------------------------------------------------------- |
| GET `/v1/health`                   | —                          | `{ok, reason}`; 503 when unavailable                             |
| GET `/v1/catalog`                  | —                          | validated catalog                                                |
| GET `/v1/rooms`                    | —                          | `{rooms: RuntimeRoom[]}`                                         |
| POST `/v1/rooms/:id`               | `{environment, revision?}` | `RuntimeEndpoint`                                                |
| DELETE `/v1/rooms/:id`             | no body                    | `{ok: true}` after deletion                                      |
| DELETE `/v1/rooms/:id?retire=true` | no body                    | `{ok: true}` after durable permanent retirement and Pod deletion |

Permanent retirement returns HTTP 410 to later ensure requests, including delayed
POST bodies and requests after a broker restart. Other DELETE query parameters
are rejected. POST requires JSON, at most 4096 bytes, and rejects unknown keys. IDs match
`^[A-Za-z0-9_-]{1,64}$`; Kubernetes names/labels use their SHA-256 hash, while the
original ID is an annotation. Revision is `sha256:` followed by 64 lowercase hex
digits. Errors use `{error: string}` with 400/401/409/413/415/503 as appropriate.

Catalogs require schemaVersion 1, release, defaultEnvironment and environments.
Each entry contains name, digest-pinned image, gpu, optional packages and optional
current. A sole revision defaults current to true. Multiple revisions require
exactly one explicit current:true. Duplicate name+digest pairs are rejected.
Explicit older revisions remain selectable while retained in the catalog; a
missing pinned revision fails, without substituting the current image.

`/v1/health` verifies configuration and access to the namespaced Pod/Service API.
It does **not** prove image pull, scheduling, volume mount, GPU or network success.
An actual ensure waits for Pod readiness and an authenticated Jupyter status
response from the runtime. Deployment smoke tests must additionally exercise the
app-to-Jupyter path and run a cell. A TCP probe proves only process availability.

## Lifecycle and isolation

Ensure calls for the same room/revision coalesce. Conflicting concurrent revisions
return 409. DELETE invalidates earlier ensures and waits for serialized cleanup.
Deletion uses UID preconditions, never force-deletes, and waits for actual resource
absence before allowing a new Pod. Persistent room files are not deleted. Runtime
shutdown leaves room Pods alive; a replacement process adopts their existing UID.
The app must use `instanceId` to invalidate terminal/kernel state after replacement.

Permanent deletion first stores a selectorless headless Service carrying both
the annotation and label `colloq.dev/retired=true`, then stops the Pod. It uses
the existing create/delete permissions, without RBAC expansion. A failed stop
leaves the reservation in place; ordinary idle DELETE preserves it. Deployment
stop/update must exclude retired Services from normal cleanup. The Service holds
no workspace mount, token or allocated ClusterIP. A successful permanent response
means future requests cannot reopen that ID while the tombstone remains.

An explicit portable restore may intentionally recover previously deleted rooms.
The restore wrapper keeps `.restore-in-progress` until the validated files are
installed, all app/runtime/kernel writers are stopped, and `cluster.sh restore-services`
removes runtime-managed Services including these reservations. Only then does
`runtime-backup.py finalize` clear the marker. An interrupted restore must be
rerun with the same validated archive using `--recover`; ordinary start/stop/update
never silently clear retirement reservations.

Kernels use the unprivileged `colloq-kernel` service account with token automount
disabled, UID/GID 1000, dropped capabilities, RuntimeDefault seccomp, a read-only
root filesystem, and no privilege escalation. Writable mounts are the single room
PVC subPath, /tmp, /home/runner and /dev/shm. The app creates the room directory
before requesting a runtime; operators provision UID/GID 1000 storage ownership.
Neither arbitrary Pod templates nor host paths can enter through the HTTP API.

Operator manifests must enforce Pod Security restricted and allow Jupyter ingress
only from app/runtime Pods. Runtime requires TCP 8888 for its authenticated probe.
Standard NetworkPolicy has a local-node traffic exception: host firewall or a CNI
with host policy is required to block room access to node/control-plane addresses.
Pods share the host kernel; this is not a VM security boundary. Use the release
installation and smoke workflow for the complete deployment policy.
