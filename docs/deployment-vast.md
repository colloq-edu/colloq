# Versioned deployment on a Vast VM

Use a full Vast **VM**, not an ordinary Vast Docker instance. The workflow keeps VM-only, verified, on-demand offer selection, named-instance labels, price confirmation, registered SSH-key checks, direct mapped SSH, and the existing FRP relay names. A VM hosts one k3s node; application and room Pods share that VM's Linux kernel.

Vast VMs support systemd and nested containers. Only Vast's `docker.io/vastai/kvm` images work as VM templates. The default is a dated Ubuntu VM image; this is separate from the application images pinned by digest in the Colloq release. [Vast VM documentation](https://docs.vast.ai/guides/instances/virtual-machines)

## Install or update

Obtain a CI-produced release manifest and its exact source commit in a trusted checkout. The commit must include the deployment tools. A local edit or arbitrary HEAD is never substituted for that commit.

For private images, pass `VAST_REGISTRY_CONFIG=/path/pull-only.json` (or `scripts/vast.sh up --registry-config /path/pull-only.json`) and `VAST_REGISTRY_READ_ONLY=1`. Use a dedicated credential limited to pulling the required images, never a general GitHub/Vast key. The file must contain only Docker `auths`, with base64 `username:password` entries; credential helpers and unrelated Docker configuration are rejected. Credential scope cannot be verified offline, so the explicit read-only declaration is required. A private 0600 snapshot is uploaded over SSH and supplied to each cluster prepare/update.

Without credentials, explicitly set `VAST_PUBLIC_IMAGES=1` to declare that all release images are anonymously pullable. With credentials for only some registries, the same declaration covers the remaining images. These checks happen before rental; a syntactically valid credential can still be expired or lack access, and the cluster's actual image-pull preflight remains mandatory.

```sh
VAST_PUBLIC_IMAGES=1 RELEASE=/absolute/path/release.json NAME=hse HOST=hse.colloq.ru make vast-up
NAME=hse make vast-status
NAME=hse SINCE=2h make vast-logs
```

`vast-up` validates the manifest before contacting the account, packages only the deployment scripts from `release.sourceCommit`, and transfers that archive and manifest. Initial application/relay configuration is allowlisted from the local `.env`; Vast billing and Cloudflare DNS credentials are excluded. Later updates preserve the remote configuration. Edit the remote configuration deliberately rather than expecting every local `.env` change to overwrite it.

The installed application uses `127.0.0.1:30080`; FRP connects outward to the existing relay. The Kubernetes API, kubelet, and room endpoints do not need public port mappings. k3s's Flannel port must never be opened to the Internet. [K3s network requirements](https://docs.k3s.io/installation/requirements)

Updates stop active room kernels and replace the application. They are not zero-downtime updates. The installer records current/previous releases and checks data compatibility. Changing k3s itself is a separate operation with a cluster datastore/token backup. [K3s backup requirements](https://docs.k3s.io/datastore/backup-restore)

Existing service/Compose installations, unmanaged nonempty data, and old `.db`/files backup pairs are rejected by `vast-up`. Keep the old machine intact, export its data with its matching legacy tooling, and perform a reviewed migration into the new release's schema/catalog. Automatic partial migration is intentionally unsupported.

## GPU readiness

One GPU request allocates one GPU by default; simultaneous GPU rooms require enough devices or an explicit sharing policy. There is no implicit sharing or fallback to a shared Jupyter endpoint. GPU catalogs require `tooling.gpu.toolkitVersion` (an exact NVIDIA apt version) and `tooling.gpu.devicePluginImage` (a registry digest). The installer preserves the guest driver, installs the pinned toolkit/plugin, checks NVIDIA RuntimeClass and allocatable devices, and runs a disposable PyTorch CUDA tensor operation. `vast-up` also invokes `cluster.sh smoke` for independent room execution before reporting deployment success. Application HTTP health alone does not prove GPU execution works. [K3s NVIDIA support](https://docs.k3s.io/advanced#nvidia-container-runtime), [NVIDIA device plugin](https://github.com/NVIDIA/k8s-device-plugin)

Nested KVM and GPU compatibility of stronger optional sandboxes are not assumed. No paid Vast rental or live GPU test is performed by local repository tests.

## Portable backups

Application data is stored under `/var/lib/colloq/{data,workspace}` in static local PVs with Retain semantics. These survive Pod replacement, but do not survive destruction of the rental. **Vast Volumes currently cannot attach to VMs.** [Vast volume limitation](https://docs.vast.ai/guides/instances/storage/volumes)

```sh
# Keep the class running: consistent SQLite, files copied at different instants.
NAME=hse MODE=live make vast-sync

# Stop app, broker and all room Pods; kernel memory is discarded.
NAME=hse MODE=consistent make vast-sync

# Explicitly resume after the verified consistent backup.
NAME=hse MODE=consistent RESUME=1 make vast-sync
```

Each archive is named `colloq-<UTC>-<mode>.tar.gz` under `backups/<name>/`. It contains the SQLite snapshot, workspaces, application configuration, application/broker secrets, release manifest, catalog and a checksum inventory. Treat it as a secret. Checksums detect corruption; they do not authenticate an archive from an untrusted sender. Symlinks and special files are refused; regular files preserve the owner executable bit while group/world access is removed. Files changing or disappearing can make a live backup fail; retry or choose consistent mode.

The archive is validated on the VM and again after transfer. Validation checks every file, the named environment and SQLite `quick_check` results. The chosen release/catalog records immutable image identities; registry availability and retention remain necessary because image layers are not included in the application archive.

On a host directly, use `MODE=consistent NAME=hse bash scripts/backup.sh`. Consistent mode leaves writers stopped unless `RESUME=1` was explicitly requested. A failed backup leaves them stopped. Resume with `bash scripts/cluster.sh start` after investigating. `make backup-legacy` remains available for local development installations; its changing-file archive is not an atomic production snapshot.

## Restore and rollback

Restore a trusted archive using its environment name and an explicitly compatible release. Run as root on the Linux VM:

```sh
bash scripts/cluster.sh prepare --release /path/release.json
NAME=hse bash scripts/restore.sh --archive /path/colloq-...-consistent.tar.gz \
  --release /path/release.json --replace
bash scripts/cluster.sh prepare --release /path/release.json
bash scripts/cluster.sh start
```

`--replace` is explicit because preparing a fresh cluster creates initial secret/config trees. Omit it when restoring to genuinely empty targets. Recovery validates before stopping writers, stages extraction, checks data compatibility, and moves previous **whole trees** into a `replaced-<UTC>` directory before installing replacements. Old workspace files never silently remain mixed with restored ones. On failure during tree installation it moves the original trees back. Previous trees remain private for operator rollback; do not delete them until the restored deployment and backup have been checked.

The second prepare reconciles restored broker secrets and historical catalog revisions. Do not pass a new `--env-file` during this step unless replacing the recovered application configuration is intentional. Only then start the application. Verify the expected class data, old links, two independent room executions, room separation, and GPU execution where applicable.

Before destroying a rental, obtain and validate a consistent archive outside it. `NAME=hse make vast-down` retains the existing explicit destruction confirmation; `FORCE=1` remains an operator-controlled bypass. A stopped single-node cluster is not high availability, and k3s state backups do not replace application/PV backups.

## Isolation checks

Confirm separate room Pod/token/subPath storage, no Kubernetes credentials in application or room Pods, and enforced NetworkPolicy/Pod Security settings. Standard NetworkPolicy has an exception for traffic to the local node; the production deployment needs its documented host firewall rules. Container isolation does not promise protection against guest-kernel vulnerabilities.

Production file operations require Linux `/proc/self/fd` traversal. The application holds a trusted workspace-root descriptor, opens every parent with `O_DIRECTORY|O_NOFOLLOW`, and keeps a final file descriptor through asynchronous download delivery. Recursive deletion uses the same anchored traversal; symlinks are not followed. Local non-Linux development requires the explicit `COLLOQ_UNSAFE_DEV_FILES=1` opt-in (or `NODE_ENV=test` in fixtures). That development path rejects static symlinks but does not provide the Linux race protection and cannot be enabled in production.

Logs use Kubernetes durations such as `SINCE=30m` or `SINCE=2h`; freeform journalctl dates are unsupported. Deleted room Pods no longer have logs available through `kubectl logs`. Colloq scrubs common tokens while exporting logs, but notebook/application output can contain user data.
