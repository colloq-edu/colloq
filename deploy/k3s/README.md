# Single-node deployment

Production uses one Linux amd64 VM, k3s/containerd, one non-root app Pod, and one
private runtime broker. Docker Compose is an explicit workstation development
path. `deploy/colloq.service` no longer installs a root web process.

## Publish and select a release

Cut a release by merging the release-please pull request (it bumps the version,
tags `v<version>` and creates the GitHub Release; see
[RELEASING.md](../../RELEASING.md)), then run the
**Publish immutable release**
workflow for that tag and an exact k3s patch release that has passed your
deployment smoke test. The tag must equal `v` + the root `package.json` version at
that commit; the workflow and `release-build.py` refuse anything else. The
workflow builds app, broker and selected kernel environments, captures actual OCI
digests, and attaches `release.json`, `colloq-deploy.tar.gz` and `SHA256SUMS` to
the tag's GitHub Release (the one release-please created; without it the workflow
refuses).
It does not guess a k3s version or fabricate image digests. Publication does not
itself prove that a release was exercised on your university/Vast GPU VM.

An operator can run the same build outside the app. `--version` may be omitted:
it defaults to `v` + the `package.json` version at `--source-commit`.

```sh
python3 scripts/release-build.py --version v0.2.0 \
  --registry ghcr.io/your-org/colloq --source-commit FULL_COMMIT_SHA \
  --k3s-version EXACT_TESTED_K3S_VERSION --environments base,cv,gpu \
  --gpu-toolkit-version EXACT_NVIDIA_APT_VERSION \
  --gpu-device-plugin-image NVIDIA_PLUGIN_IMAGE_AT_SHA256
```

Replace the uppercase placeholders deliberately. Login to the image registry on
the build machine first. Environment requirements and `# colloq: from NAME`
inheritance remain in `kernel/environments/`. The builder resolves parent/base
digests and emits a catalog after all pushes succeed. A custom environment is
published in a new release/catalog; it is never built by a web request. Package
metadata describes requested packages, not a complete pip lock. Deployed images
are immutable; rebuilding pip ranges later can produce different images.

## Install

Download the release bundle on an authorized workstation, verify `SHA256SUMS`,
and transfer it over SSH. Private source code need not exist on the VM. Private
images use a registry credential scoped to image pulls, supplied as Docker config
JSON; never send the workstation's general GitHub or Vast credential.

```sh
sudo scripts/cluster.sh validate --release release.json
scripts/cluster.sh render --release release.json > resources.json
sudo scripts/cluster.sh install --release release.json \
  --env-file /path/to/instance.env --registry-config /path/to/pull-only-config.json
```

Install requires systemd, curl, Python 3, iptables, and standard Linux tools. It
downloads the exact k3s binary and verifies its upstream checksum. No Node or
Docker daemon is installed on the VM. The installer refuses an unmanaged
pre-existing k3s installation or a different k3s version. It currently supports
one node and IPv4. Reserve capacity for k3s/app before admitting room workloads.

The app listens through a NodePort restricted by kube-proxy to
`127.0.0.1:30080`, for the existing host Caddy/FRP proxy. App and room Services
otherwise remain cluster-private. A persisted host firewall chain blocks public
6443, 10250, 30080 and Flannel 8472. SSH/firewall rules owned by the operator are
preserved. Kubernetes API access is required from the broker through the cluster
network; the app and room Pods do not receive service-account tokens.

Environment settings are read as data, never sourced as shell commands. Only the
app variable allowlist becomes a Kubernetes Secret; the two broker memory keys
below go into the broker Deployment. The original configuration
is retained at `/var/lib/colloq/config.env` with mode 0600 for recovery. Runtime
auth and room-token derivation secrets are distinct and persistent under
`/var/lib/colloq/secrets/`; only the broker receives the latter.

## Room memory

Each room Pod reserves its memory in full (requests equal limits). The broker
gives a room `RUNTIME_KERNEL_MEMORY` (default `2Gi`) unless the class sets its
own value, and never more than `RUNTIME_KERNEL_MEMORY_MAX` (default: node memory
minus 1Gi). Set them in the same env file as the app settings:

```sh
RUNTIME_KERNEL_MEMORY=4Gi
RUNTIME_KERNEL_MEMORY_MAX=24Gi
```

Values are whole `Mi` or `Gi` from `64Mi` to `256Gi`; an explicit ceiling must
not be below the default (`2Gi` when unset); an empty value means the broker
default. `install`, `prepare` and `update` check them before stopping anything
and render them into the broker Deployment from `/var/lib/colloq/config.env`, so
every later update keeps them. `cluster.sh render` shows the result (it reads
`--env-file`, otherwise a readable `config.env`). To change them on an installed
server, run an update with the installed release and the edited file — the same
maintenance stop as any update:

```sh
sudo scripts/cluster.sh update --release release.json --env-file /path/to/instance.env
```

A room that the node cannot fit stays `Pending` with `Insufficient memory`
(or `cpu`, `nvidia.com/gpu`). After 20 seconds the broker gives up, deletes that
never-scheduled Pod and reports the resource; the teacher sees how much the room
asked for and what to lower, students see a short note that the teacher can fix it.

## Storage and recovery

Static local PVs use `Retain` and these host paths:

| Resource | Host path | Mounted by |
|---|---|---|
| `colloq-data` PVC | `/var/lib/colloq/data` | App |
| `colloq-workspace` PVC | `/var/lib/colloq/workspace` | App and room-specific subPaths |

The root provisioner creates directories owned by UID/GID 1000. Restricted Pods
do not need a root init container. The broker mounts neither PVC. These PV size
fields are scheduling metadata, **not enforced filesystem disk quotas**. Use a
dedicated filesystem and monitor free disk. Node/disk loss requires an off-node
backup; there is no HA promise.

`prepare --release FILE` installs resources with all writers stopped. Restore
the portable backup before `start`; run `prepare` again after restoring to
reconcile restored runtime secrets and retained catalog revisions. Recovery
tools write the backup release into `recovery/release.json`; prepare merges its
historical environment revisions without changing the chosen current release.

`stop` scales down both controllers, waits for termination, then deletes/waits
for all room Pods. In-memory Python variables are lost. Notebook and workspace
files persist. A consistent backup must stop **all** these writers. A live
SQLite snapshot plus a changing workspace archive is not an atomic snapshot.

## Update and rollback

```sh
sudo scripts/cluster.sh update --release next-release.json
sudo scripts/cluster.sh rollback --release previous-release.json
sudo scripts/cluster.sh status
sudo scripts/cluster.sh logs
```

Update/rollback validate the data schema compatibility declaration and run a
consistent portable backup first. Both use a controlled stop/replacement of the
single app/broker and room workloads. There is a maintenance interruption;
these commands do not promise preservation of Python memory or zero downtime.
The preflight Pod checks actual image pulls with the same registry secret and
non-root execution before `prepare` stops writers. Failed readiness leaves the
desired release recorded and the previous release in `releases/previous.json`;
an operator chooses rollback explicitly, never an unreviewed database downgrade.

Release metadata declares data compatibility; maintainers must test and update
that declaration when migrations change. Incompatible rollback requires the
matching backup. Existing room image revisions are retained during catalog
updates. If a release omits an entire environment name, its previous current
revision remains available while historical room references are retained. Do not garbage-collect those images while seminars reference them.

k3s upgrades are deliberately separate: back up its datastore **and server token**,
follow its upgrade documentation, then deploy a release requiring that exact
version. This cluster backup is separate from Colloq application/PVC backup.
[K3s backup and restore](https://docs.k3s.io/datastore/backup-restore)

## Isolation limits and GPU hosts

Namespace Pod Security Admission enforces restricted workloads. The broker has
only Pod/Service get/list/create/delete in the namespace, plus `patch` on the
`pods/resize` subresource to change a live room's memory. Its fixed templates
and catalog are trusted control-plane code; Kubernetes RBAC alone cannot constrain
every field of a Pod the broker may create. The app cannot access those credentials.

NetworkPolicy allows Jupyter ingress only from app/broker, and permits room
egress only to kube-system DNS Pods on UDP/TCP 53. All other egress is denied. Student downloads need an intentionally designed outbound proxy/profile.
Standard NetworkPolicy has a local-node traffic exception: it does **not** prove
that student code cannot contact services on the hosting node. The included
firewall protects public host exposure, not that exception. Sites requiring
host-service isolation must add a host-policy-capable CNI or a tested firewall
policy with a specific broker-to-API allowance before admitting untrusted users.
Verify the effective policy with a room-to-node connection test; do not treat a
manifest as proof. Containers still share the host Linux kernel.

GPU hosts must retain a working NVIDIA driver and install an explicitly pinned
NVIDIA Container Toolkit and device-plugin release, configured for k3s/containerd
and the `nvidia` RuntimeClass. Do not run the old Docker-specific runtime setup.
For GPU catalogs, release.tooling.gpu must name an exact toolkitVersion (apt
package version) and digest-pinned devicePluginImage. The installer verifies
nvidia-smi, installs all four NVIDIA toolkit packages at that exact version
from the signed official repository, and lets k3s detect the runtime. It installs
the pinned device-plugin DaemonSet in trusted kube-system, verifies allocatable
devices, and runs a disposable non-root CUDA tensor Pod on start. Drivers are
never replaced and no latest GPU operator is installed. The CUDA probe requires
one free GPU; it fails without evicting an existing room if none is available.
Use cluster.sh gpu-preflight to repeat it. One GPU room requests one `nvidia.com/gpu`; sharing is not implicit.
Before promising GPU availability, check node allocatable devices and run an
actual CUDA operation in a disposable room. [K3s NVIDIA configuration](https://docs.k3s.io/advanced#nvidia-container-runtime)

## Before teaching

On a disposable VM, execute two room kernels and verify distinct Jupyter tokens,
workspace views, separate variables, denied room-to-room ingress and intended
egress/node restrictions. Restart app and broker and verify endpoint recovery.
Run a backup/restore round trip, then update/rollback across the chosen releases.
For GPU images additionally execute a CUDA tensor operation. Local unit tests
cover release rendering and rejection paths; they do not replace this VM test.

Offline universities can mirror the same digest references in an internal
registry, or provision matching k3s air-gap artifacts and import all app/kernel
images. The online bootstrap is not an air-gap installer; supply a managed,
tested k3s host and registry configuration before attempting an offline install.
[K3s air-gap installation](https://docs.k3s.io/installation/airgap)

## Verification record

Permanent room retirement and explicit restore reconciliation are described in
[the runtime contract](../../runtime/README.md).

Existing storage must not contain cross-room hardlinks. Restricted room mounts
cannot create new sibling hardlinks, but descriptor traversal cannot turn an
already shared inode into independent data. Migrate legacy workspaces by copying
regular files into separate room directories; validate ownership and links before
starting untrusted workloads.
