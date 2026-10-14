# Remote runners («исполнители»): design

**Status:** final design, to be built after the Paper pass (§7). Written 13 Oct 2026 against the repo at 0.22.0 (`653b436`).

**Lineage.** The base is the "reuse" design: the same release runs in a `runner` mode, runners run only the notebook step, and the metric runs at home through the existing rescore path. Grafted from "robust": an importable execution core, a lease table, level-triggered reconciliation, a metric lane at home, path evidence before expiry, hardened uploads and blobs, and an events table. Grafted from "efficiency": prefetch with leasing gated on readiness, wheels from the index CDN, `--pull=never`, back-pressure with a blob rate limit, measuring first, and the next lease in the completion reply.

**Words.**
- *Home* is the instance that owns the database, the materials and the answers (vsos).
- A *runner* («исполнитель») is a Docker machine that runs notebook steps for home.
- A *lease* is one attempt of one submission, held by one runner and keyed by the existing `attempt_id`.

New code is prefixed `remote`, because `runner` already names the in-process executor (`CompetitionRunner`, "runner cards").

## 0. The design in one screen

| Decision | Why it is the efficient choice |
|---|---|
| A runner is `ghcr.io/colloq-edu/colloq-server:<ver> runner`: the published image, plus a second esbuild entry `dist/runner.js`, calling the unchanged `DockerCompetitionRunner.run()` | No new image, publish job or CVE surface. The argv, harness, export, GPU slices and verdicts are byte-identical by construction |
| Runners only dial out. Each machine keeps one long-poll `sync` and fetches `GET blobs/<sha256>`; each submission costs 2 `PUT`s and 1 `POST outcome` | Works behind NAT, university proxies and the relay. Three requests per submission |
| Images come from GHCR by digest, wheels from PyPI by URL and sha256. Data goes by sha256, once per runner, prefetched before the bell | No image or wheel bytes and about 6 KB per submission cross vsos and its tunnel |
| Home keeps the queue, fairness, texts, answer key and metric. A remote result becomes a home metric row, scored by the existing `scoreOnly` | Answers never leave home. A home restart re-runs a metric of at most 120 s, never a GPU notebook |
| `attempt_id` fences every write. Each heartbeat lists everything the runner holds. Lease state lives in `remote_leases` | Lost replies, relay restarts, home restarts and dead VMs become delays, not reruns or stuck rows |
| vsos can stop running notebooks («Тетради на этом сервере» off) and only score | vsos (8 vCPU, 16 GB) stays free for the class |

**Cost.** About 5.6k LOC plus about 2.5k LOC of tests, in 11 phases (§9). Phase 1 (content hashes, a hard-linked answer key, portable image pins) already speeds up today's single-VM path.

## 1. Goal and non-goals

**Goal.** Run the notebook step of competition submissions on any number of Docker machines linked to one home: rented Vast VMs (with or without GPUs) and university servers. A competition can then use more CPU and GPU than home has, while home keeps the materials, queue, results, hidden answers and metric.

**Acceptance targets**
- A runner joins with one command. It pulls images and prefetches data itself, and nobody has to log in to vsos.
- The sandbox is identical: for the same request, the runner's `docker run` argv equals home's (snapshot test).
- At warm cache, remote execution adds at most 3 s per submission. A local run already spends about 10 s on containers and the metric.
- Per remote submission, vsos handles 3 requests, gunzips and hashes a few MB, and runs one metric container. It reserves no memory for the notebook.
- A burst of 100 simultaneous submissions settles every submission exactly once, in fair order. Infrastructure losses never spend quota or count as failed attempts.

**Non-goals for v1**
- the metric or the answers on runners (never)
- package preparation on runners
- room kernels on runners
- a k8s or broker home (the broker path stays as it is)
- renting or autoscaling machines from the panel
- agent self-update
- re-attaching to a running container after an agent restart (the lease is requeued instead)
- request signing (v2, see Q4)
- redundant execution
- data mirrors on the relay, or P2P
- rebuilding images on runners
- one runner serving two homes

**Rejected outright**
- a broker or k3s per runner
- push RPC into runners
- a shared filesystem
- a WebSocket control channel
- a separate runner image
- chunked Content-Range uploads
- parsing two protocol versions
- comparing bare image `.Id`s

## 2. Architecture

```
   ghcr.io: kernel images by digest           PyPI CDN: wheels by url + sha256
            | once per revision                         | once per wheel
            v                                           v
 +-- runner («исполнитель»): Vast VM or university server, any number ---------+
 |  colloq-runner = colloq-server image in `runner` mode (dist/runner.js)      |
 |    sync loop | CAS cache (data, wheels) | image prep | uploads             |
 |    DockerCompetitionRunner.run() --docker.sock--> sandbox per submission    |
 |    (same runArgs, harness, hold_export, VramWatch, verdictOfRun)            |
 +----------------------------+-------------------------------------------------+
                              | HTTPS, outbound only: /api/runners/v1
                              | sync (long-poll <=25 s), GET blobs/<sha256>,
                              | PUT results, POST outcome
                              v
          relay2: Caddy :443 (TLS ends) -> frps -> frpc inside the app container
                              v
 +-- home = vsos: the only database writer -----------------------------------+
 |  SQLite: competition_queue (+holder, lost), remote_* tables                 |
 |  data, hidden-test inputs, bundles (CAS); answer key + metric never leave   |
 |  pump: metric lane (scoreSlots) + optional local notebooks                  |
 +-----------------------------------------------------------------------------+
```

**The life of one remote submission**
1. **Upload.** The upload calls `enqueue` as today. `wakeCompetitionPump` now also wakes the held `sync` calls.
2. **Take.** A held `sync`, or an outcome reply, runs `takeForRunner`: one SQLite transaction over the existing fair order that skips rows this runner cannot run. It:
   - marks the row `running` with `holder=<runner>`;
   - mints a new `attempt_id`;
   - inserts the `remote_leases` row (state `offered`) and the `submission_runs` row.

   The reply carries the lease.
3. **Delivery.** The runner's next `sync` lists the attempt, which marks it delivered (`accepted`). An offer that is not listed is repeated in every reply, and is withdrawn after 60 s.
4. **Prepare.** The runner prepares from its cache:
   - `/data` as hard links for the lease's data manifest;
   - the notebook, sent inline;
   - wheels from the cache, with misses fetched from PyPI;
   - the harness from its own build;
   - a card share, chosen with `pickRunnerGpu`.
5. **Run.** `docker run` uses the unchanged argv plus `--pull=never`.
   - `sync` reports `running` and `runningMs`, and home sets `started_at = now − runningMs`. Pulls and downloads therefore never eat the participant's timer.
   - Progress arrives at least every 10 s. On hidden-test runs home clamps it.
6. **Upload results.** When the container ends, the unchanged export fills `attempts/<a>/result`. The runner persists `outcome.json`, `PUT`s `submission.csv` and `executed.ipynb` gzipped and in parallel, then `POST`s the outcome.
7. **Apply.** Home applies the result once:
   - it moves the staged files into the attempt dir;
   - it runs the shared `settleNotebook` (texts, clamps, `finishRun`, publish, promote);
   - the queue row flips to `kind='metric'`, `holder NULL`, `waiting`, keeping `turn`, `enqueued_at` and `late`.

   The reply says `applied` and may carry the next lease.
8. **Score.** The home metric lane takes the row and runs `scoreOnly` → `scoreStep` in the pinned image with the hard-linked answer key. The submission becomes `scored`, and the row leaves the queue.
9. **Clean up.** The runner deletes the attempt tree. Its caches stay.

## 3. Protocol

### 3.1 Transport and auth

**Router**
- The router is `/api/runners/v1`. It is mounted in `server/src/app.ts` right after the security headers: before `compression` (Range downloads must not be re-encoded), `attachSsoIdentity`, `express.json` and the `sameOrigin` gate. It has its own body parsers and caps.
- Rate limits are per runner id (`net/too-often.ts`). The only per-address limit is on `join`: 10 per 10 min.
- No participant door is on this path, so runners behind one NAT never throttle each other.

**Credential**
- Runners send `Authorization: Bearer cr1.<runnerId>.<secret>`. The secret is 256 random bits. Home stores its sha256 and compares digests in constant time.
- `cr1` names the scheme, so v2 can add signing.
- Only this router accepts the credential, and it refuses every other kind. `currentStaff`, `currentEntrant`, `verifyToken` and the WebSocket upgrades all refuse it.
- The secret never goes in a URL.

**Replies**
- Every reply is JSON and carries `X-Colloq-Runner-Api: 1`.
- A reply without that header is transient. That covers the relay's HTML page served as 404 or 502, frps's 504, and frps's EOF→404 on a reused POST connection.
- On a transient reply the runner backs off with jitter from 1 s to 30 s and checks `GET /.relay/state` to tell "home offline" from "refused". It never drops a lease over one.

**Versioning and proxies**
- Every request carries `protocol: 1` and `build`, the sha256 of the runner bundle (§8.4).
- Strict parsers in `shared/remote-runner.ts` refuse unknown keys. IDs reuse `COMPETITION_ATTEMPT_ID` and `COMPETITION_ROW_ID`.
- The agent honours `HTTPS_PROXY`, `NO_PROXY` and `NODE_EXTRA_CA_CERTS` (through `installOutboundProxy`).

### 3.2 Endpoints

| Call | Cap | What it does | Why repeats are safe |
|---|---|---|---|
| `POST join` | 8 KiB | Code + `joinId` + facts → `{runnerId, secret, trusted, approvedSlots}` | The same `joinId` within 10 min returns the same runner with a new secret, without spending another code use |
| `POST sync` | 256 KiB | Heartbeat, lease long-poll and reconciliation; held for at most 25 s | Level-triggered: the whole state goes in, the whole answer comes out |
| `GET blobs/:sha256` | — | Inputs by content hash, with Range; the ETag is the hash | It is a GET |
| `PUT attempts/:a/files/:name` | 64 MiB uncompressed | `submission.csv` or `executed.ipynb`, gzipped | The same sha256 again is a no-op |
| `POST attempts/:a/outcome` | 192 KiB | Finished or declined | The same digest gets the cached reply |

### 3.3 Messages

```ts
// sync request
{ protocol: 1, build, seq,                 // highest offer seq seen
  holdMs,                                  // ≤25000 when idle, ≤10000 while anything runs
  state: 'active' | 'draining' | 'leaving',
  free: { slots, memoryMb, cpus, gpuShares, diskMb },
  cards: [{ device, name, memoryMb, perDevice, busyShares }],
  ready: { revisions: [revisionId], data: [manifest], sealed: [manifest], bundles: [bundleId] },
  attempts: [{ id, phase: 'accepted'|'preparing'|'running'|'exporting'|'uploading', runningMs?,
               progress?: { phase, cell, cells }, card?: { device, sliceMb } }],
  problems: [{ code, revisionId?, detail }] }          // detail ≤300 chars

// sync reply
{ seq, leases: Lease[],                    // new offers + offers not yet acked
  revoke: [{ id, reason }],                // cancelled, lost, or unknown to home
  applied: [id],                           // outcome applied: delete the attempt tree
  want: { revisions: [{ id, ref, layers, gpu }],
          data: [{ competitionId, manifest, sealed, files: [{ name, sha256, bytes }] }],
          bundles: [{ id, lock, packagesMb, wheels: [{ fileName, sha256, bytes, url? }] }] },
  forget: [competitionId],                 // closed or deleted: drop its data, purge sealed
  drain, approvedSlots, perDevice, compatible, homeVersion }

// Lease: carries no entrant name, email or score
{ attemptId, seq, competitionId, submissionId, container,
  deadlineMs,                              // relative, so home's clock is the one that counts
  revision: { id, ref, layers }, harness: HARNESS_REVISION,
  limits: StepLimits,                      // full: memory, cpus, pids, tmpfs, fsize, target and output caps
  sealed, gpu, perDevice?, data: manifest, sealedData?: manifest,
  notebook: { sha256, bytes, inline?: base64 },   // inline up to 64 KiB, otherwise a blob
  bundle?: { id, packagesMb } }

// outcome request, either:
{ protocol: 1, build, free, kind: 'finished',
  outcome,                                 // RunOutcome without paths, plus produced, crowded, card {device, perDevice, sliceMb}
  runJson,                                 // raw harness report, ≤64 KiB
  files: [{ name, bytes, sha256 }] }
// or:
{ protocol: 1, build, free, kind: 'declined',
  reason: 'image'|'data'|'wheels'|'disk'|'memory'|'card'|'draining'|'version', detail }

// outcome reply
{ result: 'applied' | 'refused' | 'revoked', seq, leases: Lease[] }
```

A data `manifest` is the sha256 of the sorted list of `(name, sha256)` pairs. Home computes it from `competition_files`.

### 3.4 Leases, heartbeats and fencing

**States.** A lease moves `offered → accepted → running → applying → applied`. It can leave that path as:
- `withdrawn`: never acked;
- `declined`: the runner refused it before any container started;
- `lost`: the runner went silent, dropped it from a report, or passed the ceiling;
- `revoked`: a cancel, an erase, or the runner was revoked.

| Rule | Behaviour |
|---|---|
| `sync` hold | At most 25 s idle, or 10 s while the runner has attempts (frps answers 504 at 60 s; proxies cut at 30 s). Home answers early on news: a lease, a revoke, a `want` change or an offer not yet acked |
| Delivery | An offer is delivered when a `sync` lists its attempt; the agent persists a reply's leases before it sends the next `sync`. If a `sync` with `seq` at or above the offer's leaves it out, the offer is withdrawn at once. An offer not acked within 60 s is withdrawn |
| Stale capacity | Home recomputes the runner's room as (the free capacity it offers + what its `sync` lists) − what home has leased to it, so a stale held `sync` cannot over-commit the runner |
| Runner silence | 180 s without any call, measured on home's clock, makes the runner's leases lost. This applies only when home has path evidence |
| Path evidence | Either another runner was heard within the last 60 s, or home's own probe of `PUBLIC_URL/api/readyz` through the relay passed within the last 60 s (the probe runs every 30 s). Without either, nothing expires for up to 15 min |
| Boot grace | Nothing expires during the first 180 s after home starts |
| Missing after delivery | Lost at once: the runner says it no longer holds the attempt |
| Ceiling | offered_at + 10 min to prepare + wall + 120 s + 10 min to upload. Past it, the lease is revoked and counted lost, even while syncs keep arriving |
| Decline | Home refunds the attempt and deletes the unstarted run row. That runner skips the submission for 10 min. No row-wide `not_before` is set |
| Loss accounting | A loss before the container started is refunded. A loss after it does `lost++` and finishes the run row as `unknown`, "lost on <runner>". After 3 losses the submission is `metricFailed`, naming the runners. After 3 declines by different runners it is `metricFailed`, with their reasons |
| Quarantine | 3 losses or 5 declines on one runner within 30 min drain it automatically and put a banner in the panel |

**Requeue.** A lost or withdrawn row goes back through `markWaiting`, fenced on `attempt_id`.
- The row keeps `enqueued_at` and `turn`.
- The submission goes back to `queued/queue`, with a message written by us.
- Neither path touches the quota or the failed-attempts ceiling.

**Fencing.** Every write from a runner (progress, PUT, outcome) is checked against `holder` and `ownsQueueAttempt`. A network partition can make one attempt run twice, but only one result is ever applied.

**Home restart**
- `reclaimQueue` and `orphanedRuns` touch only rows with `holder IS NULL`.
- Remote leases stay `running`. Runners keep syncing once the tunnel reconnects, and their outcomes are applied from `remote_leases`, with nothing held in memory.
- At boot, `offered` leases are withdrawn and `applying` ones are re-driven.

**Agent restart**
- The agent removes its own containers, found by `INSTANCE_LABEL` (a hash of its data root).
- It uploads results whose `outcome.json` was persisted, and reports nothing else.
- Home marks the unreported leases lost at once instead of waiting out the TTL.

### 3.5 Cancellation

`cancelRemote(row, by)` does all of this in one transaction:
- fences on `attempt_id`;
- deletes the queue row;
- sets the lease to `revoked`;
- finishes the run row;
- sets the submission to `cancelled`, with today's words.

Home then wakes the runner's held `sync`, and the reply carries `revoke`. The agent aborts `run()`, and the container dies within about one round trip. A late `PUT` or outcome gets 409 `revoked`, and the agent discards the attempt.

**What changes**
- Cancels become durable. Today a restart re-runs a cancelled run.
- `stopCompetitionRuns`, participant erase and competition delete take the same path, and no longer wait on `runningHere`.
- A rerun or rescore requested during a remote run sets `pending_kind` as today. At apply it replaces the flip to a metric row.

### 3.6 Results and apply

**PUT**
- Only `submission.csv` and `executed.ipynb` are accepted. The body is `Content-Encoding: gzip`, and `X-Colloq-Sha256` and `X-Colloq-Bytes` describe the uncompressed file.
- Caps apply after decompression: the CSV at most `limits.targetBytes` (≤64 MiB), the notebook at most 64 MiB. Decompression stops at the declared length plus one byte.
- The body streams to `competitions/.remote/<attempt>/<name>.part`, is fsynced, and is renamed once the hash matches.
- At most 4 uploads run at once across the instance, each needing 128 MiB of free disk by statfs; past that home answers 503 with Retry-After. Below the disk floor it answers 507.
- A revoked or erased attempt gets 409, and nothing is created. Staging sits outside the attempt tree, so a late upload cannot recreate an erased submission's directories.
- If P0 shows runners upload at under 1 MB/s, resumable uploads come in v1.1. Node gives a request 300 s.

**Outcome.** Home applies it in this order:
1. It checks the fence: the lease is `accepted` or `running`, and the holder and attempt match.
2. The lease becomes `applying`.
3. The staged files must match the manifest. They move into `attemptDir(...)`.
4. `settleNotebook(preparedFromLease, outcome)` runs, the same code local runs use.
5. The row flips to a metric row, or to its `pending_kind`.
6. The lease becomes `applied`, and the reply is cached.

The same digest again gets the same reply. A different digest gets 409.

**Re-drive after a crash.** A crash between the moves and the commit leaves the lease in `applying`, and boot re-drives it. A move is skipped where `out/` already holds the file with the manifest's sha256. `publishAttemptArtifacts` and `promoteAttempt` need that guard: today a second call deletes the published notebook when its source is gone.

**Results are participant data.** Home applies the caps, checks the `attemptId` inside run.json, and applies clamps and blind texts from the raw harness report. `executed.ipynb` comes back for blind runs too, because the teacher downloads it.

## 4. Data plane

### 4.1 What travels

| Flow | Size | From → to | How often | Crosses vsos and the relay |
|---|---|---|---|---|
| CPU kernel image | gzipped: base 237 MB; kaggle-base 1,033 MB, which includes base | GHCR → runner | once per revision per runner, at join | no |
| GPU kernel image | ~4 GB gzipped (estimate; base-gpu is 9.9 GB and kaggle-gpu 12.7 GB unpacked) | GHCR → GPU runners only | once per revision per runner, at join | no |
| Open data | ≤200 MiB, typically 10–100 MB | home blobs → runner | once per changed file per runner, prefetched | yes, rate-limited |
| Hidden-test inputs | ≤200 MiB | home blobs → trusted runners | once per changed file per runner, prefetched | yes |
| Wheels | ≤500 MiB per set; a shared wheel comes down once | PyPI CDN → runner (home CAS as fallback) | once per wheel per runner | no (the fallback does) |
| Harness | 55 KB | inside the release | — | no |
| Lease and notebook | ~2 KB + typically 4 KB (≤20 MiB) | home → runner | per submission | ~6 KB |
| Results | CSV and notebook gzipped, typically 0.05–1 MB; run.json ~0.3 KB | runner → home | per submission | typically ≤1 MB |
| Control | one held `sync`, ~1–8 KB every 10–25 s | both ways | per runner | ~0.5 KB/s |
| Answer key, metric | — | never sent | — | — |

Two examples:
- A burst of 100 submissions moves about 1 MB down and 10–100 MB up through the relay.
- Joining 5 runners to a competition with 150 MB of data moves 750 MB once, before class. That takes about 95 s at 8 MB/s.

### 4.2 Content addressing and caches

**Home side**
- `competition_files.sha256` is computed in `putOpenFile` and `putSealedFile`, from the buffer they already hold. Existing rows are backfilled lazily, with a hash cached by stat: the `wheelHash` helper in `dependencies/files.ts`, generalised and exported.
- Wheels already live in the CAS at `dependencies/artifacts/<sha256>`.
- `DependencyPackage` in the bundle manifest gains `url`. Preparation already reads `download_info.url` from `pip --report`.
- Large notebooks are served by hash from `s/<sid>/in/`.

**The blob route resolves by construction.** It uses an in-memory index built only from database rows: open data, sealed data, wheels and submitted notebooks.
- `secret/`, `score*/` and `baseline/` are never indexed.
- A runner gets a hash only if it is in the manifest of one of its active leases or in its `want`. Sealed hashes go to trusted runners only.
- A hash out of scope gets 404. A hash whose file has since been replaced gets 410.

**Runner CAS**
- It lives under the runner's data root. Each blob is checked against its sha256 on arrival.
- Downloads resume with Range. Eviction is LRU, with a floor of free disk.
- Sealed blobs sit in a separate directory. They are purged on `forget`, untrust, revoke, drain and 401.

**Runner tree.** It repeats home's layout from `storage.ts`, keyed by the leased ids, so `runArgs`, `hostPathOf` and `letContainerRead` work unchanged. The state directory has the same path inside the agent container and on the host:
```
/var/lib/colloq-runner/
  runner.json                                    runner id, home URL, secret (0600)
  leases/<attempt>.json                          lease; outcome.json beside it once finished
  data/competitions/.blobs/<sha256>              CAS: data, wheels, big notebooks
  data/competitions/<c>/inputs/<manifest12>/     open data as hard links, one dir per manifest
  data/competitions/<c>/s/<s>/in/notebook.ipynb
  data/competitions/<c>/s/<s>/attempts/<a>/{inputs,result}/   inputs: links incl. sealed
  data/dependencies/bundles/<b>/{wheels/,requirements.lock,manifest.json}
  data/competitions/.harness/<HARNESS_REVISION>/
```

### 4.3 Prefetch and readiness

**What `want` lists.** For each runner, home lists the competitions that are open, open within 24 h, or have waiting rows, and whose revision has a `registry_ref`. For each of them:
- the revision (GPU revisions go only to runners with cards);
- its data manifests (sealed manifests to trusted runners only);
- the prepared bundles of its entrants.

**Fetch order.** The agent fetches for competitions with waiting rows first, then open ones, then upcoming ones, one stream at a time.

**Leasing waits on readiness**
- The revision is pulled and verified.
- The open data manifest is complete.
- For sealed rows, the sealed manifest is complete.

Bundles do not gate leasing. A missing wheel is fetched from the index CDN during prepare, in seconds, before the participant's timer starts.

**Data changes.** Replacing a data file makes a new manifest. Runners fetch only the changed hash, and leases already out keep their own manifest directory.

### 4.4 Images

**Portable pins**
- `environment_revisions` gains `registry_ref` and `layers`.
- `registry_ref` is `repo@sha256` from `RepoDigests`, preferring the entry under `KERNEL_IMAGE_REPO`.
- `layers` is the sha256 of os/arch plus `RootFS.Layers`. `.Id` is not portable, because the classic and containerd stores disagree on it; the diff_ids do not.
- Existing revisions are backfilled at startup from the `colloq-revision:<id>` tags.

**Preparing an image on the runner**
1. `docker pull <ref>`, then inspect.
2. Check that `layers` matches.
3. For a GPU revision, run a 10-s smoke test on the card the runs would take: one with a share free at home's runs per card (`pickCard`, `--gpus device=<that card>`), whose share the test holds like a run while it runs. torch must see CUDA. This catches a driver older than 580 and a missing toolkit. No card with a share free, or CUDA out of memory on a card a run filled meanwhile, is no verdict: the revision waits `SOON_MS` (30 s) and is checked again, with no problem reported and no growing backoff.
4. Tag it `colloq-revision:<id>`.
5. Report it `ready`.

Failures are reported per runner, with the reason.

**`--pull=never`** is added to `runArgs` and `scoreArgs`. A missing image then becomes a decline, instead of a silent pull under the 120-s timeout of `docker run`.

**Revisions without a `registry_ref`** (built or edited locally, or loaded from a file) run at home only. The door and the console say so.

**GPU kernels must be published.** None are today.
- `make kernel-publish ENV=base-gpu,kaggle-gpu` from a Vast builder VM: the build takes about 9 min and the push about 4 GB. CI can take this over later.
- vsos then pulls them with `KERNEL_PRELOAD`, which gives its revisions a `registry_ref`.

**One revision per competition, for its whole life.** The v0.19 and v0.22 kernels share only 50 of 1,033 MB, so following each release means a full re-download.

**Disk.** A CPU runner needs at least 40 GB, a GPU runner at least 120 GB. When free disk falls below the floor, revisions not wanted for 24 h are evicted.

### 4.5 Bandwidth control

- **Blobs** go through one global token bucket, the owner setting «Скорость раздачи». Its default comes from P0; 8 MB/s is a placeholder. Each runner gets 1 stream and the instance at most 3; beyond that home answers 429 with Retry-After. Downloads never use `files.zip`, which shares the class archive queue of 6 slots.
- **Uploads** run at most 4 at a time and are typically KBs.
- **If P0 shows the class's rooms suffer,** pick one:
  - a second frpc name for `/api/runners`, giving it its own TCP connection (frpc logged "work connection pool is full" at 10 parallel uploads on 11 Sep);
  - a mirror of open data on the relay, following the `/.relay/assets` pattern;
  - a second relay box.

### 4.6 Load on vsos

| | Today, per local submission | Per remote submission |
|---|---|---|
| Notebook | A container (2 CPU / 4 GB by default) for the whole wall, plus `docker inspect` every second and `exec` every 3 s | none |
| Inputs | Hidden-test inputs composed; bundle re-hashed (up to 500 MB read) | none: the manifest is a snapshot |
| Answer key | A 200 MB copy per job | A hard link when the metric job starts |
| Network | — | 3 requests, at most a few MB in; gunzip and sha256 take about 10–50 ms of CPU |
| Metric | A container in the pinned image, ≤2 GB, ≤120 s, typically about 3 s | the same, in the metric lane |
| Memory reserved | 256 + max(notebook, metric) MB for the whole run | 256 + metric MB while scoring |

**Control plane.** 10 runners make about 0.5–1 request/s, each a sub-millisecond SQLite transaction. Progress is written once per `sync`, and only when it changed.

## 5. Queue and capacity

### 5.1 Schema

```sql
-- competition_queue (ensureColumn)
holder TEXT,                         -- NULL = home; otherwise remote_runners.id
lost   INTEGER NOT NULL DEFAULT 0    -- losses after the container started; reset by upsertQueue
-- competition_files
sha256 TEXT                          -- NULL until backfilled
-- environment_revisions
registry_ref TEXT, layers TEXT

CREATE TABLE remote_runners (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, secret_sha256 TEXT NOT NULL, join_id TEXT UNIQUE,
  trusted INTEGER NOT NULL DEFAULT 0,          -- may receive hidden-test inputs
  approved_slots INTEGER, per_device INTEGER,  -- NULL: what the runner offers / the instance setting
  state TEXT NOT NULL DEFAULT 'active',        -- active | draining | revoked | left
  build TEXT, version TEXT, facts TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER,
  last_seen_at INTEGER, last_address TEXT, offer_seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE remote_runner_codes (
  code_sha256 TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, uses_left INTEGER NOT NULL,
  trusted INTEGER NOT NULL DEFAULT 0, approved_slots INTEGER, name_prefix TEXT NOT NULL);
CREATE TABLE remote_leases (                   -- kept 7 days
  attempt_id TEXT PRIMARY KEY, runner_id TEXT NOT NULL,
  competition_id TEXT NOT NULL, submission_id TEXT NOT NULL, run_id TEXT NOT NULL,
  state TEXT NOT NULL, seq INTEGER NOT NULL, sealed INTEGER NOT NULL, code_cells INTEGER,
  provenance TEXT NOT NULL, manifest TEXT NOT NULL,   -- JSON: revision, data, sealed, notebook, bundle
  container TEXT NOT NULL, device TEXT, per_device INTEGER, slice_mb INTEGER,
  offered_at INTEGER NOT NULL, accepted_at INTEGER, started_at INTEGER, ended_at INTEGER,
  deadline_at INTEGER NOT NULL, outcome_sha256 TEXT, reply TEXT, reason TEXT);
CREATE TABLE remote_events (                   -- kept 90 days
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, runner_id TEXT NOT NULL, attempt_id TEXT,
  kind TEXT NOT NULL, address TEXT, detail TEXT);
```

**No revision triggers** on the `remote_*` tables. Liveness lives in memory, and `last_seen_at` is flushed at most once a minute.

**Remote cards never enter `competition_queue.gpu`.** So `kernel/pool.ts` (which keeps rooms off submission cards) and home's `freeShare` see only home's own cards.

**New competition settings**
- `homeNotebooks`: bool, default true.
- `scoreSlots`: 1–8, default 2.
- `runnerBlobMBps`: the blob rate.
- `runnerUploads`: 1–8, default 4.

### 5.2 Taking work for a runner

`takeForRunner(runner, offer)` is one synchronous transaction, next to `takeNext`.

1. **Stop** if the queue is paused, the runner is not `active`, its `build` differs from home's, or it has no free slot. Free slots are `min(approved_slots, the runner's room)` minus its live leases.
2. **Order.** Walk `selectNext`'s order with `kind='notebook'` only: late last, then the entrant's running COUNT across all holders, then turn, then enqueued_at. A runner with a free GPU share takes the first GPU row in that order before any CPU row.
3. **Skip a row, never stop on it,** when any of these holds:
   - its revision is not in `ready.revisions`, or the revision is home-only;
   - its data manifest is not in `ready.data`;
   - it is sealed and the runner is untrusted, or the sealed manifest is not ready;
   - `memory_mb + 256` exceeds the runner's remaining memory, or its cpus exceed the remaining cpus;
   - it needs a card and no share is left;
   - the runner is skipping it (the 10-min decline list).
4. **Take**:
   - `markRunning` with `holder`, a new `attempt_id`, and `boot` set to home's;
   - insert `remote_leases` with snapshots of the manifests, provenance, code cells, container name and deadline;
   - `startRun` for the run row;
   - subtract the row from the offer.

   Repeat until the offer is spent.

**Runner-side admission.** The agent computes `free` with the meminfo reader extracted from `capacity.ts` and `admitJob`'s math:
- usable memory = MemTotal − a 2 GB host reserve − Σ(memory + 256) over its attempts, capped by MemAvailable;
- cpus = nproc − 1 − Σ cpus;
- disk must leave 2 GB plus 256 MiB per attempt.

**Home's own `takeNext`.** `selectRunning`, `selectCardLoad` and `countClusterGpuRuns` count only rows with `holder IS NULL`. The pump always passes an explicit card picture, so a home without cards never takes GPU work.

### 5.3 Home pump: two lanes

- **Notebook lane.** Today's pump with `slots`, running only while `homeNotebooks` is on. Local notebooks keep the notebook and the metric under one lease, call for call as today.
- **Metric lane.** Takes `kind='metric'` rows (remote continuations and rescores) under `scoreSlots`, admitting `256 + metric MB` of memory each.
  - Continuations go first, then rescores, using `ORDER BY (submission.state = 'running') DESC` and then the usual keys. A continuation's submission is still `running` at stage `score`; a rescore's is `queued`.
  - A bulk rescore can therefore no longer hold up fresh results or new notebooks.
- **Answer key.** `snapshotSecrets` hard-links `solution.csv`, copying only as a fallback. It still runs when the job starts, which for a remote result is the start of its metric job. The answer's copy for the metric becomes a link too.

### 5.4 Splitting `runNotebookThenScore`

The split is in `server/src/competitions/runner.ts`.

**`prepareNotebook(row, placement)`**
- Runs `startRun` and reads the binding, the limits, the sealed list and the code cells, and checks that the bundle fits.
- For a local placement it also composes the inputs, verifies the bundle and picks the card.

**`settleNotebook(prepared, outcome)`** does the rest:
- clamps;
- `notebookNote`, `briefNote` and `teacherNote`;
- `finishRun`;
- the neighbour-OOM retry (`crowded` comes from the runner);
- `publishAttemptArtifacts`;
- the answer check;
- `promoteAttempt`.

**Local runs** go prepare → `runner.run` → settle → `scoreStep`, unchanged.

**Remote runs** prepare in `takeForRunner` and settle in the outcome handler, then call `continueAsMetric`:
1. Write `durationMs = outcome.wall` and the cells. `scoreOnly` adds the metric time onto `durationMs`.
2. Turn the row into a waiting `kind='metric'` row: `holder NULL`, `attempts 0`, and `turn`, `enqueued_at` and `late` kept. If `pending_kind` is set, use it instead, as `finishQueueAttempt` does.

### 5.5 GPU slices on runners

**The runner owns its cards**
- It probes them with a throwaway `--gpus all nvidia-smi` container, which takes about 6 s.
- At prepare it picks the device with the existing `pickRunnerGpu`, `cardsInUse` and `gpuSliceFor`.
- `VramWatch` and the share cap run unchanged.

**Home only counts shares.** It uses `offer.free.gpuShares`, one per GPU row it leases.
- `perDevice` comes from the runner's own setting or from the instance setting «Посылок на карту», and the lease pins it.
- The runner reports the device and slice back into `remote_leases`.

**Neighbour-burst retry.** The agent keeps its own share-kill window and reports `crowded`. Home requeues once, as today (`resource_retries = 0`).

### 5.6 The metric stays at home

- Remote runners never lease `kind='metric'`.
- `solution.csv` and `metric.py` never leave home, and the blob route cannot reach `secret/`.
- The metric runs in the submission's pinned image, as today, so home must hold every competition's image, GPU ones included (Q2).

### 5.7 Capacity and forecast

- **A live runner** is `active`, has a `build` equal to home's, and was heard within the TTL.
- **Slots** for `queueForecast` and `queueSnapshot`: home's `slots` (if `homeNotebooks` is on) plus, for each live runner, `min(approved, offered)`.
- **The GPU pool** for `forecastGpuSlots`: the sum of live runners' shares, plus home's.
- **A row no live executor can take** gets place `null` and a reason: `no_gpu_runner`, `preparing_image`, `preparing_data`, `needs_trusted`, `home_only_env` or `no_runners`. The participant sees «готовится» instead of a place.
- **Continuation rows** show «оценивается», with an ETA from the metric lane.
- **`fairOrder`** in panel.ts switches to the same running COUNT the SQL uses.

**Worked numbers**

| Burst | vsos alone | With runners |
|---|---|---|
| 100 CPU notebooks × 3 min, 2 CPU / 4 GB each | about 3 slots, so about 100 min | 4 VMs × about 10 slots: 3 waves in about 10 min, plus about 1 min of metric tail |
| 100 GPU CNN notebooks, 31 s each on a 3 GB share (measured on 0.22.0) | impossible | 4 VMs × 2×4090 × 8 shares: about 1–1.5 min of notebooks. The metric lane needs about 150 s for 100 results at 2 slots, or about 75 s at 4 |

The second row is why the metric lane is the next bottleneck. A warm scorer is the later fix (§11).

### 5.8 Doors

- **GPU competitions.** In `capabilities.ts`, `runnerGpus` is true when home has submission cards, or a non-revoked runner heard within the last hour advertises cards (Q9). The promised share is the one on the smallest advertised card.
- **Execution** still needs home's Docker and the image, because home captures, prepares and scores.
- **A revision without `registry_ref`** is still accepted, and is marked «только на этом сервере».

## 6. Security and trust

**Credentials**
- **Enrollment code.**
  - At least 128 bits; only the owner can mint one.
  - It is valid for N machines within at most 24 h, and carries the trusted flag and a slot cap.
  - Home stores its sha256. The code is shown once, inside the join command.
  - It can also be minted on the VM with `colloq-host runner-code`, which keeps Teleport SSH as a backup path.
- **Runner secret.** 256 bits; home keeps its sha256 and compares in constant time; it travels only in a header.
- **Revocation.**
  - The next call gets 401.
  - The runner's leases expire with no penalty, and late results are refused.
  - On a 401 the agent purges sealed data and stops.
- **`RELAY_TOKEN` never reaches runners.** The runner's on-start script holds only the URL and the code.

**What a runner sees.** Its leased notebooks, their wheels (that is, rivals' package choices) and open data. Hidden-test inputs only when it is trusted. **Never:** `solution.csv`, the metric, scores, names, emails, entrant keys or the database.

**What comes back is treated as participant data**
- a name allowlist;
- caps applied after decompression;
- sha256 checks;
- staging outside the attempt dirs;
- the `attemptId` inside run.json;
- clamps and blind texts applied at home.

**Threats and what is left**

| Threat | Gains | Does not gain | What limits it |
|---|---|---|---|
| A stolen runner secret | Its leased notebooks (rivals' code mid-competition); hidden-test inputs if the runner is trusted; forged results and texts of up to 2,000 characters for its leases; lease hoarding | Answers, the metric, scores, accounts, rooms, other runners | The approved-slot cap, the lease ceiling, revocation, quarantine, the events log |
| A container escape on a runner | The same, plus that host | The same | One ephemeral VM per event; `make runners-down` |
| The Vast host operator | Everything on that VM, including the hidden test if trusted | Home | Trusted is off by default (Q1) |
| Root on relay2, or anyone holding `RELAY_TOKEN` during a tunnel gap | Can read bearer secrets and pose as vsos, because TLS ends on relay2 | — | The same exposure staff cookies have today; signing in v2 (Q4) |
| A notebook that kills runners | At most 3 walls of GPU time | Quota | The loss limit makes it `metricFailed` |

**Audit.** `runner.enrolled`, `runner.trusted` and `runner.revoked` join `AdminAuditAction`, with the staff member as actor. Leases, losses, sealed fetches and addresses go to `remote_events`, kept 90 days.

**Host.** The agent holds the Docker socket, which is root on that machine. Like home, runners need dedicated machines.

## 7. UI touchpoints (Paper first: page «16 · Исполнители»)

**Wording.** «Исполнитель» means a machine. The console already uses «исполнители» for queue slots ("{count} исполнителей × {memory} ГБ"); those strings switch to «места» (Q10).

1. **Ресурсы → «Исполнители».**
   - A summary line, for example «3 на связи · 34 места · 4 карты × 4».
   - The switches «Тетради на этом сервере» and «Оценка: N одновременно».
   - One row per runner showing:
     - name and a state chip: на связи / молчит N мин / устарел — обновить / осушается / отозван / на карантине;
     - version, CPU, RAM and disk;
     - cards with their shares, and places busy out of total;
     - readiness for each open competition: образ ↓ 45 % / данные ✓ / an error with its reason;
     - last seen and address.
   - Row actions: Места, Посылок на карту, Доверенный, Осушить, Отключить. «Отключить все» for the whole list.
   - The empty state leads to «Подключить».
2. **The «Подключить исполнитель» dialog.**
   - Fields: how many machines, how long the code stays valid, «Доверить скрытый тест» (off by default), and places (auto).
   - It then shows the code once, inside three ready commands with copy buttons: Docker already installed, a bare machine, and `make vast-runner`.
   - A live «ждём первую машину…» turns into the runner when it joins.
3. **Runner detail.**
   - Facts.
   - Revisions and data, with progress and reasons, for example «драйвер 535, нужен 580+».
   - Current runs, the last 50 events, and the loss and decline counters.
4. **Competition console (Live).**
   - The executor grid is grouped by «Сервер» and then each runner. A running cell shows its runner and card.
   - A waiting row shows its reason.
   - The header shows how much of the fleet is in use.
5. **«Работают сейчас».** Remote runs appear under their runner, with «0 МБ здесь». Stop is a durable cancel.
6. **Competition settings and the door.** A «Среда только на этом сервере» warning. GPU competitions are accepted on runners' cards.
7. **Participant view.** Unchanged, except for «готовится» and ETAs that count runners.

Every screen must also work at phone width.

## 8. Deploy

### 8.1 Join commands (the panel shows them filled in)

**Docker already installed** (any Linux amd64 with Docker Engine 28+; GPU hosts also need nvidia-container-toolkit):
```sh
docker run -d --name colloq-runner --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /var/lib/colloq-runner:/var/lib/colloq-runner \
  -e COLLOQ_RUNNER_JOIN='https://vsos.colloq.ru#<code>' \
  ghcr.io/colloq-edu/colloq-server:0.23.0 runner
```

**A bare machine** (adds the toolkit, checks for driver 580+ and freezes updates on Vast):
```sh
command -v docker || curl -fsSL https://get.docker.com | sh
docker run --rm -v /usr/local/sbin:/host ghcr.io/colloq-edu/colloq-server:0.23.0 install-host /host
colloq-host runner up https://vsos.colloq.ru <code>
```

On a private registry, `colloq-host runner up` honours `COLLOQ_REGISTRY_USER` and `COLLOQ_REGISTRY_TOKEN` (read-only, one per runner).

### 8.2 The image

`colloq-server` (one digest with `colloq-vast`) gains `dist/runner.js`, an esbuild entry next to `runtime-smoke.js` and `local-cleanup.js`. The entrypoint gains a `runner` case:
1. `prepare_as_root`: the state dir is owned by uid 1000 and the docker group is set.
2. `require_docker`.
3. Set `NODE_ENV=development`, `KERNEL_BACKEND=docker` and `COMPETITION_BACKEND=docker`.
4. `exec node dist/runner.js` as uid 1000.

The runner has no ports, no tunnel and no database.

`colloq-host runner up|update|status|logs|leave` uses its own container `colloq-runner` and its own env file `/etc/colloq/runner.env`. It reuses `ensure_docker`, `ensure_gpu`, `freeze_host_updates`, `registry_login` and `fetch_image`.

### 8.3 Vast

**`make vast-runner COUNT=3 GPU="RTX 4090" GPUS=2 DISK=150 CODE=<code> [URL=https://vsos.colloq.ru]`** runs `scripts/vast-runner.sh`. That starts COUNT parallel copies of `scripts/vast-vm.sh` (`vm:true`) with:
- `ROLE=runner`;
- `ONSTART=deploy/vast/onstart-runner.sh`, filled with only the URL and the code;
- a wait on `colloq-host runner status` instead of `/api/health`.

Instances are labelled `colloq-runner`.

**Fleet commands**
- `make runners-update` runs `colloq-host runner update` on each runner over ssh.
- `make runners-down` runs `colloq-host runner leave` over ssh (drain, then the runner revokes itself) and destroys the VM.

**CPU runners.** Vast has no VMs without a GPU, so a CPU runner is the cheapest VM with many cores, and its card can take GPU work as well.

The brief's `make vast-worker` is this target; it is called `runner` because "worker" already names the in-process pumps.

### 8.4 Upgrades and version skew

**The compatibility key is the runner build:** the sha256 of `dist/runner.js`, written to `dist/runner.sha256` at build time.
- The bundle contains the sandbox argv, the harness files and the protocol, so two runners with the same build behave identically.
- The version string is read at run time, not bundled. A release that touches none of these (UI, docs, home-side logic) keeps the fleet serving.
- Under `make dev`, both sides report `dev`.

**A runner with a different build is «устарел».**
- It gets no new leases, but leases already in flight still finish.
- The outcome format only ever gains optional fields. A breaking change bumps `protocol`, and in-flight leases are requeued with no penalty.

**Updating**
- `colloq-host runner update [version]` drains the runner (in-flight work finishes, bounded by the longest wall), then restarts it on home's version, which the agent records.
- `--now` releases in-flight work instead, with no penalty.
- `make runners-update` does this for the whole fleet.

Update home between competitions. If that is not possible, run `make runners-update` right after.

## 9. Build plan

| # | Phase | Files | LOC (est.) | Useful on its own |
|---|---|---|---|---|
| P0 | Measure. From a Vast VM through vsos.colloq.ru, with a room open: a timed Range GET of a 200 MB file, a 64 MB PUT, and 20 held requests. On vsos: `docker info` (image store), `df`, GHCR pull speed, metric container time, and whether the self-probe through the relay works | `scripts/runner-probe.sh` | 120 | Sets the blob rate and hold time, and decides the second-frpc question |
| P1 | Groundwork:<br>- `competition_files.sha256` with its backfill<br>- an exported stat-cached hasher<br>- hard links for `snapshotSecrets` and for the metric's answer<br>- `registry_ref` and `layers`, with backfill<br>- wheel `url` in bundle manifests<br>- `--pull=never`<br>- `RunRequest.competition` narrowed to what `run` and `score` read | `competitions/{store,storage,runner,docker-runner}.ts`, `routes/admin-competitions.ts`, `dependencies/{files,revisions,store,preparation-python,preparation-contract}.ts`, `shared/dependencies.ts` | 450 | Faster local runs: no 200 MB copy per job |
| P2 | Importable core:<br>- pure GPU math moved to `competitions/gpu-math.ts`<br>- the meminfo/cgroup reader moved out of `capacity.ts`<br>- the card probe moved out of `kernel/resources.ts`<br>- the `dist/runner.js` entry and `dist/runner.sha256`<br>- an esbuild-metafile test that the agent loads neither `db.ts`, `kernel/pool.ts`, nor anything with import-time side effects | `competitions/{gpu,capacity,docker-runner}.ts`, `kernel/resources.ts`, `server/package.json` | 250 moved | — |
| P3 | Queue and split:<br>- `holder` and `lost` columns<br>- selects scoped by holder<br>- the metric lane and `scoreSlots`<br>- `homeNotebooks`<br>- `prepareNotebook`, `settleNotebook`, `continueAsMetric`<br>- reclaim skips remote rows<br>- the re-drive guard on publish and promote<br>- `fairOrder` uses the COUNT | `competitions/{store,runner,settings,forecast,panel}.ts`, `shared/competitions-settings.ts` | 600 | Rescores stop blocking new notebooks |
| P4 | Contract: messages, strict parsers, caps, constants | `shared/remote-runner.ts` | 350 | — |
| P5 | Home:<br>- tables, codes, auth<br>- `takeForRunner`, reconciliation<br>- liveness: path evidence, ceiling, quarantine<br>- apply and re-drive, cancel<br>- blob index and token bucket<br>- streamed gunzip uploads<br>- the mount<br>- doors, forecast, «Работают сейчас», console data<br>- owner API, audit actions, Prometheus counters | new `competitions/remote/{store,lease,liveness,routes,blobs,upload}.ts` and `routes/admin-runners.ts`; `app.ts`, `index.ts`, `competitions/{capabilities,erase,forecast,panel}.ts`, `routes/{admin-running,admin-competitions}.ts`, `shared/admin.ts`, `ops/metrics.ts` | 1,400 | — |
| P6 | Agent:<br>- a client with the marker header, backoff and proxies<br>- the sync loop<br>- the CAS and prefetch<br>- image prep with the GPU smoke test<br>- prepare and execute through `DockerCompetitionRunner`<br>- uploads<br>- restart recovery and drain | new `server/src/runner-agent/{main,client,sync,cache,images,execute,upload}.ts` | 1,000 | — |
| P7 | Packaging:<br>- the entrypoint's `runner` case<br>- `colloq-host runner …`<br>- `onstart-runner.sh` and `vast-runner.sh`<br>- Makefile targets `vast-runner`, `runners-update`, `runners-down`, `runner-dev`<br>- `make kernel-publish` for the GPU kernels | `deploy/vast/{entrypoint.sh,colloq-host,onstart-runner.sh}`, `scripts/{vast-vm,vast-runner}.sh`, `Makefile` | 450 | GPU kernels in GHCR help any GPU host |
| P8 | UI, after Paper:<br>- the runners block and its dialog<br>- runner detail<br>- console grouping and reasons<br>- «Работают сейчас»<br>- locales | `web/src/admin/screens/ResourcesTab.svelte`, new `web/src/admin/ui/Runners.svelte` and `web/src/admin/runners.ts`, `web/src/admin/screens/competitions/Live.svelte`, `web/src/admin/ui/RunningKernels.svelte`, `shared/locales/{admin,competitions}.ts` | 900 | — |
| P9 | Docs: a runners page in ru and en, and updates to the competitions, server, vast and security pages | `docs/pages/{ru,en}/runners.html`, `pages.json` | — | — |
| P10 | The rehearsal (§10.2), and a per-runner report in `competition-load` | `scripts/competition-load.mts` | 100 | — |

**Order**
- P0, P1 and P2 run in parallel.
- P3 follows P1.
- P4 comes before P5 and P6, which then run in parallel and meet in the Docker-free end-to-end test.
- P7 runs alongside P6. P8 runs alongside P5 once the Paper page is approved.

**Review.** The double review goes to P3 (the `runner.ts` split) and to P5's auth and upload code.

**Releases.** Planned as P1–P3 in 0.23.0 and P4–P9 in 0.24.0; shipped as one release, 0.23.0, the version the commands in §8 name. A release with the split queue but no machines gains nothing on its own (vsos updates only through Teleport anyway), and a rollback onto it would leave the submissions a machine held «считаются» for good: it knows rows can have another holder, but not machines, so it would not take them back.

**vsos.** vsos must be updated to that release. It is still on 0.20.0, and updates need Teleport.

**Total:** about 5.6k LOC, plus about 2.5k LOC of tests.

## 10. Test plan

### 10.1 In the repo, without hardware

The agent's tests run under Node 22, the image's version, not the Mac's Node 26.

- **Contract.**
  - The parsers refuse unknown keys, bad ids or hashes, and oversized fields.
  - Every reply carries the marker header.
  - The client treats an HTML 404 or 502 and a 504 as transient.
- **Take.**
  - The order holds across home and runners.
  - Each skip filter works.
  - A runner with free shares takes GPU rows first.
  - The approved-slot cap holds, and so do home's holder scopes.
  - A CPU-only runner never takes GPU work, and no runner takes metric rows.
  - A stale held `sync` cannot over-commit.
  - Randomized interleavings of the home pump and two runners never take a row twice.
- **Lifecycle.** In-process agents on `fake-runner.ts` (`useCompetitionRunner`) run against the test server.
  - The full path works: submit → lease → upload → outcome → flip → `scoreOnly` → scored, with `durationMs` = notebook + metric.
  - Sealed clamps and blind texts are the same as on a local run.
  - Leases with bundles work.
  - Sets that do not fit settle at home.
  - A failed notebook gets no metric row.
- **Faults.** These run through a proxy that drops replies, cuts connections and returns the relay's HTML page, with a fake clock:
  - home restarted mid-run on the same database;
  - the agent killed mid-run;
  - network partitions.

  Every submission ends exactly once, losses spend no quota, and no run row is duplicated. Boot grace, path evidence, the all-silent hold, the ceiling and quarantine all behave as specified.
- **Cancel and pending work.** Cancel, erase and delete during a remote run work. `pending_kind` is honoured at apply. Late results get 409.
- **Uploads.**
  - Refused: over a cap after decompression, a gzip bomb, a sha mismatch, an unknown name, a foreign or revoked attempt.
  - A full disk gets 507; back-pressure gets 503.
  - The result tree at home equals what the Docker export produces.
- **Blobs.**
  - A hash out of scope gets 404, including guessed `solution.csv` and `metric.py` hashes.
  - Sealed blobs go to trusted runners only.
  - A replaced file gets 410.
  - Range resume works, and the stream cap holds.
- **Auth.**
  - Codes expire and count their uses.
  - The staff, entrant, room and WebSocket doors refuse the runner secret, and the runner router refuses theirs.
  - Revoking gives 401 and requeues the runner's leases.
- **Images.**
  - Inspect fixtures from the classic and containerd stores give the same `layers`.
  - Backfill works.
  - A locally built image is home-only.
  - A layer mismatch leaves the revision not ready.
- **Parity.**
  - A snapshot test shows the same argv on home and on the agent.
  - A Linux CI job (runtime-smoke style, uid 1000) has the agent and a test home run one CPU notebook end to end through real Docker, plus sealed and bundle variants.
- **Regression.** The whole suite stays green, especially:
  - `competitions-runner`, `competitions-sealed`, `competitions-erase`;
  - `competition-gpu-*`, `competition-broker-*`;
  - `competition-attempts`, `competition-resource-retry`.

### 10.2 On Vast

**The rig**
- **VM H** is home: a Vast VM whose cards are not given to submissions, with `homeNotebooks` off and `slots` set close to vsos. It sits behind relay2 under a test name.
- **VM G** is a runner with 2×4090 and driver 580+.
- **VM C** is an optional second runner: the cheapest VM with many cores.

Never use vsos for this. Never `pkill` by pattern; kill only your own pids. relay2 is shared, so run the bursts outside class hours.

**Prerequisites**
- Release-candidate images are in GHCR, and `base-gpu` and `kaggle-gpu` are published.
- Three competitions exist:
  - CPU: kaggle-base, 150 MB of data and a 3-minute reference notebook;
  - GPU: kaggle-gpu, the CNN letters seminar, 2 cards × 8;
  - a sealed copy of one of them.
- 100 entrants are joined in advance, in batches (about 60 joins per address per 10 min), or the load host is listed in `SHARED_ADDRESSES`.

**Steps**
1. Run the P0 probe from G and from C, and record the numbers.
2. Join G and C from the panel. Time the path from join to ready: pull, verify, smoke test, prefetch.
3. Run the matrix:
   - CPU: ok, cell_error, timeout, OOM, output kill, no-submission;
   - GPU with shares;
   - sealed on a trusted runner, and waiting with a reason on an untrusted one;
   - a bundle from PyPI;
   - cancel, rerun, rescore.
4. Run the bursts with `make competition-load N=100`: (a) CPU on G and C, (b) GPU on G. Record:
   - acceptance time; wait and run times at p50 and p95; the last verdict;
   - lease → container start, container exit → applied, and applied → scored;
   - the metric lane's rate;
   - bytes through the relay, from relay2's interface counters before and after;
   - CPU on H;
   - a room's collaboration RTT in headless Chrome, during prefetch and during the burst.

   Compare (b) with 0.22.0's 62 s for 25 submissions on one VM.
5. Inject failures during bursts of 30:

| Inject | Expect |
|---|---|
| `vastai destroy` C mid-run | Lost after 180 s, since G gives path evidence. Requeued keeping its place, re-run on G, scored once, no quota spent |
| `docker kill colloq-runner` on G | The agent restarts, sweeps, reports the attempts absent; they are requeued at once |
| Restart home H mid-run | Runs continue. Outcomes apply after boot, metric rows re-run, nothing expires during boot grace |
| Block H's tunnel for 5 min (iptables) | No expiry, since there is no path evidence. Syncs resume and the work completes |
| Partition G for 5 min (iptables to relay2) | C proves the path, so G's leases are lost and re-run on C. G's late outcomes get 409 and its attempts are revoked |
| Drop 20 % of replies (a fault proxy through `HTTPS_PROXY`) | Offers repeat until acked, with no duplicates |
| Cancel, then revoke G, then untrust G mid-run | The kill lands in about one round trip. Revoking gives 401 and requeues. Sealed data is purged |
| Fill G's disk (`fallocate`); retag a wrong image | A decline and a 10-min skip, and C takes the work. The revision shows not ready, with the reason |
| Deploy a home build with a different runner build | Runners show «устарел», get no new leases, and finish in-flight work. `make runners-update` restores them |
| A neighbour burst on a shared card | The victim is requeued once and scored |
| Doctored uploads: a gzip bomb, a wrong hash, a foreign attempt, a large run.json | Refused, with nothing written |

6. **Accept when:**
   - every submission is terminal exactly once, in fair order;
   - quota and failure counts are untouched by losses;
   - no labelled containers are left on the runners;
   - «Работают сейчас» shows 0 MB for remote runs;
   - the median remote overhead is at most 3 s;
   - at most 1 MB per submission crosses the relay, prefetch excluded;
   - the room's collaboration RTT at p95 stays within 50 ms of the baseline.
7. Run `make runners-down` and destroy H.

## 11. Risks and open questions

### Risks

**Capacity**
1. **The relay path has never been measured.** P0 decides the defaults.
2. **The metric lane is the tail of a GPU burst:** about 0.7 verdicts/s with 2 slots of about 3 s each. The later fix is a warm scorer, one container per competition scoring many answers. That gives up isolating each answer from crafted CSVs, so it needs a security review first.
3. **GPU kernels reach GHCR only through `make kernel-publish`,** a manual step at release time on a machine with a card (decision 3; RELEASING.md, «GPU kernels, at release time»), not through publish.yml. A home pulls them when they are listed in `KERNEL_PRELOAD`; one that prepares them before they are published for its version builds them itself, as it does for lists it edited, and keeps that build until it is moved onto the published one; machines cannot run what it built. vsos must also hold each GPU image to pin a competition's revision and to prepare its bundles: a ~4 GB pull and ~13 GB of its 121 GB disk.
4. **Long-polls through frp with tens of runners.** frpc logged "pool is full" at 10 parallel uploads, so the hold time and caps are settings.
5. **relay2 is a single point of failure** for both the classes and the runners.
6. **The forecast treats the fleet as one pool,** so ETAs for sealed and GPU work are optimistic.

**Correctness**

7. **Image identity bugs.** A wrong fingerprint or RepoDigests capture makes runners refuse good images or run the wrong one.
8. **The `runner.ts` split touches every submission** on every instance.

**Security**

9. **The hidden test on rented hosts** is protected by a policy, not by cryptography.
10. **A stolen secret or compromised runner** can read rivals' notebooks and forge results for its leases. Detection is statistical.
11. **TLS ends on relay2,** and `RELAY_TOKEN` is shared by every *.colloq.ru instance.

**Operations**

12. **Vast is unreliable,** which costs GPU time. After 3 losses a submission that did nothing wrong ends as `metricFailed`.
13. **vsos updates depend on Teleport and Spirit SSO.** Both failed on 12 Oct, and 0.21.0 is not deployed. vsos needs this release before a class relies on runners.
14. **Runner disks can fill up,** causing declines at the worst moment. Floors and LRU eviction guard against it.
15. **Docker differs across runners:** the containerd store, the toolkit, the driver. Each shows up as a revision that is not ready, with a reason.

### Open questions for the owner (the default is in brackets)

- **Q1. Hidden test on rented VMs:** allow it on runners marked «доверенный», or never on Vast? [A trusted flag per runner, off by default.]
- **Q2. Metric for GPU competitions:** score on vsos in the GPU image, at ~13 GB of disk per revision, or switch scoring to a CPU revision, which changes what the metric sees? [vsos and the GPU image.]
- **Q3. GPU kernels:** publish them from a Vast builder each release, or invest in CI disk? And for teacher-built environments, run a registry of your own, or keep them home-only? [A Vast builder; home-only.]
- **Q4. Are root on relay2, and anyone holding `RELAY_TOKEN`, attackers?** If yes, signed requests go into v1 (about +400 LOC). [No: bearer tokens now.]
- **Q5. vsos with runners:** should home notebooks be off during competitions? Is `scoreSlots` 2 right next to a live class? [Off during a competition; 2.]
- **Q6. Version lockstep:** drain and update, with the build digest deciding compatibility, or agent self-update later? [Drain and update.]
- **Q7. Loss policy:** is 3 losses right? Should the top or final private-board submissions be re-run at home or on another runner for integrity? [3; no re-run in v1.]
- **Q8. If the probe shows a slow tunnel:** a second frpc name, a relay mirror for open data, or a second relay box? [A second frpc name.]
- **Q9. The GPU door:** accept when a runner with cards was seen within the last hour, or only when one is online? [Within the last hour.]
- **Q10. Naming:** «исполнители» for machines and «места» for slots? Flag runners left idle for N hours, or revoke them after an event? [Yes to the names; flag after 2 h.]

## 12. Owner's decisions (13 Oct 2026, 23:14 MSK) — binding

The owner answered «Поехали» to these proposals; they override anything above that disagrees.

1. **Hidden test on rented hosts.** Each machine has a «доверенная» flag, off by default; the owner sets it at join or later. Sealed inputs go only to trusted machines; a sealed competition waits (with a reason) when no trusted machine is free.
2. **Metric of GPU competitions** runs at home in the light `kaggle-base` image (numpy, pandas, scikit-learn, scipy), not in the competition's 10–13 GB GPU image. CPU competitions keep scoring in their own pinned image as today.
3. **GPU kernels in a registry.** `base-gpu` and `kaggle-gpu` are published to GHCR with each release (publish.yml job with disk cleanup, or a release-time `make kernel-publish`). Teacher-built environments run at home only in v1, with a visible reason.
4. **No request signing in v1.** A per-machine revocable bearer secret is enough (relay2 is the owner's own VPS).
5. **Versions.** A machine takes new leases only when its runner code matches home's (the dist/runner.js hash); in-flight leases finish. One command updates every machine; no self-update in v1.
6. **Losses.** A submission lost by three different machines ends as a server failure that spends no quota.
7. **Measure first.** P0 measures the relay path before the blob rate and hold time are fixed (measure through a lab home behind relay2, never through vsos during a class).
8. **GPU door.** A GPU competition accepts uploads when a machine with cards was seen within the last hour (plus home cards, as in 0.22.0).
9. **Naming.** The remote hosts are «машины»: Resources → «Машины для посылок», «Подключить машину», machine detail. The console's «исполнители» keep meaning places/slots (no rename to «места»). Code keeps the `remote` prefix.

## 13. Implementation notes (14 Oct 2026, after P1 and P4) — binding for later phases

1. **Image identity is a table, not columns.** `environment_revision_images(revision_id, registry_ref, layers)` replaces the two columns of §5.1, because 0.22 inserts revisions with a positional INSERT. Read it as `EnvironmentRevision.registryRef` and `.layers`. `layersFingerprint` in `server/src/dependencies/image-identity.ts` is the only definition of the fingerprint; nothing else may compute it.
2. **The contract in `shared/remote-runner.ts` is authoritative** where it differs from §3.3. It adds: a required `fetching` list in the sync request (download progress for «образ ↓ 45 %»), optional `facts` in the first sync after each start (cards are not facts; they travel in every sync), `trusted` in the sync reply (the machine purges hidden-test data when untrusted), compact package sets (at most 8 described per reply, the rest by id), an inline-notebook budget of 1 MiB per reply, `runJson` as base64, a closed set of problem codes, and the error table `REMOTE_ERRORS` (a protocol mismatch is 426). Agent-side numbers and texts go through `remoteProgress`, `remoteOutcome`, `remoteCount` and `remoteText`; stored wheel URLs through `remoteWheelUrl`.
3. **A `draining` decline at any phase** (including `colloq-host runner update --now` after the container started) requeues the row with no loss counted and no quota spent (§8.4 "with no penalty").
4. **The runner build must not change every release.** `COLLOQ_VERSION` is a JSON import that esbuild inlines today; `dist/runner.js` must read the version at run time (for example from the package.json next to it or an env var) so a release that touches no runner code keeps the fleet compatible (§8.4).
5. **`letContainerRead` must chmod only when the mode differs.** It runs on every local run and moves ctime, which is part of the `cachedSha256` key; otherwise the blob route re-reads up to 200 MB after each run.
6. **Containerd store caveat.** A local build tagged with a registry name but never pushed shows a `RepoDigests` entry and gets a `registry_ref` that cannot be pulled. The agent reports it as an `image` problem, never as ready.
7. **Hash-only writes bump no revision.** Any future UPDATE on `competition_files` that changes content must set a column in `FILE_CONTENT_COLUMNS` (store.ts).
8. **`/.relay/state` already exists** on the relay (`scripts/relay-setup.sh`), so the agent can use it to tell "home offline" from "refused".

### 13b. After P2 and P3 (14 Oct, 01:50)

9. **No translations in the runner bundle.** `shared/i18n.ts` registers every locale at import, so importing the core pulls 1.6 MB of UI strings into `dist/runner.js`, and any UI text edit would change the build and make every machine «устарела». The runner build (server/scripts/build-runner.mjs) swaps `shared/i18n.ts` for server/src/runner-agent/i18n-shim.ts: `tr(key, params)` returns a marker (`REMOTE_TEXT_OPEN` + key + `REMOTE_TEXT_SPLIT` + JSON params + `REMOTE_TEXT_OPEN`) that home turns into its own language with `remoteRenderTexts(text, tr, hasTranslation)` (shared/remote-runner.ts) when it applies an outcome — on outcome.detail, outcome.log, a decline's detail and each problem's detail, BEFORE settleNotebook (runner.ts compares the detail with tr's sentence for blind participants); `remoteOutcomeDigest` stays computed on the raw request, markers included. A marker only ever renders an existing key with primitive params, so a notebook printing one gains nothing it could not print itself.
10. **DATA_DIR before imports.** `data-dir.ts` resolves DATA_DIR once at load. The agent must have it in its environment before the core loads (the entrypoint sets `DATA_DIR=$COLLOQ_RUNNER_STATE/data`); never set `process.env.DATA_DIR` after static imports.
11. **Rebuilding a prepared run at apply.** P5 rebuilds `PreparedNotebook` from `remote_leases`, never by calling `prepareNotebook` again (that would start a second run row). So the lease stores: runId, container, sealed and the sealed file list, codeCells, provenance, limits, and the submission's cellsDone/cellsTotal/durationMs from before the run (the neighbour-OOM retry restores them).
12. **Applying twice.** `settleNotebook` repeats its database writes when called twice; the apply path must stop at the lease state (`applying`/`applied`) and the `continueAsMetric` fence (false = already flipped) before calling it again.
13. **Cancel, erase and delete** of a machine-held row are still local-only until `cancelRemote` (P5): `cancelSubmission` acts on a local container, and `stopCompetitionRuns` returns false.
14. **Visibility.** `runningRows()` covers only this server's runs, so machine runs are missing from `runnerStatus`, `queueSnapshot` and «Работают сейчас» until P5 adds them; the forecast counts only home's lanes until P5 adds machines' places and shares.
15. **Settings view.** The four new settings save through the existing PUT /api/admin/competitions/settings, but `settingsView` in routes/admin-competitions.ts does not return them yet; `runnerSettings()` is ready.
16. **Remote rows never carry `gpu`.** `kernel/pool.ts` selects running rows' gpu without a holder filter; that stays safe only while machine-held rows never get `competition_queue.gpu` (§5.1).
17. **The metric's revision** is recorded on the metric run row (`submission_runs.revision_id`).

### 13c. After P7 (packaging, 14 Oct, 02:15)

18. **The image's health check knows its mode.** `HEALTHCHECK` runs `colloq-vast health`: in runner mode that is the agent's cheap `runner status` (local state only, one JSON line: joined, compatible, homeVersion, version), in serve mode a curl of /api/livez. A plain `docker run` machine (§8.1) is healthy without extra flags.
19. **The agent's CLI.** No arguments = run the agent (the entrypoint turns `runner join URL CODE` into COLLOQ_RUNNER_JOIN and never passes the code as an argument); `status`, `drain` (stop taking leases, exit 0 when nothing is held), `leave` (drain, revoke itself, exit; also works in a one-off container). SIGTERM with `docker stop -t 90` hands back held runs as `draining` declines.
20. **COLLOQ_RUNNER_CONTAINER and COLLOQ_RUNNER_IMAGE** are always set inside a container (colloq-host passes them; for a plain docker run the entrypoint derives them). Under `make runner-dev` they are unset: the agent then has no container of its own and must not `docker update` anything on a 401.
21. **Leave retires the identity.** After a successful leave, colloq-host moves runner.json to `runner.json.left-<UTC stamp>`; the agent never reads those files.
22. **Fleet commands are per home.** `make runners-update|runners-down URL=<home>` act only on that home's machines (read on each machine from COLLOQ_RUNNER_JOIN before the #); update skips machines already compatible unless FORCE=1 and runs detached on the machine; `make vast-runner DESTROY_UNJOINED=1` destroys rented machines that never joined; `make runner-dev` refuses without URL= (never the live :3000).
23. **The state directory is dedicated.** colloq-host and the entrypoint refuse system roots (/, /var, /var/lib, /usr, /etc, /home/<user>, Docker's stores, the instance's own state) before any chown.
24. **colloq-host adopts plain `docker run` machines** on their first update, leave, status or logs (image, env and mounts read from docker inspect).

### 13d. After fix wave 1 (14 Oct, 06:00) — what changed from the text above

25. **The reply marker** is `X-Colloq-Runner-Api: colloq-runners` (version-independent), with the protocol in `X-Colloq-Runner-Protocol`. Any `/api/runners/v<n>` other than home's answers a marked 426; a marked 426 is final for the agent. Agent-side parsers of home's replies ignore unknown keys; home's request parsers stay strict. `RemoteOutcomeReply` carries `trusted`; a repeated outcome gets its cached result with fresh leases (never the offers cached with the first reply), and a `draining` decline gets none.
26. **`want.data`** has one entry per (competition, kind); byte-identical competitions may share a manifest.
27. **Neither lane goes first by right** (fix wave 2; wave 1's "the metric lane goes first" starved notebooks behind a bulk rescore, as notebook-first had starved metrics). Each lane with a free place names its next row; when this server's memory fits only one of the two heads, the one that waited longer is admitted first (`panel.ts · laneHeadOrder`: on-time before late, then the earlier `enqueued_at`, then the id). A machine's fresh result keeps its notebook's arrival; a rescore arrives when it is asked for. A head refused for memory that the queue's own runs will free ends the pass, so the other lane cannot take that memory; a head no end of a queue run can make fit, or one refused for disk or a failed take, closes only its own lane. Each lane stays within its own places (`scoreSlots`, `slots`). The forecast simulates the same rule over the same memory (`laneEtas`; `queueEtas` is its one-lane case).
28. **Freshness is on the queue row** (`competition_queue.fresh`): set by continueQueueAsMetric, cleared by upsertQueue and pending kinds; reclaim keeps fresh rows at running/score; 'rescore all' leaves rows already waiting as metric alone.
29. **The GPU metric is pinned per competition** (`competition_metric_revisions`): the first metric pins the current kaggle-base (or own-pin mode for competitions whose earlier metrics ran in their own image); a missing pinned image fails the metric with `scoringImageGone`; an unreadable probe defers it. The teacher re-pins with `POST /api/admin/competitions/:id/metric/image`, which rescores the whole competition. The metric-only doors check the image the metric will run in. kaggle-base is recorded on demand when its image is present.
30. **Rollback safety**: a row with a holder and no live `remote_leases` row (or no such table) is this server's orphan at boot: requeued with no penalty, holder cleared. No DATA_SCHEMA bump.
31. **Re-drive records** are written temp + fsync + rename + directory fsync; an unreadable record stops a re-drive instead of being read as "nothing moved".
32. **Data digests** are keyed on (dev, ino, size, mtime) in their own cache; links and chmods no longer cause rereads.
33. **Wheel URLs** live in `dependency_bundle_wheel_urls`, never in manifest.json (mounted at /deps) or packages_json (served by 0.22 after a rollback).
34. **Quarantine counts events, not leases**: one agent restart losing N runs is one event; only losses after the container started count.
35. **`RemoteWaitReason` gains `no_fit`**: no live machine can ever fit the row (memory, cpus, package set, limits); blockedBy and the take share one predicate.
36. **Erase and delete** remove remote_leases and remote_events rows with the submission or competition.
37. **The agent**: per-download part files with the hash verified before the CAS rename and before use; approvedSlots caps free.slots; REMOTE_ATTEMPTS_MAX held at most; the disk floor gates fetches and pulls, Docker's root dir measured too; one draining sync on SIGTERM; COLLOQ_RUNNER_CONTAINER unset = no container of its own; sealed purge spares held leases; ENOSPC on lease writes becomes a decline or a disk problem; smoke-test containers carry the tree's instance label.

### 13e. After fix wave 2 (14 Oct, 09:30) — what changed from the text above

38. **Lanes and the pause.** The lane order is note 27's. Under a pause only the metric lane runs, and only for fresh results (`store.ts · selectNextScore`): notebooks and rescores wait for the pause to end.
39. **The metric pin outlives the card switch** (`runner.ts · scoresInPin`: the card is on, or a pin exists). `metricHistoryRevision` counts only kaggle-base runs and scored own-image runs that are not the baseline's, so a CPU-era baseline no longer forces own-image mode. The panel re-pins: the editor's «Образ метрики» row (competitions with a card) and «Перевести метрику на текущий kaggle-base» on a console row whose metric failed for a gone image.
40. **Enrollment codes can be ended**: `DELETE /api/admin/runners/codes/:id` (404 unknown, 409 ambiguous), «Отменить» in the block's «Коды подключения»; «Отключить все» ends every live code too. A code minted in the panel is audited as `runner.code_minted`, and an ended one as `runner.code_ended` (target type `runner_code`); a code minted by `colloq-host runner-code` (`ops/runner-code.ts`, `createdBy: 'colloq-host'`) records no audit event and is listed in «Коды подключения» as «выпущен на консоли сервера».
41. **Places are effective** (`views.ts · placesFor`, `placesForMix`): a machine's cap, bounded by how many of the competition's own runs (memory + 256, cpus) its whole capacity holds. The console and «Где считается» count the competition's run; the machines list counts the queue's notebook mix, else the largest run of an open competition, else the defaults. `RemoteMachine.places.offered` is this number.
42. **The upload door for machine-only competitions** (`capabilities.ts · machinesRunIt`): with the competition's own image absent, its notebooks the machines' alone (`fit.ts · homeTakes`), its revision portable and a fitting machine (with cards, for GPU) heard within `REMOTE_GPU_SEEN_MS`, the door checks the image the metric runs in. A CPU competition still needs its own image, and so do the first capture of a competition's revision and package preparation.
43. **Liveness.** Quarantine counts only losses and declines after the owner's last resume (`remote_runners.resumed_at`). A machine's silence counts only from the last clock pass without path evidence, so every machine gets a full `REMOTE_SILENCE_MS` once evidence returns; a loopback, link-local or own-interface `PUBLIC_URL` is never probed. A draining decline after the container started is skipped for `REMOTE_DECLINE_SKIP_MS` (no loss, no quota), and a row every live machine skips waits as `returned`, with no place.
44. **Blobs and uploads.** Open blob streams are registered and cut on revoke and leave, the hidden test's on untrust; a stream idle for 45 s is cut; one of the three instance streams is kept for lease blobs. One held sync per machine. One staged file per name per attempt, staging capped at min(targetBytes, 64 MiB) + 64 MiB; a machine holds at most half of the upload slots, and an upload body silent for 60 s is ended.
45. **Rows.** `release.ts · orphanLease` ends a lease whose queue row it no longer owns (cause `orphan`, no loss) at boot, on a sync that lists it and at apply. A machine's queue row gets `started_at` when its container starts, so preparation stays off the participant's clock; while its result is scored, `scoring` is true and the clock goes on from the notebook's time. Lease rows keep only the competition's id, limits and baseline ids. Revoked and left machines are pruned after `REMOTE_RUNNERS_KEEP_MS` (30 days) with their events and leases.
46. **The agent.** The GPU smoke test runs on a card with a free share (§4.4). Inspects are retried (250, 750, 2000 ms) before they are believed. The start-up sweep (`docker ps` by the competition-run and instance labels) must succeed before an earlier life's leases are dropped or any sync goes out. Prefetch follows the latest want's order; `/deps/manifest.json` carries no wheel URLs; `runner status` follows home's `compatible` even from a reply its parser refuses; a blob refused with 404 is asked again at the next want that lists it.
47. **Ops.** The plain `docker run` join command carries `--stop-timeout 90` (commands.ts and `colloq-host · runner_code`, byte for byte). The entrypoint exports its container's own `.Config.Image` as `COLLOQ_SERVER_IMAGE` when unset (never a bare id). `runner up`, `runner update` and onstart-runner.sh refuse an image without a runner build (`dist/runner.sha256`) before anything is drained or started and before the image is recorded in `/etc/colloq/runner-image`. The image is pulled first, and by then `runner up` has rewritten `runner.env` (and may have installed the NVIDIA toolkit), and `runner update` has adopted a `docker run` machine's container. `runner update` takes the agent's `homeVersion` only from a sync made since it began (`COLLOQ_RUNNER_FRESH_SEC`, 60 s); `make runners-update` waits up to `RUNNER_SURVEY_SEC` (60 s) for such a sync and counts a machine current only on its `compatible: true`. `runner leave` gives up after `COLLOQ_RUNNER_LEAVE_SILENT_SEC` (600 s) of home silence or `COLLOQ_RUNNER_LEAVE_SEC` (the drain bound + 600 s), restoring the restart policy while the agent keeps leaving, so `make runners-down` destroys the VM and says so instead of hanging. vast.sh and vast-legacy.sh ignore `colloq-runner*` labels and refuse deployment names that would carry them.
48. **`docker kill colloq-runner` is a manual stop** for Docker, so §10.2's row that expects the agent to restart is wrong: `unless-stopped` does not restart it, its sandboxes stay until the next agent start sweeps them, and its leases are lost after `REMOTE_SILENCE_MS`. A crash restarts it, so the rehearsal kills the agent's process inside the container (`kill -9`). `docker start colloq-runner`, or the same `colloq-host runner up`, brings a killed agent back.
49. **Rehearsal on Vast (14 Oct), in two rounds.** Round 1 ran a build from before fix wave 1 with one machine on H's own VM; round 2 ran fix wave 1's build (13d) with a second VM, G (1×4090), added. Overhead ≈ 2.6 s per submission at warm cache (round 1; target ≤ 3 s, §1); a 150 MB blob through relay2 ≈ 16 s (≈ 9.5 MB/s on one stream) with `runnerBlobMBps` uncapped, while its default (`REMOTE_BLOB_MBPS.default`, «Скорость раздачи») is 8 MiB/s for all blobs together and the panel has no field for it; kaggle-base from GHCR ≈ 2.5 min (its size not measured), kaggle-gpu (12.7 GB) from a lab registry with the smoke test ≈ 4 min; 52 submissions drained in 60 s on two machines (round 2, metric lane at 8 slots). The metric lane is the tail of a burst (risk 2): in round 1, 2 slots × 4.6 s stretched a burst of 30 to a last verdict at 96 s; round 2's 52 also had a second machine and a newer build, so the two bursts do not measure the slots alone. Both builds predate fix wave 2 (13e): its effective places (note 41), the machine-only upload door (note 42) and the entrypoint's own `COLLOQ_SERVER_IMAGE` (note 47) were not run on Vast; of the rehearsal's fixes only wave 1's per-event quarantine (note 34) was. The injected failures and how they ended are in docs/pages/en/runners.html#verified.
