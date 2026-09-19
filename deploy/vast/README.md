# Colloq on Vast.ai with one image

`colloq-vast` packages everything Colloq needs on a rented GPU machine in one image: the server, the built web client, the tunnel clients (frpc for your own relay, cloudflared), the Docker CLI, and the build context for the Python kernel images. You rent a Vast **VM**, paste one on-start script into the template, and the machine comes up with a class address and an owner sign-in link in its log. Nothing is built from your working tree and nothing is copied over SSH.

It covers the common case that `scripts/vast-legacy.sh` handles today, where the VM rsyncs the working tree, runs `npm ci`, builds the app and installs a systemd unit. The versioned k3s path in [docs/deployment-vast.md](../../docs/deployment-vast.md) is still there for installations that need its stricter isolation (restricted Pods, NetworkPolicy, digest-pinned release manifests).

## Design

### The constraint

Colloq gives every room its own kernel container. The server does this in `server/src/kernel/pool.ts` with `docker run --memory --cpus --pids-limit --gpus device=N` under a hardened profile (uid 1000, `--cap-drop=ALL`, `no-new-privileges`, no IPv6, no access to local addresses), and it mounts only that room's folder into the container. This per-room container is what closed the cross-room file leak. The repo has three kernel backends, and none of them runs rooms without nested containers:

| Backend | What it needs | Works in a Vast **Docker instance**? |
|---|---|---|
| `docker` (dev, pip `colloq`, legacy VM) | a Docker daemon socket | No: Vast disables Docker-in-Docker and offers no privileged mode |
| `broker` (production, `runtime/`) | the Kubernetes API (k3s) | No: k3s needs nested containers too |
| `test` | `NODE_ENV=test`, one shared Jupyter | Not a product mode: it has no per-room separation, and production refuses it |

On Vast, VM templates can only use `docker.io/vastai/kvm:*` images, and only in SSH launch mode. Your own image runs only as an ordinary Docker instance, which has no Docker inside. A single image therefore cannot be both "the Vast template" and "a machine that gives each room its own container".

### The decision

The image runs on a **Vast VM** as a sibling of the room kernels. The VM's Docker daemon runs `colloq-vast` with the host socket mounted, and the server inside starts one kernel container per room on that same daemon. The existing `docker` backend does this unchanged: same code, same limits, same isolation as the legacy VM service.

What the owner gets is "rent a VM, use one template, the class is running":

- **Template:** Vast's Ubuntu VM image, plus [`onstart.sh`](onstart.sh) with your settings filled in.
- **On boot:** the on-start script pulls `colloq-vast`, installs the small host manager that ships inside it (`colloq-host`), adds `nvidia-container-toolkit` if the GPU needs it, and starts the container.
- **In the container:** it opens the tunnel, starts the server, and prepares the default Python environment in the background. It either pulls the prebuilt kernel image or builds it on first boot.

Run as a plain Docker instance, the image refuses to start (exit code 78) and prints why. A process-per-room backend that would make Docker instances usable is described under [Open decision](#open-decision-a-backend-for-vast-docker-instances). It is not implemented, because it weakens isolation and needs the owner's sign-off.

### Trade-offs

| | Vast VM + this image (chosen) | Vast Docker instance (not supported yet) |
|---|---|---|
| Per-room isolation | a container per room: cgroup memory, CPU and pids limits, a GPU slice via `--gpus`, only the room's folder mounted, no capabilities, no access to local addresses | only Unix users, `prlimit` and `CUDA_VISIBLE_DEVICES` (see below) |
| Offers and price | fewer offers (`vms_enabled=true`), slower boot (minutes) | every offer, starts in seconds |
| Persistent volumes | none: VM disk only, so take backups | Vast volumes can attach |
| What runs on the VM | Docker (preinstalled), nvidia-container-toolkit | nothing |

### Other choices

- **No CUDA in the image.** Only room kernels use the GPU. The torch wheels in `kernel/environments/base-gpu.txt` bring their own CUDA runtime, and the driver comes from the host through nvidia-container-toolkit. An `nvidia/cuda` or PyTorch base under the server would add gigabytes to every rental and give the rooms nothing. So there is one image for CPU and GPU machines, and GPU-ness is a property of the **kernel** environment (`# colloq: gpu`).
- **`NODE_ENV=development`.** The server allows the Docker kernel backend only outside production, because production expects the k3s broker. `deploy/colloq-legacy.service` sets it for the same reason. It changes nothing else: the unsafe file fallback also requires `COLLOQ_UNSAFE_DEV_FILES=1`, and this image never sets that.
- **Non-root server.** The entrypoint starts as root only to prepare the state directory and to join the socket's group. The server, tunnels, builds and backups then run as `node` (uid 1000). That is the same uid as the kernel user in `kernel/Dockerfile`, so both sides can write room files without group or umask tricks. Access to the Docker socket is still root on the VM; see [Isolation](#isolation-what-users-get).
- **One Colloq per Docker daemon.** The idle sweep removes every container labelled `colloq.kind=room-kernel` on the daemon, not only its own. Do not run a second Colloq on the same VM. `make vast-image-run` tests inside `docker:dind` for exactly this reason.

## Vast template

Create the template once in the Vast console (Templates → New). These settings match what `scripts/vast-legacy.sh` rents today.

| Field | Value |
|---|---|
| Image | `docker.io/vastai/kvm:ubuntu_cli_22.04-2025-11-21` (a VM image; custom images are not allowed for VMs) |
| Launch mode | SSH (the only mode VMs support) |
| Docker options | none. Add `-p 3000:3000` only for `COLLOQ_TUNNEL=direct` |
| On-start script | the whole of [`onstart.sh`](onstart.sh), with the settings block filled in (keep the `#!/bin/bash` line) |
| Disk | 60 GB for CPU classes. With GPU environments, at least 100 GB: `base-gpu` alone is about 9 GB of torch/CUDA wheels, and each environment adds its own image |
| Visibility | **Private.** The on-start script holds your relay token and API keys in plain text, and anyone who can see a public template can read it |

When you rent, pick a VM offer (`vms_enabled=true`), on-demand rather than interruptible (an interruptible instance can be taken away mid-class), verified, with reliability of at least 0.98. For GPU classes, check that the offer's *Max CUDA* is at least 12.1, but do not put `cuda_max_good>=12.1` in the search itself: in September 2026 that server-side filter hid RTX 5070 and RTX 5090 offers whose listed value was 13.0. `scripts/vast-legacy.sh` applies the same rule after the search for this reason.

In `onstart.sh`, set at least `COLLOQ_IMAGE=ghcr.io/<owner>/colloq-vast:<version>`, and choose an address (below). Vast does not document whether template `-e` variables reach a VM, so keep settings in the script's settings block. `colloq-host` saves them to `/etc/colloq/colloq.env` (mode 0600) on the VM. If the on-start runs again, for example after a reboot, its non-empty values are written over the same keys in that file. A key the on-start leaves empty keeps the value you put in the file.

After you rent:

1. Wait for the VM to boot and the on-start to finish. It usually takes a few minutes; pulling a GPU environment takes longer.
2. SSH in (`ssh -p <port> root@<ip>`, as shown in the Vast console) and read the result: `tail -f /var/log/colloq-onstart.log`, or `colloq-host logs`.
3. Open the owner link. While nobody owns the instance, the log shows a box:

   ```
   ┌ nobody owns this Colloq yet
   │ open  https://class1.relay.example.org/admin/t/<token>
   ```

   To print it again later, run `colloq-host link`. The link is the key to the instance, so do not share it with the class. Opening it and entering a name and email makes you the owner.
4. Before class, run `colloq-host status`. It prints `/api/health`, which is 200 once the default environment image exists, along with the kernel images and room containers.

### Choosing the public address

`COLLOQ_TUNNEL=auto` (the default) picks the first one that is configured:

| Mode | Settings | Address | Notes |
|---|---|---|---|
| `relay` | `COLLOQ_HOSTNAME`, `RELAY_DOMAIN`, `RELAY_ADDR`, `RELAY_TOKEN` (`RELAY_PORT`, default 7000) | `https://<name>.<relay domain>` | Your own frps (`make relay-setup`). The only option that works from Russia, where Cloudflare's addresses do not open. A short name (`class1`) is completed with `RELAY_DOMAIN`. Static files are mirrored on the relay when it supports that. |
| `cloudflare` (named) | `CLOUDFLARE_TUNNEL_TOKEN`, `COLLOQ_HOSTNAME` | `https://<COLLOQ_HOSTNAME>` | Route the hostname to the service `http://localhost:3000` in the Cloudflare dashboard for that tunnel; cloudflared runs inside the container, next to the server. |
| `cloudflare` (quick) | nothing | a random `https://*.trycloudflare.com` | Printed in the log. It changes whenever the tunnel restarts; the server picks up the new one without a restart. |
| `direct` | `-p 3000:3000` in Docker options, plus `PUBLIC_URL=http://<ip>:<mapped port>` | plain HTTP | No TLS and no middleman. Vast maps the port to a random external one, so read it in the console. |
| `none` | `PUBLIC_URL` | whatever you say | For your own reverse proxy. |

To point a relay name at a machine, set `COLLOQ_HOSTNAME=<name>` together with the `RELAY_*` settings. The relay only serves names under its own zone, and a name that is already taken means another machine is serving that class. The tunnel keeps retrying with a growing pause, so it takes over as soon as the other machine lets the name go.

## Settings

The server reads the container's environment and `/workspace/colloq/.env`. For most settings the container environment wins, because `.env` only fills variables that are not already set. `PUBLIC_URL` and `KERNEL_ENV` work the other way: the server re-reads them from `.env` while it runs, and the file wins. That lets the tunnel and the panel's "Make default" change them without a restart. The entrypoint writes `PUBLIC_URL` into `.env` on every start.

| Variable | Default | Meaning |
|---|---|---|
| `COLLOQ_IMAGE` | — | Host only: the image the first `colloq-host up` runs. After that the image is whatever `colloq-host update` last chose (`/etc/colloq/image`), so a reboot never rolls an updated instance back to the template's version |
| `COLLOQ_TUNNEL` | `auto` | `auto`, `relay`, `cloudflare`, `direct`, `none` |
| `COLLOQ_HOSTNAME` | — | Relay subdomain or full hostname |
| `RELAY_DOMAIN`, `RELAY_ADDR`, `RELAY_PORT`, `RELAY_TOKEN` | —, —, `7000`, — | Your frps relay |
| `CLOUDFLARE_TUNNEL_TOKEN` | — | Named Cloudflare tunnel |
| `PUBLIC_URL` | computed | Overrides the computed address |
| `UI_LANGUAGE` | `ru` (server default) | `en` or `ru` |
| `ADMIN_EMAIL` | — | Prefills the owner claim form |
| `INSTITUTION` | — | Shown next to the logo |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `AI_PROVIDER`, `AI_REASONING` | off, OpenAI, `gpt-4o-mini`, `openai`, `false` | The assistant. It can also be configured later in the panel |
| `KERNEL_ENV` | `base` | Default environment for new rooms (the panel's "Make default" writes it to `.env`) |
| `KERNEL_PRELOAD` | `KERNEL_ENV` | Environments to prepare at start, comma-separated, e.g. `base,gpu` |
| `KERNEL_IMAGE_REPO` | — | Pull kernel images instead of building them: `<repo>:<tag>-<env>`, e.g. `ghcr.io/<owner>/colloq-kernel` |
| `KERNEL_IMAGE_TAG` | `v<image version>` | Tag prefix, matching the names `scripts/release-build.py` publishes |
| `KERNEL_MEM`, `KERNEL_MEM_<ENV>` | `4g`, `16g` for GPU environments | Memory per room; `<ENV>` is the environment name in capitals with `_` for `-` (`KERNEL_MEM_GPU`, `KERNEL_MEM_BASE_GPU`). The panel can override it per room |
| `KERNEL_CPUS` | `2` | CPUs per room |
| `KERNEL_OWN_MAX`, `KERNEL_OWN_PIDS` | `40`, `2048` | The second container a class gets for its students' personal notebooks, which never receives a GPU: how many kernels may live in it at once, and its process ceiling |
| `KERNEL_GPUS` | all GPUs (detected by `colloq-host`) | GPU slices handed out one per GPU room, e.g. `0,1` or MIG ids |
| `KERNEL_SHM` | `1g` | `/dev/shm` for GPU rooms |
| `KERNEL_NETWORK` | `colloq` | Docker network shared by the server and room kernels |
| `MAX_UPLOAD_MB`, `MAX_SESSION_MB`, `COUNCIL_COPY_MB`, `COUNCIL_MEMORY_GUARD`, `OPEN_SEMINAR_CREATION`, `TZ` | `50`, `1024`, `512`, `1`, `false`, — | As in `.env.example` |
| `SESSION_SECRET` | generated, kept in `data/session-secret` | Set it only to rotate the key or share it between instances |
| `COLLOQ_REGISTRY_USER`, `COLLOQ_REGISTRY_TOKEN` | — | Host only: `docker login` for a private registry. Use a read-only token. The variables are not passed to the container, but the resulting `/root/.docker/config.json` is mounted into it read-only, so the server can pull private kernel images. The server already holds the Docker socket, which is root on the VM, so this adds no access |
| `COLLOQ_HOME` | `/workspace/colloq` | State directory. Mount it from the host at the **same path** |
| `COLLOQ_HOST_STATE` | detected | The state directory's path on the host, if the automatic detection is not enough |
| `COLLOQ_BIND` | `127.0.0.1` (`0.0.0.0` in `direct` mode) | Host only: where the VM publishes port 3000 |

State lives in `/workspace/colloq` on the VM disk:

```
/workspace/colloq/
  .env                 PUBLIC_URL, KERNEL_ENV (the server and the entrypoint write these)
  data/                colloq.db, session-secret, setup-token (0700)
  workspace/<room>/    room files; each room kernel mounts only its own folder
  environments/        environments created from the panel, plus .<name>.built stamps
  backups/             colloq backup output
```

## Running it

On the VM, as root:

```sh
colloq-host status              # /api/health, kernel images, room containers
colloq-host logs                # follow the log
colloq-host link                # class address and, while unclaimed, the owner link
colloq-host update ghcr.io/<owner>/colloq-vast:<new version>
colloq-host backup              # → /workspace/colloq/backups/colloq-<stamp>.db + -files.tar.gz
colloq-host restore backups/colloq-<stamp>.db   # stops Colloq, restores, starts it again
colloq-host stop | start
```

**Update.** `update` pulls the new image and replaces the Colloq container. Data stays on disk. Room kernels keep running, and the new server reattaches to them because their Jupyter tokens derive from the persisted signing key. The chosen image is saved in `/etc/colloq/image`, and it stays in use after a reboot even though the on-start still names the old one. Running `up` again with unchanged settings (for example, when the VM reboots) leaves a running instance alone. To go back a version, `colloq-host update` to the older image works, but the newer server may already have added columns to the database, and older versions are not tested against a newer schema. The safe rollback is a backup taken before the update.

**Stop.** The container gets SIGTERM with 30 seconds of grace. The server closes sockets, flushes notebook snapshots and closes SQLite, so the WAL is checkpointed. Room kernels are left running on purpose, as they are with the legacy service, so that a restart does not wipe students' variables. Destroying the VM ends them.

**Backups.** The VM disk disappears when the instance is destroyed. Before destroying it, take a backup and copy it off the machine:

```sh
ssh -p <port> root@<ip> colloq-host backup
rsync -e 'ssh -p <port>' -av root@<ip>:/workspace/colloq/backups/ backups/<name>/
# or: vastai copy <instance>:/workspace/colloq/backups/ ./backups/<name>/
```

A backup is a pair: a consistent `VACUUM INTO` copy of the database, and an archive with `workspace/`, the signing key, the setup token and your environment lists. It is the same format `colloq backup` produces (`scripts/backup-local.sh`). To restore on a new VM, copy the pair into `/workspace/colloq/backups/` and run `colloq-host restore backups/colloq-<stamp>.db`. Restoring over an instance that already has a database needs `REPLACE=1`. Kernel images are not backed up, because they are cheaper to rebuild or pull.

## Isolation: what users get

These are the same guarantees as the legacy VM service and `make up`:

- **Each room has its own container.** It gets its own memory, CPU and pids limits (cgroups), one GPU slice (`--gpus device=N`), and `/dev/shm` only for GPU rooms. Only that room's folder is mounted. A cell cannot read another room's files and cannot take the whole machine's memory.
- **Kernels run as uid 1000 (`runner`)** from `kernel/Dockerfile`, each with a Jupyter token derived per room, with every Linux capability dropped, `no-new-privileges` and no IPv6. Kernels share the `colloq` Docker network with the server. They can reach the internet, which `pip install` in a cell needs, but not local addresses: the VM itself, its private network or the cloud metadata at 169.254.169.254. Traffic between containers on the same `colloq` network (the server and other rooms) is filtered too when the VM passes bridged traffic through iptables (`net.bridge.bridge-nf-call-iptables=1`, which Docker normally sets); without it, a room can still reach another room's Jupyter port, but only with that room's token. The server installs that block as iptables rules in its own `COLLOQ-ROOMS-*` chains (hooked from `DOCKER-USER` and `INPUT`) through a short-lived privileged helper container, and a room refuses to start when it cannot. `COLLOQ_ROOM_NETWORK=open` lifts the block for a trusted setup.
- **All rooms share the VM's Linux kernel.** Containers are not a VM boundary. Treat a VM as belonging to one organisation's classes, as the legacy path already does.
- **The server holds the Docker socket, which is root on the VM.** A compromise of the server process is a compromise of the VM, and it can reach every room's files. Only the tunnel is exposed: by default the port is published on `127.0.0.1` only.
- **Stricter isolation** (restricted Pods with a read-only root, NetworkPolicy, a separate runtime broker, digest-pinned releases) is what the k3s path in [docs/deployment-vast.md](../../docs/deployment-vast.md) is for.

## Building and publishing (maintainers)

The build context is the repository root:

```sh
make vast-image                                  # colloq-vast:dev for this machine's platform
make vast-image PLATFORM=linux/amd64 TAG=ghcr.io/<owner>/colloq-vast:0.2.0
```

The variable is `TAG`, not `VAST_IMAGE`: in `.env`, `VAST_IMAGE` already names the Vast VM image that `make vast-up` rents.

Vast machines are amd64. `PLATFORM=linux/amd64` also works from an arm64 laptop. The JavaScript build and the tunnel downloads run on the builder's own platform. Only the server's `node_modules` stage runs under emulation, because `better-sqlite3` and `@resvg/resvg-js` are native modules; running esbuild under QEMU crashes with SIGSEGV. Publishing is a separate, deliberate step, and no make target does it:

```sh
docker push ghcr.io/<owner>/colloq-vast:<version>
```

A tag release can also publish it from CI: the `image` job of `.github/workflows/publish.yml` pushes `ghcr.io/<owner>/colloq-vast:X.Y.Z` (and `:latest` for a non-pre-release) when the repository variable `PUBLISH_IMAGES` is `true`; see [RELEASING.md](../../RELEASING.md).

Before you make the package public, read [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). The image contains the web bundle and the link-preview card fonts, and both include HSE Sans, whose redistribution license is still unresolved.

The image carries OCI labels (`org.opencontainers.image.version`, `.revision`, `.source`, `.licenses`), and `colloq-vast version` prints the version and revision it was built from. The frpc 0.71.0 and cloudflared 2026.9.1 downloads are pinned by sha256 in the Dockerfile. When you bump one of them, update the version and both checksums together, and keep frpc on the relay's version.

Prebuilt kernel images make the first boot fast. Without them, the default `base` environment builds in a few minutes, and `base-gpu` downloads about 3 GB of wheels. `scripts/release-build.py --registry ghcr.io/<owner>/colloq` publishes them as `ghcr.io/<owner>/colloq-kernel:v<version>-<env>`, which is what `KERNEL_IMAGE_REPO=ghcr.io/<owner>/colloq-kernel` pulls by default. Only the manual k3s workflow (`.github/workflows/release.yml`) runs that script, and only for the environments you list there. A tag release through `publish.yml` publishes no kernel images, so for such a version the entrypoint fails to pull and builds the environment on the VM instead.

## Local smoke test

```sh
make vast-image          # build
make vast-image-run      # start it inside docker:dind as a stand-in VM, then run the end-to-end check
make vast-image-stop     # remove the stand-in and everything in it
```

`deploy/vast/smoke.sh` starts `docker:dind`, which is privileged only because it stands in for the VM. It loads the image into it and runs `colloq-host up` exactly as the on-start does. It then waits for `/api/health`, claims the throwaway instance, and runs `scripts/e2e.mts`: two clients edit one notebook, a cell runs in a real per-room kernel container, a file is written from the cell, and the room is removed. Finally it takes a backup. `SEED_KERNEL=1` copies this machine's `colloq-kernel:base` into the stand-in instead of building it. The stand-in has its own Docker daemon, so a `make dev` session on the same machine is never touched.

## Open decision: a backend for Vast Docker instances

Ordinary Docker instances are the cheap, instant, plentiful Vast product. Supporting them needs a kernel backend that gives rooms separation **without** nested containers. It would be weaker than the container per room above, so it must not ship without an explicit owner decision.

**Proposed design.** A process runtime that speaks the existing broker API, so the server needs no changes. `runtime/` already defines the seam: `RuntimeController` (`ensure` / `remove` / `list` / `health`) behind the `/v1` HTTP API in `runtime/src/http.ts`, and the server's `broker` backend talks to it over `KERNEL_RUNTIME_URL`. A `ProcessController` next to the Kubernetes one would:

- run `jupyter server` per room on `127.0.0.1:<port>`, with `root_dir` set to the room's folder, and pass the room's token through the environment (`JUPYTER_TOKEN`, never argv, which `ps` shows to every process);
- give each room its own Unix uid from a reserved range, via `setuid` (the container is root on Vast). Room folders would be `2770` with a shared group for the server and a kernel umask of `007`, so rooms cannot read each other's files and `/proc/<pid>/environ` stays private;
- apply `RLIMIT_NPROC`, `RLIMIT_NOFILE` and CPU affinity per room, and set `oom_score_adj=1000` on kernels, so that under memory pressure the kernel dies rather than the server;
- set `CUDA_VISIBLE_DEVICES` per GPU room;
- read environments from venvs baked into the image, one per `kernel/environments/*.txt`. The catalog image field would be `local/colloq-env-<name>@sha256:<hash of the frozen lock>`, which satisfies the existing digest-pinned catalog contract;
- run the server with `NODE_ENV=production KERNEL_BACKEND=broker` and the runtime on localhost, so nothing in `requireKernelIsolation` is weakened by a flag. `/api/health` and the panel should still say "process isolation" out loud.

**What it cannot give, which the owner must accept:**

- There is no cgroup memory cap per room. `RLIMIT_AS` breaks CUDA and torch, so one room can exhaust the container's RAM; the OOM priority above only chooses who dies.
- `CUDA_VISIBLE_DEVICES` is advisory. `/dev/nvidia*` is shared, so a room can unset it and use every GPU.
- All rooms share one network namespace. Kernels can reach each other's Jupyter ports, which are token-protected, and the runtime port, which is bearer-protected.
- There is no separate root filesystem. Kernels see the image's files, read-only by permission, not by mount.

**Estimate.**

- Half a day and about $1 to measure a real Vast Docker instance first: whether `setuid` and `prlimit` work, whether `/sys/fs/cgroup` is writable (if it is, per-room cgroups change the picture above), and what `/dev/nvidia*` permissions look like.
- Then 3–5 focused days for the controller, venv environments in the image and tests. That is about 600–900 lines with tests, plus a security review.

## What has been verified

These checks ran on 18 September 2026 on an arm64 laptop, using `docker:dind` as the stand-in VM (`make vast-image-run`):

- **Clean start.** On a clean daemon, the image started and built `colloq-kernel:base` in about 70 seconds, and `/api/health` turned 200.
- **Room kernel.** The end-to-end check passed: shared editing, and a cell that ran in its own `colloq-room-<id>` container and wrote a file into the room.
- **Operations.** Backup, restore with `REPLACE=1`, and a SIGTERM stop all worked. The stop exited 0 with the WAL checkpointed.
- **Relay.** The relay mode worked against a real frps 0.71.0: the proxy registered, `/api/health` answered through the relay, and a killed frpc was restarted automatically.
- **Quick tunnel.** The address extraction was checked against cloudflared 2026.9.1.
- **amd64.** The image also builds for `linux/amd64` (under emulation).
- **After the review fixes** (same day, arm64, `SEED_KERNEL=1`): the end-to-end check passed again, a repeated `colloq-host up` left the running instance alone, restore and a SIGTERM stop worked, and a non-default `COLLOQ_HOME` was wired to the server's `.env`. With a stub `docker`, repeated boots of a GPU machine no longer recreated the container, and a reboot after `colloq-host update` kept the updated image.

Not verified yet:

- a real Vast VM: whether the on-start runs, whether it runs again on every boot, and which variables reach it;
- GPU rooms with nvidia-container-toolkit on a rented card;
- pulling kernel images from a registry, since none are published yet.

Known gap: the panel's *Resources* section does not list the GPU cards. The server reads them with `nvidia-smi`, which exists on the VM but not inside the `colloq-vast` container. GPU rooms still get their slices, because those come from `KERNEL_GPUS`, which `colloq-host` fills in from the host's `nvidia-smi`.

## Relation to the other Vast paths

| Path | When |
|---|---|
| This image on a VM | The default for a class on a rented machine: prebuilt, one template, container per room |
| `make vast-up` (`scripts/vast-legacy.sh`) | Replaced by this image for the common case. It builds from your working tree on the VM, which is still useful for testing unreleased local changes on real GPUs |
| `RELEASE=… make vast-up` (`scripts/vast.sh`, k3s) | Strict isolation with digest-pinned releases; see [docs/deployment-vast.md](../../docs/deployment-vast.md) |

Sources for the Vast constraints: [launch modes](https://docs.vast.ai/instances/launch-modes), [virtual machines](https://docs.vast.ai/guides/instances/virtual-machines), [Docker environment](https://docs.vast.ai/guides/instances/docker-environment), [technical FAQ (Docker-in-Docker is disabled)](https://docs.vast.ai/guides/reference/faq/technical).
