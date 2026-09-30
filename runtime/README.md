# Private room runtime

The web app sends room intent to this service. Only this service receives a
namespaced Kubernetes service-account token. It creates a fixed kernel Pod and
private ClusterIP Service; it has no generic Kubernetes proxy or image-build API.

**Two Pods per class, several kernels inside each.** Every notebook of a class
gets its own Python kernel, through the Jupyter *sessions* API inside the class's
Pod — different notebook, different session path, different kernel and different
variables. Students' personal notebooks (`access: owner`) run in a *second* Pod
(since 0.10; before that they were refused on this backend), the counterpart of
the Docker backend's second container: never a GPU, the same room folder at the
same path, the personal-notebook numbers from the app's Resources tab and class
rules (capped at `RUNTIME_KERNEL_MEMORY_MAX`), its own Service, Jupyter token and
cgroup. Handing a personal notebook the class's kernel instead would give a
student the class's GPU and put its OOM killer in reach of the teacher's kernel.

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
| `RUNTIME_KERNEL_MEMORY_MAX` | node MemTotal minus 1Gi (at least the default)         |
| `RUNTIME_KERNEL_CPU`        | `2`                                                    |
| `RUNTIME_KERNEL_EPHEMERAL`  | `2Gi`                                                  |
| `RUNTIME_COLOCATE_WITH_APP` | `0`                                                    |
| `RUNTIME_IN_PLACE_RESIZE`   | `1`                                                    |
| `RUNTIME_GPU_RUNTIME_CLASS` | `nvidia` (empty: no RuntimeClass)                      |
| `RUNTIME_GPU_NODE_SELECTOR` | `{}`                                                   |
| `RUNTIME_GPU_TOLERATIONS`   | `[]`                                                   |
| `RUNTIME_ROOM_NODE_SELECTOR`| `{}`                                                   |
| `RUNTIME_ROOM_TOLERATIONS`  | `[]`                                                   |
| `RUNTIME_PRIORITY_CLASS`    | unset                                                  |
| `RUNTIME_POD_LABELS`        | `{}`                                                   |
| `RUNTIME_POD_ANNOTATIONS`   | `{}`                                                   |

Memory accepts integral Mi/Gi from 64Mi to 256Gi; ephemeral storage accepts 64Mi
to 1Ti (expressed in Gi/Mi); CPU accepts cores or millicores above zero through 64.
Requests equal limits. `RUNTIME_KERNEL_MEMORY` is the room default; a room's own
`memoryMb` replaces it up to `RUNTIME_KERNEL_MEMORY_MAX` (ensure caps above it,
a live resize refuses). The default must not exceed the ceiling. GPU environments additionally request exactly one
`nvidia.com/gpu` with RuntimeClass `RUNTIME_GPU_RUNTIME_CLASS`. GPU shared memory is 1Gi; CPU shared
memory is 64Mi; memory-backed volumes consume the Pod memory limit. The operator
sets the node PID limit and namespace quota. PVC capacity is not a per-room quota.

### The customer's cluster

The single-node k3s the installer builds needs none of the settings below; in a
multi-node corporate cluster they decide whether a room's Pod is admitted and
scheduled. All are read once at start and a wrong value stops the broker with the
variable's name in the message.

- `RUNTIME_COLOCATE_WITH_APP=1` adds a required podAffinity to Pods labelled
  `colloq.dev/role=app` on `kubernetes.io/hostname` to every broker Pod that mounts
  the data or workspace claim: room and personal-notebook Pods, competition job
  and resolver Pods (the exporter is a container of the job Pod). The package
  proxy mounts no claim and stays free. Set it when the storage is ReadWriteOnce.
- `RUNTIME_IN_PLACE_RESIZE=0` never calls `pods/resize` (the Role may then lack it):
  a PATCH that would need it answers 501, exactly as on a cluster older than 1.33,
  an ensure keeps a live Pod with its current memory and CPU, and the room's next
  Pod gets the new numbers. `0`/`1` (`true`/`false` too).
- `RUNTIME_ROOM_NODE_SELECTOR` (JSON object) and `RUNTIME_ROOM_TOLERATIONS` (JSON
  array of Kubernetes tolerations) apply to room and personal-notebook Pods;
  `RUNTIME_GPU_NODE_SELECTOR` / `RUNTIME_GPU_TOLERATIONS` are added for GPU rooms
  only (a personal notebook never has a GPU). Competition Pods take neither.
- `RUNTIME_PRIORITY_CLASS` is the priorityClassName of every broker Pod; a
  `system-*` class is refused.
- `RUNTIME_POD_LABELS` / `RUNTIME_POD_ANNOTATIONS` (JSON objects of strings) are
  added to every broker Pod, never to Services. Keys starting with `colloq.` and
  `app.kubernetes.io/managed-by` are reserved (they carry the broker's ownership
  and selectors), and annotations choosing an AppArmor or seccomp profile are
  refused. Use them for a policy engine's required labels, cost labels, or to opt
  the Pods out of sidecar injection (`sidecar.istio.io/inject: "false"`).

On k3s, set `RUNTIME_KERNEL_MEMORY` and `RUNTIME_KERNEL_MEMORY_MAX` in the
operator env file (`--env-file` of `cluster.sh install|prepare|update`, kept as
`/var/lib/colloq/config.env`). `release.py render` copies only these two runtime
keys into the broker Deployment, validates them with the same grammar and bounds
as the broker (and an explicit ceiling against the default, `2Gi` when unset),
and re-renders them on every update. An empty value means the broker default.
Other `RUNTIME_*` variables stay fixed by the installer. See
[deploy/k3s/README.md](../deploy/k3s/README.md#room-memory).

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
| GET `/v1/health`                   | —                          | `{ok, reason, defaultCpus?, defaultMemoryMb?, maxMemoryMb?, inPlaceResize?}`; 503 when unavailable |
| GET `/v1/catalog`                  | —                          | validated catalog                                                |
| GET `/v1/rooms`                    | —                          | `{rooms: RuntimeRoom[]}`, personal-notebook Pods with `role: "own"` |
| POST `/v1/rooms/:id`               | `{environment, revision?, cpus?, memoryMb?}` | `RuntimeEndpoint`                              |
| PATCH `/v1/rooms/:id`              | `{memoryMb?: number \| null, cpus?: number \| null}` (at least one) | `{outcome: applied\|pending\|absent, memoryMb?, cpus?}` |
| DELETE `/v1/rooms/:id`             | no body                    | `{ok: true}` after deletion of both Pods                         |
| DELETE `/v1/rooms/:id?retire=true` | no body                    | `{ok: true}` after durable permanent retirement and Pod deletion |
| POST, PATCH `/v1/rooms/:id/own`    | as for the room            | as for the room, for the personal-notebook Pod                   |
| DELETE `/v1/rooms/:id/own`         | no body                    | `{ok: true}` after deletion of the personal-notebook Pod only    |

The role is the path, never a body field: `/own` is the personal-notebook Pod,
`colloq-room-<hash>-own` with a Service of the same name, labelled
`colloq.dev/role=kernel` (so the room-isolation NetworkPolicy covers it),
`colloq.kind=own-kernel` and `colloq.dev/kernel=own`; the room's Service does not
select it, nor its Service the room's Pod. Its Jupyter token is derived apart from
the room's. A permanent retirement is the room's alone (`/own?retire=true` is
400) and refuses the personal Pod too (410). Personal and room Pods have separate
queues, so a personal start never holds up the class's; the room's DELETE holds
both queues, so no personal start can slip in behind it.

PATCH changes only the memory and/or whole-core CPU of a live room Pod through
the `pods/resize` subresource (Kubernetes 1.33+; the broker Role grants `patch`
on it and nothing else; `RUNTIME_IN_PLACE_RESIZE=0` makes such a PATCH a 501
without calling it): the Pod UID, container and Python state stay. An absent
field is left alone; `null` means the runtime default. No Pod answers `absent`
and creates nothing; `pending` means the API accepted the change but the node
cannot fit it yet (Deferred) — the kubelet applies it later. A node that can
never fit it returns 409 and leaves the spec unchanged. Memory and CPU are
excluded from the Pod template hash and both carry `resizePolicy: NotRequired`,
so an ensure whose Pod differs only in memory or CPU is resized the same way
instead of being replaced; any other difference still replaces the Pod. The
room census reports `memoryMb` and `cpus` from the container status, i.e. what
the kubelet actually applied. `OMP_NUM_THREADS`, `MKL_NUM_THREADS`,
`OPENBLAS_NUM_THREADS` and `NUMEXPR_NUM_THREADS` come from the Downward API
(`limits.cpu`, rounded up) and are fixed when the container starts: a live CPU
resize does not change them, and neither does a Jupyter kernel restart; the
room's next Pod gets the new value.

Permanent retirement returns HTTP 410 to later ensure requests, including delayed
POST bodies and requests after a broker restart. Other DELETE query parameters
are rejected. POST requires JSON, at most 4096 bytes, and rejects unknown keys. IDs match
`^[A-Za-z0-9_-]{1,64}$`; Kubernetes names/labels use their SHA-256 hash, while the
original ID is an annotation. Revision is `sha256:` followed by 64 lowercase hex
digits. Errors use `{error: string}` with 400/401/409/413/415/503 as appropriate.
An ensure whose Pod the scheduler cannot place adds
`unschedulable: memory|cpu|gpu|other` and the Pod's `memoryMb`/`cpus` to that
503 body, so the app can explain it; nothing else from the scheduler message
leaves the broker — only the resource name after `Insufficient`.

Catalogs require schemaVersion 1, release, defaultEnvironment and environments.
Each entry contains name, digest-pinned image, gpu, optional packages and optional
current. A sole revision defaults current to true. Multiple revisions require
exactly one explicit current:true. Duplicate name+digest pairs are rejected.
Explicit older revisions remain selectable while retained in the catalog; a
missing pinned revision fails, without substituting the current image.

`/v1/health` verifies configuration and access to the namespaced Pod/Service API.
It does **not** prove image pull, scheduling, volume mount, GPU or network success.
An actual ensure waits for Pod readiness and an authenticated Jupyter status
response from the runtime. A Pod that stays `PodScheduled=False/Unschedulable`
for 20 seconds (or until the startup timeout, if shorter) ends the ensure early
with that structured 503 instead of `Room startup timed out`; the never-scheduled
Pod is deleted, so the next ensure creates one with the room's current numbers.
The room census reports such a Pod's `reason` as `Unschedulable`. Deployment smoke tests must additionally exercise the
app-to-Jupyter path and run a cell. A TCP probe proves only process availability.

## Lifecycle and isolation

Ensure calls for the same room/revision coalesce. Conflicting concurrent revisions
return 409; a concurrent ensure that differs only in `memoryMb` or `cpus`
queues behind the running one and then resizes that Pod in place. DELETE invalidates earlier ensures and waits for serialized cleanup.

A found Pod is compared with the one the broker would create in two parts. The
workload (containers, volumes, security, service account, host namespaces, DNS)
must match exactly, or the Pod is replaced, and a freshly created one that does
not match is refused with a log line naming the differing fields (a mutating
webhook: exempt broker Pods from it). Placement (`nodeSelector`, `affinity`,
`tolerations`, `priorityClassName`, `runtimeClassName` and what admission derives
from them: `priority`, `preemptionPolicy`, `overhead`, `schedulerName`,
`topologySpreadConstraints`, `schedulingGates`, `nodeName`) is outside the template
hash and the workload comparison: it grants no execution, credentials or mounts,
cannot change on a live Pod (tolerations can only be added), and admission fills
it in. A Pod whose placement lacks what the current settings require is replaced
only while it has not started; a running one keeps its Python until the room
stops, and its next Pod follows the settings. With every setting at its default a
room Pod is the 0.9 Pod plus a liveness probe; a live room Pod created by 0.9 is
held to (and adopted by) the 0.9 template its hash names, so the upgrade replaces
no live class.

Room and personal-notebook Pods have a TCP readiness probe and a TCP liveness
probe on 8888 (every 30 s, acting after 10 failures): never an HTTP call into
Jupyter, which a busy server could delay, and a long cell cannot fail it, since the
kernel is another process and the node completes the handshake. With
`restartPolicy: Never` a failed liveness ends the Pod, hence five minutes of
refused connections before it acts. In competition Pods only the exporter and the
package proxy have liveness probes (TCP); the batch `main` container has no
endpoint to probe and a probe could only end a legitimate long run, which
`activeDeadlineSeconds` already bounds; the egress preflight is an init container.
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
