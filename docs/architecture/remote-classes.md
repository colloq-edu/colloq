# Classes on machines («занятия на машинах»): design

**Status:** built for 0.25.0, except the council pool (§9), which waits for 0.26.0 (D29). Written 16 Oct 2026 against 0.24.0 (`bc96401`) as the plan the build followed; file:line anchors are against that commit and may have moved. Built in 0.25.0: K0–K6, K8, K9a, K10, K11a, K12 and K13 (§16); K7a–c, K9b, K11b and K12b are 0.26.0. Where the build departed from the plan, a fact a reader relies on (a number, a word, a refusal, a door) is corrected where it stands, and §20 lists every departure by section with its reason. It extends `docs/architecture/remote-runners.md` ("the 0.23 doc"). The owner decisions there (§12) and the implementation notes (§13–13e) stay binding, except where a default below says otherwise.

**Lineage.** The base is the "reuse" design. Everything above `KernelEndpoint` (jupyter.ts:174) stays as it is. Home stays the only Jupyter client and reaches a machine's kernels through a loopback port per placement, piped over one WebSocket the agent dials. Control stays on the 0.23 long-poll `sync`. The agent runs home's own argv and perimeter, split out as pure cores. The council is an epoch loaded into a pool of stock ipykernel workers that run today's `enter → attempt → leave`.

Grafted from "robust":
- kernels ended by failover are detached and never sent `DELETE`;
- restart and interrupt are refused in words while a machine is unreachable, and a restart whose answer was lost is settled by looking at the kernel;
- a pump gate, and `bye{restart}`;
- faster path evidence while classes live;
- a 60 s perimeter re-check that fails closed;
- the run-limit SIGINT retried when the link returns;
- conflict copies;
- tunnel-replacement events and class quarantine;
- one table of words, and «ждать машину» per class;
- the free-name check inside the worker, and the agent's orphan rule;
- a seeded property test of the tunnel.

Grafted from "cost":
- `reconcileAfterReset`;
- resumable streams, built only if K0 finds resets;
- strict lanes, a shallow send buffer, and pacing below the relay's capacity;
- an epoch that is marked stale by the main kernel's history runs and refreshed at the next dispatch;
- a scratch folder and artifacts per attempt;
- package trees that stay on the machine, and «Привезти»;
- `oom_score_adj` for workers, and one `PYTHONHASHSEED` per class;
- a placement score that prefers the class's last machine and short links;
- the teacher's lane, the merged measurement list, and a container label of its own.

Not taken:
- durable spooled streams with the agent as a Jupyter client;
- a container per attempt, or per personal notebook;
- a three-way reconcile with mirror tables;
- a `KernelHost` refactor of pool.ts;
- the fork executor;
- analysing attempt sources at home (the server image has no Python);
- a blob mirror on the relay;
- 45 s or 90 s as the failover default;
- TLS inside the tunnel.

**Words.**
- *Home* is the instance (vsos). It stays the only database writer, the Yjs authority, the files' source of truth and the only Jupyter client.
- A *machine* is a 0.23 «машина» (the same agent `dist/runner.js`, image and join command) whose owner turned on «Принимает занятия».
- A *slot* is one kernel container of a class. Its *role* is `room` (the class notebooks and the shared terminal), `own` (personal notebooks) or `council` (the attempt pool).
- A *placement* is one slot on one machine at one *generation* (`gen`). Every write about it carries the gen.
- The *tunnel* is the one WebSocket a machine dials to home. It carries the bytes of TCP connections that home opens to placements, and nothing else.
- A *link* is home's view of whether one placement can be reached through the tunnel.
- An *epoch* («состояние для попыток») is a frozen, content-addressed snapshot of a notebook kernel's namespace.
- A *worker* is one pool kernel that has loaded an epoch and runs attempts.

New code keeps the `remote` prefix, and the hosts stay «машины» (0.23 decision 9).

## Defaults in force

The owner said not to stop for answers ("decide and go"). Every open question was decided with its recommended answer, and the build follows these defaults. Any of them can be overruled later by number; §19 says what moves.

| # | Default the build follows |
|---|---|
| D1 | One outbound WebSocket per machine, only for machines «Принимает занятия». It carries the bytes of streams home opens and no verbs. Submissions keep the HTTPS long-poll `sync` unchanged. This reverses "a WebSocket control channel — rejected outright" (0.23 §1) for this case only |
| D2 | «Принимает занятия» is a separate per-machine flag: owner-only, off by default, carried by the join code like «доверенная» |
| D3 | A machine with live placements gets no hidden-test leases. The panel refuses both flags together. No override in v1 |
| D4 | Teachers choose per class, among machines the owner opened to classes. An instance switch lets the owner turn this off |
| D5 | A class's machine slots go to one machine when they fit. They spill to a second only when the first is full. Personal kernels use one machine per class |
| D6 | One `own` container per class per machine, with one limit for all, as at home. Per-notebook containers come later |
| D7 | Council: an epoch plus a pool of stock ipykernel workers in one council container, with today's `enter` and `leave` per attempt |
| D8 | The epoch is refreshed when the council opens, on «Обновить состояние», and by itself once the teacher has run a cell since the last one: at the next dispatch, waiting at most 5 s. Each council cell sets refresh to automatic or manual, and every card names its epoch |
| D9 | An attempt that reads a name the epoch could not carry goes to the shared kernel by itself; the worker checks. A sentinel catches indirect access. The console shows the list and a «Попытки считаются: в общем ядре» row |
| D10 | Pool attempts write into a scratch folder of their own, and the class folder is read-only to them. Up to 20 files (1 MB each, 5 MB total) come back as artifacts on the card. Adopt-and-run still writes the shared folder |
| D11 | Council workers use the CPU only. An epoch holding CUDA keeps the council in the shared kernel |
| D12 | The teacher's runs take a lane ahead of student attempts |
| D13 | Failover after 60 s of proven silence on both channels, or after 120 s with only the tunnel down. Path evidence counts for 15 s and home probes itself every 5 s while classes live. Each class may set 30–300 s or «ждать машину». «Перенести сейчас» appears after 10 s without a link. The kernel falls back to this server when it fits |
| D14 | At failover the queue is dropped with the death note. The fate of the running cell is unknown |
| D15 | An attempt lost mid-run is re-run once, on another pool machine or else in the shared kernel. The rerun pause is not charged |
| D16 | Files go eagerly both ways within the caps. Home wins, and the machine's version is kept as a conflict copy. Deletes never come back. Notebook files are home's |
| D17 | Kernel writes coming home are capped at 200 MB per file (a live setting) and the room limit in total. A file over a cap stays «на машине», with «Привезти». Package trees never sync |
| D18 | While classes run on machines: class bulk 4 MiB/s, competition blobs 2 MiB/s, and interactive traffic unthrottled but paced at 6 MiB/s or less on each machine. K0 sets the final numbers |
| D19 | The agent runs with `--network host` from this release. Machines joined by the old command take submissions but no classes until rejoined |
| D20 | A machine on the home's own Docker daemon takes no classes |
| D21 | Home's network mode is the floor on machines. `open` machines and rootless or nftables-only daemons are ineligible, and the panel says why |
| D22 | Only portable revisions run on machines (0.23 decision 3) |
| D23 | Updates during class are allowed. Live containers are adopted, and `bye{restart}` holds failover off for 120 s. `runner leave` asks before moving classes |
| D24 | Classes are admitted before new submissions, with no preemption either way. «Места» caps submissions. No memory is reserved |
| D25 | Idle class kernels on machines stop after `roomIdleMin` (120 min), with an instance override |
| D26 | Docker homes only (vsos, colloq-host VMs). The k8s broker home keeps its Pods |
| D27 | No TLS inside the tunnel (0.23 decision 4) |
| D28 | One `PYTHONHASHSEED` per class, for its room, personal and council containers: the seventh variable, applied at each container's next start |
| D29 | Two releases: 0.25.0 brings rooms, personal notebooks, files, failover and the panel; 0.26.0 brings the council pool. If one release is required, the pool ships with `council: 'shared'` as the default |
| D30 | K0 measures the relay before the tunnel, pacing, failover and help-pad constants are frozen (0.23 decision 7) |
| D31 | Once machines join, vsos's default for new classes is «Консилиум и личные тетради — на машинах, тетрадь класса — здесь». GPU classes use «Всё на машине с картой» |
| D32 | Two silence failovers on one machine within 30 min stop it taking classes until the owner resumes it |
| D33 | «Память на попытку» is 1 GB by default. The per-worker cap is mandatory, and workers carry `oom_score_adj` 1000 |

**As built.** 0.25.0 follows every default except those of the council pool: D7–D12, D15 and D33 wait for 0.26.0, and until then a class's `council` setting is stored (the presets set it) but not drawn in its form (`COUNCIL_POOL`), and its attempts run in today's notebook FIFO, in the notebook's kernel wherever that runs (§20.9). Five defaults read differently in the build. D1: the tunnel stays open for every machine that may take a class, not only one that holds a placement (§20.4). D3: no hidden-test lease goes to a machine with classes on, winding down or holding a live placement, not only to one with live placements (`classesBeside`, §20.6.10). D19: a machine joined by the old command needs no rejoin: a second `colloq-host runner update`, or a Vast VM's next boot, moves its agent onto the host's network (§14 «The move from 0.24», §20.11.6). D21: an `open` machine is not refused; a machine's own mode can only make it stricter than home's, and `open` never applies on a machine (§20.7). D30: K0 ran on 16 Oct and set the numbers of §4.4 and §15 (§20.1).

## 0. The design in one screen

| Decision | Why it is the right size |
|---|---|
| A class's slots are placed one by one, at home or on a machine. A per-class setting picks where (§6.2). The switch is one early branch in `endpointForSession`, after the gates (pool.ts:2136-2143) and before the backend switch (pool.ts:2144) | `JupyterKernel`, the terminal, `OutputWriter`, the guard, `runCouncilOne` and the idle sweep run unchanged against a `KernelEndpoint` that happens to point at a machine |
| Home stays the Jupyter client. The agent dials one multiplexed WebSocket. Home opens a `127.0.0.1:0` listener per placement and pipes every accepted TCP connection, as a stream, to that container's loopback port on the machine. Lanes are strict, the send buffer is shallow, and machines pace below the relay's capacity | jupyter.ts and terminal.ts keep REST and their two WebSockets byte for byte, and the agent parses no Jupyter. The one TCP leg relay2↔vsos that every student shares never builds a queue ahead of a keystroke |
| The link never turns a network problem into a death. Reconnects wait for the link instead of spending the 8-try budget. Failover detaches instead of sending `DELETE`. Restart and interrupt are refused while a machine is unreachable. A reset that ate a reply is settled by `reconcileAfterReset`. Streams resume after a cut (built: K0's cuts lost bytes in flight) | A relay blip costs at most the running cell's output, never the variables |
| Control stays level-triggered on the 0.23 `POST sync`. Intents, file pushes and pulls, epochs, census and post-mortem readings ride one optional `kernels` block. Home pushes by answering a held sync early (`wakeRunner`, wake.ts:55) | A lost reply, a home restart or an agent restart is a delay, by the same mechanics as leases. There is no push RPC |
| The agent starts class containers with home's argv (`roomRunArgs`, a pure core split out of `runArgs`) and home's perimeter (`perimeter-core.ts`). It adds `--pull=never`, Jupyter on 127.0.0.1 only and a `colloq.kind=class-kernel` label, and it adopts the containers after its own restart | The sandbox is the same by construction, held by an argv parity test. Kernels outlive agent restarts and fleet updates |
| Files: home is the truth. A barrier before every run pushes what home wrote; with nothing written it is a counter compare. The machine reports kernel writes after every run and every 5 s while a kernel is busy. Home applies each change by compare-and-swap on the base: when it loses, it keeps a conflict copy, and deletes never come back. Caps apply; package trees and over-cap files stay «на машине» | Home's ~40 synchronous readers (editor, downloads, publishing, the oracle, backups) keep reading home's disk |
| Council (0.26.0): an epoch (pickle 5, out-of-band buffers by content hash, refreshed after the teacher's history runs) is loaded once into a pool of ipykernel workers. Each attempt runs today's enter → attempt → leave in a worker, in a scratch folder of its own. Names that cannot travel send the attempt to today's shared kernel | Attempts run in parallel, independent of the main kernel and its queue. Outputs, ✓/✗, show and adopt keep working through `CouncilJob.onChange` (kernel/council.ts:65) |
| Failover only on proof: 60 s of silence on both channels with path evidence; a revoke, unclass or leave; or «Перенести сейчас». The kernel comes back at home or on another machine without variables, with files as of the last sync | A relay blip, an agent restart or a fleet update never costs the class its variables |
| Trust is a separate flag, off by default. A class machine gets no hidden test | A class machine sees everything its classes have (§12) |

**Cost.** About 9.6k LOC plus about 6k LOC of tests, in 22 phases over 7 waves of parallel agents with disjoint files (§16). The resume layer (K3b, 0.4k) was built: K0 said so (§20.1). Two releases (D29): 0.25.0 is useful on its own, and 0.26.0 adds the pool on top without touching what came before.

**vsos (8 vCPU, 16 GB).** The default for its new classes is «Консилиум и личные тетради — на машинах, тетрадь класса — здесь» (D31). The lecture keeps its latency, and the per-student load (thirty personal kernels, thirty parallel attempts) leaves vsos. As built, the preset is the owner's «Новые занятия по умолчанию» (the code's own default stays «Всё здесь», §6.2), and its tile reads «Личные тетради — на машинах» in 0.25.0: the personal kernels leave vsos now, the parallel attempts with 0.26.0.

## 1. Goal, acceptance, non-goals

**Goal.** A teacher picks, per class, where it computes. Putting compute on machines covers:
- the class notebooks' kernels, with output, interrupt, restart, help, the terminal and file runs;
- personal notebooks;
- council attempts, which run in parallel and independently of the notebook's kernel and its queue (0.26.0, D29; in 0.25.0 they run in the notebook's kernel, §20.9).

Around that:
- files go both ways, with home as the source of truth;
- a lost machine fails over automatically;
- all of it shows in «Работают сейчас», in «Машины» and in the console;
- machines join with the same agent, image and one command as in 0.23.

**Acceptance.** Measured in the rehearsals R1 and R2 (§17.5). These are targets: K0 measured the relay on 16 Oct (§20.1), R1 holds 0.25.0 to every row but the council's, and R2 the council's.

| Area | Target (EU machine, home behind relay2) |
|---|---|
| Cells | `print(1)`, click to visible: at most +150 ms at p50 and +400 ms at p95 over the same class at home |
| Help | Completion under 1 s at p95, inside its 2.5 s budget (`SHELL_REQUEST_MS`, jupyter.ts:130). The value line answers within its wait plus the pad at least 95 % of the time |
| Interrupt and limit | KeyboardInterrupt is visible within 300 ms at p95. A run-limit SIGINT lands within 1 s of the limit |
| Terminal | `echo hi` shows its output within 300 ms at p95 |
| Files | A Run after no file change pays 0 extra round trips; after a 10 KB edit, at most 400 ms. A 150 MB upload is readable by the next cell within 25 s. A 1 MB `to_csv` reaches the files panel within 2 s of the cell's end |
| Council (0.26.0, R2) | 30 attempts of about 2 s each, pressed within 10 s, all finish within 20 s on 8 workers; today one FIFO takes over 60 s. Per-attempt overhead is at most 1 s at p95. The notebook's queue never holds a pool attempt |
| Failover | After `vastai destroy` the chip turns amber within 30 s, and a kernel is usable at home within 75 s plus its start time. Nothing written before the last sync is lost |
| Survival | An agent `kill -9`, a `runner update` and a home restart lose no variable |
| Shared leg | The class's collaboration RTT at p95 stays within 50 ms of its baseline during a 150 MB sync and during a 30-attempt burst (the 0.23 rule). Classes on machines add at most 300 MB per class-hour on the vsos leg, datasets excluded |

**Non-goals for v1.**
- A k8s or broker home (D26).
- GPU council workers (D11).
- A council pool at home. It is deferred, not rejected: the pool does not care where its container is.
- Per-notebook personal containers (D6).
- Persistent per-student kernels for the council. Attempts stay stateless, as today; a notebook per student is what personal notebooks are.
- Moving live variables between machines, or rebalancing a running class.
- Spreading one class's personal kernels over machines.
- Signing or TLS-PSK (D27).
- Teacher-built environments on machines (D22).
- One machine serving two homes; agent self-update; a blob mirror on the relay; pipelining Run All.

**What becomes of the 0.23 lists.**
- "Push RPC into runners" stays rejected: control is still the level-triggered sync.
- "A WebSocket control channel" is reversed only as a byte tunnel with no verbs (D1).
- "A shared filesystem" stays rejected: files travel as copies plus sync.
- The non-goal "re-attaching after an agent restart" is reversed for placements only (adoption). Leases keep the 0.23 rule.

## 2. What is reused

| Piece (anchor) | Use |
|---|---|
| `KernelEndpoint` and `endpointIdentity` (jupyter.ts:174-184) | Gain the optional fields `link` and `identity` (§4.5). Together with §5's small edits, that is all jupyter.ts changes |
| `JupyterKernel`: sessions by path, `releaseOrphanedWork`, reconnect, and the jupyter_server buffering it relies on (jupyter.ts:1038-1041) | As is. A home restart re-attaches to machine kernels by session path |
| The broker vocabulary in shared/runtime.ts (`RuntimeEnsureRequest`, `RuntimeEndpoint`, `RuntimeResizeResult`, `RuntimeStartFailure`) | Intents and reports are built from these types. The echo check (runtime-client.ts:187-196) becomes `checkRuntimeEndpoint()` and serves both clients |
| 0.23 identity, codes, `cr1`, marker header, 426, `Backoff`, `relayState`, build compatibility, quarantine, events, panel, fleet commands | As is. Machines and codes gain `classes` |
| `sync` with `waitForNews`/`wakeRunner`, `holding`, `RECOMPUTE_MS` (routes.ts:309-324) | As is, plus the optional `kernels` block. A machine with placements is held at most `REMOTE_HOLD_BUSY_MS` (10 s) |
| heard.ts `pathEvidence`, `provenSilence`, `inBootGrace`, `noteCall` (:248/281/226/95); liveness.ts `remoteTick` (:74) | As is, with class thresholds. Tunnel frames count as calls |
| `serveBlob` (Range, the 45 s stall cut, `cutBlobStreams`, blobs.ts:276-338); `receiveUpload` (gzip, declared sha and bytes, caps after decompression, staging, 503/507, `machineShare`, upload.ts:120-217) | Two new blob sources (`room`, `epoch`) and three new upload doors (§15). The bucket is split by flow (§4.9) |
| Agent `Cache.blob`, `HashBook`, `writeWhole`, `Images.want`, `freeCapacity({holding})` (machine.ts:131), the card probe, `Docker` | As is. Placements join `holding()` (sync.ts:1496) |
| `runArgs` (pool.ts:1152-1325), `roomHardeningArgs`, the perimeter builders, `CGROUP_SCRIPT`, `killedByMemory` | Moved into pure cores the agent may import. Home's functions become thin wrappers |
| `treeDelta`, `TEMP_FILE` and `sweepStaleUploads`, `createAnchoredFilesystem` (secure-files.ts:85), the shared/paths rules, `isBookFile`, the `onWorkspaceChanged` hooks (control.ts:1385), `watchDisk` | As is. A machine's change lands on home's disk as a temp file plus a rename, and the existing hooks fire |
| council-isolation `_plan` (:613), `_snapshot` (:890), `enter` (:1317), `leave` (:1259), `_memory_cap` (:801), `_arm_memory` (:847) | `_plan` classifies the epoch. `export`, `load` and `_colloq_needs` join the same hidden module, and `_memory_cap` gains a cap that workers must pass |
| `runCouncilOne` (index.ts:4411), `CouncilOutputBuffer`, `recordRun`, `RunLimit`, `retimeCouncilRun`, `ensureGuard`, `pump` | As is. A worker is an ordinary hidden `Runtime` whose queue holds at most one attempt |
| Tests: the remote-e2e `Home`, `Agent` and `Fleet`, the `fakeHome` violations, kernel.test.mts's fake Jupyter, `drive()` (council-isolation.test.mts:278-310) | Extended (§17) |

## 3. Architecture

```
 browsers ──wss──► relay2: Caddy :443 (TLS ends) → frps ══ one TCP (yamux) ══ frpc ──► home = vsos (node :3000)
                                                                                     │ Yjs, SQLite, files (truth), OutputWriter
                                                                                     │ JupyterKernel / terminal (unchanged above KernelEndpoint)
                                                                                     │ remote_placements · council_epochs · council_artifacts
                                                                                     │ 127.0.0.1:P1, P2, …  one listener per placement
                                                                                     │      └ accepted TCP → tunnel stream
                                                                                     │ /api/runners/v1/tunnel   one WebSocket per machine, bytes only
                                                                                     │ /api/runners/v1/sync     control: the 0.23 path + the kernels block
                                                                                     │ GET blobs/<sha> · PUT rooms/…/files · PUT epochs/<sha> · PUT council/…/files
 machine (Vast VM, university server) ── dials out through relay2 ───────────────────┘
   colloq-runner (agent, --network host): sync loop · tunnel · kernel host · room files · CAS
     ├─ colloq-class-<i6>-<id>-room     class notebooks + terminal; -p 127.0.0.1:0:8888; perimeter; whole card if GPU
     ├─ colloq-class-<i6>-<id>-own      personal kernels; no card
     ├─ colloq-class-<i6>-<id>-council  (0.26.0) N worker kernels; class folder :ro, epochs :ro, scratch :rw; no card
     └─ submission sandboxes (0.23, unchanged)
   /var/lib/colloq-runner/rooms/<id>/                 the class folder copy (uid 1000, 2775), shared by the class's containers
   /var/lib/colloq-runner/council/<id>/{epochs,scratch}/   (0.26.0)
```

`<i6>` is six hex characters of the agent's `INSTANCE_LABEL` (images.ts:113). Machine containers carry `colloq.kind=class-kernel`, so home's census, which looks only for `room-kernel` (pool.ts:652-661), can never see them.

**The life of a placement**
1. A teacher sets the class to «На машинах». Its environment revision joins the `want` of every machine that accepts classes, so the image is pulled before the bell.
2. The first participant opens the room (a warm start, §6.8), or someone presses Run. `ensureKernel` (index.ts:1481) calls `endpointForSession(id, env, role)`, which calls `MachineKernels.ensure()`. That chooses machine M, writes a `remote_placements` row (gen g, `starting`) and wakes M.
3. M's held sync answers with the intent: revision, limits, token, network floor, hash seed, gen. A full files push for the class folder rides in the same reply.
4. The agent installs the perimeter, runs `docker run` with `roomRunArgs` + `--pull=never`, probes `/api/status` with the token, applies the push, and reports `ready` with the container id.
5. Home checks the echoes (environment, revision digest, gen), as `RuntimeClient.ensure` does. It opens `127.0.0.1:P` and returns the endpoint.
6. `JupyterKernel.connect` posts `/api/sessions` through the tunnel. `releaseOrphanedWork` and `ensureGuard` follow, and the chip turns idle.

**The life of a cell on a machine**
1. `runOne` (index.ts:3213) runs `flushToDisk`, then `await filesBarrier()`. With nothing written at home, this is a counter compare and no round trip.
2. `ensureGuard` and `beginLimit`.
3. `execute` travels over the channels WebSocket: `127.0.0.1:P` → a tunnel stream (interactive lane) → relay2 → the agent → `127.0.0.1:<port>` on M → the kernel.
4. Output comes back the same way into the unchanged `OutputWriter`.
5. `notifyWorkspaceChanged` asks M for a scan. The report, the pull and the apply follow, and the tree delta reaches the browsers.

**The life of an attempt (0.26.0)**
1. `council:run` reaches `requestCouncilRun` (index.ts:3824). It keeps its rules (dedupe, replace in place, one in flight per person, the rerun pause). Its first new line picks the pool queue when the cell's attempts run on machines; otherwise today's FIFO.
2. `assign(pool)` checks the epoch first. If the teacher has run a cell since the export and the cell's refresh is automatic, it asks for a refreeze and waits at most 5 s. It then hands the head attempt (teacher lane first) to an idle worker of the newest ready epoch.
3. The worker's pump runs today's `runCouncilOne`:
   - the barrier and `beginLimit`;
   - `enter`: personal copies, the free-name check, the scratch folder, the memory cap;
   - the attempt, with `storeHistory: false`;
   - `leave`: restore, and list the scratch files;
   - `finishCouncil` → `CouncilJob.onChange`.
4. If `enter` reports that the attempt reads a name the epoch left behind, the worker leaves and the job moves to the notebook's FIFO, keeping its place.
5. Afterwards the pool applies its recycling rules, and the agent uploads the attempt's artifacts.
6. Frames reach `recordRun`, the store and the fan-out every 400 ms (`COUNCIL_REPORT_MS`), unchanged.

## 4. The tunnel

### 4.1 Why one byte tunnel
- Home already speaks complete Jupyter: REST, kernel channels and terminado. Carrying TCP bytes keeps all of it byte for byte, including keep-alive, upgrades, the token header and the iopub buffering `JupyterKernel` relies on across reconnects.
- The only HTTP-capable path from a machine to home is HTTPS through Caddy, frps and frpc. A WebSocket is the one long-lived bidirectional thing that path already carries: every student's sockets ride it.
- One tunnel holds one frp work connection, against the 60–90 browser sockets a class already holds. So `poolCount 5` (entrypoint.sh:509) and `maxPoolCount 10` (relay-setup.sh:343) are no new constraint; K0 counts the "pool is full" lines anyway.

### 4.2 The door
- **The handler.** `GET /api/runners/v1/tunnel` with Upgrade. It lives in `server/src/upgrade.ts · handleUpgrade`: the body of the upgrade handler moves there unchanged from index.ts:234, so the e2e `Home` can attach it. The tunnel path is matched first, before the browser `originAllowed` rule.
- **Credentials.**
  - Only `Authorization: Bearer cr1.<id>.<secret>`, in a header, so no browser can present it; checked by `parseRemoteAuthorization` → `authenticateRunner` (store.ts:404).
  - The machine must be `active` or `draining` and have `classes = 1`, and it may upgrade at most 12 times a minute from one address (`TUNNEL_UPGRADES`, counted per machine and address).
  - As built, neither the build nor the class quarantine is checked at the door or at the HELLO: both keep only new placements away (§6.3), and the tunnel goes on serving the placements an outdated or quarantined machine holds. Refusing it would fail those classes over once the tunnel is stuck (§11.1).
  - The request carries `X-Colloq-Tunnel-Protocol: 1`.
- **Refusals.** Before the upgrade, as marked JSON: 401 (bad credentials, counted in `callCounts.unauthorized`), 403 `forbidden` (classes off), 426 (another tunnel protocol, and any `/api/runners/v<n>/tunnel` of another version) or 429; this server's own failure answers a marked 500 `failed` (`TUNNEL_REFUSALS`). The browser doors keep refusing `cr1` (socket-authorization.ts:63), and this door refuses everything else.
- **An open tunnel is checked again** at most every `TUNNEL_PING_MS` while frames arrive: a revoked machine is closed with 4401, classes off with 4403; a quarantine changes nothing. Home's own internal failure closes with 1011 (`TUNNEL_INTERNAL_CLOSE`, outside `TUNNEL_CLOSE`).
- **One tunnel per machine.** A newer tunnel closes the older one with code 4409, at its HELLO rather than its upgrade, so a socket that never greets displaces nothing.
  - A replacement writes a `remote_events` row, `tunnel_replaced`, with both addresses (`address` the newer tunnel's, `detail` the replaced one's). A takeover from another address is always written; a machine replacing itself from its own address (a cut its old socket has not noticed yet) at most `TUNNEL_SELF_REPLACEMENTS_LOGGED` (6) times an hour.
  - More than 3 replacements from different addresses within 10 min raise an owner banner: a stolen secret looks exactly like that. The count is read from the event log (`tunnelReplacementAlert`), so a home restart forgets none.
- **WebSocket options.** No permessage-deflate (outputs are mostly images and JSON), `maxPayload` 64 KiB, and TCP_NODELAY at both ends; a test asserts the last one.

### 4.3 Frames
Each binary message is one frame:
```
u8  kind    HELLO · WELCOME · OPEN · OPENED · REFUSED · DATA · ACK · END · RESET · PING · PONG
u8  flags   bit0 FIN
u8  lane    0 control · 1 interactive (room, own) · 2 council
u8  reserved
u32 stream  0 = the tunnel itself; only home opens streams
u64 offset  DATA: offset of the payload in the stream · ACK: cumulative bytes delivered
payload     DATA ≤ 16 KiB · JSON ≤ 4 KiB for HELLO, WELCOME, OPEN, REFUSED
```
- **OPEN** goes from home to the agent: `{key: "<session>:<role>", gen}`. The answer is OPENED, or REFUSED `{code: 'gone' | 'stale' | 'starting'}`. An OPEN from the agent is a protocol violation and closes the tunnel, and so is an OPEN whose lane is not its role's (`tunnelLaneOf`). A stream's last DATA frame carries FIN when its end is already known; otherwise an END follows.
- **HELLO and WELCOME** open a tunnel session: `{protocol, build, session}`, where `session` is random per agent life. They carry `resume` (K3b was built, §4.8). The 101 answer carries the marker header; the agent takes a 101 without it for a hiccup.
- No verb rides the tunnel. Placements, files and epochs are the sync's business.

### 4.4 Lanes, windows, pacing
- **Lanes.** Strict priority: control, then interactive, then council. Within a lane, streams take deficit round-robin turns of 16 KiB, so a 6 MiB figure from one kernel interleaves with another kernel's `print`.
- **A shallow socket.** A frame goes to the WebSocket only while `bufferedAmount` ≤ 64 KiB (`TUNNEL_SEND_LOWAT`). Everything else waits in per-stream queues, where the lanes still apply. An interactive frame waits at most about 7 ms (64 KiB at 9.5 MB/s) plus one frame.
- **Windows.**
  - A sender may be at most `TUNNEL_WINDOW` bytes past the peer's ACKed offset: 4 MiB per interactive stream, 1 MiB per council stream, 16 MiB per machine in all (K0 raised the first two from 1 MiB and 512 KiB: one stream through relay2 was window-bound at 2.6 MiB/s, and a 2 MB figure must fit one window). The council lane may hold at most `TUNNEL_COUNCIL_SHARE` of the machine's window (12 MiB), so a full council lane never keeps the room's lane a round trip behind.
  - Receivers ACK every 50 ms or 64 KiB, as their local socket drains.
  - A sender out of window stops reading its source socket. A flooding cell is then held in jupyter_server's buffers and behind its iopub rate limit, never in home's memory.
- **Pacing on the machine.** Lanes 1–2 from machine to home pass a token bucket at `machinePaceMBps` (6 MiB/s) with a 2 MiB burst. One figure is never delayed, and thirty attempts' plots cannot fill the shared leg.
- **Limits.** Bulk bytes never ride the tunnel: files and epochs travel by their own HTTP requests, paced as in §4.9. At most 512 streams per tunnel.

### 4.5 Home's end: listeners, endpoints, the link
New module `server/src/kernel/remote/tunnel.ts`.
- **Listeners.** One `net.createServer` on `127.0.0.1:0` per placement while it is `ready` or `unreachable`. Each accepted socket becomes an OPEN on the machine's tunnel. While the tunnel is down, new sockets are destroyed at once: a fast `ECONNRESET` instead of a hang, which `confirmAlive` (jupyter.ts · confirmAlive) reads as alive.
- **The endpoint.**
  ```ts
  { url: 'http://127.0.0.1:<P>', token, instanceId: `${runner}:${container}:${gen}`,
    identity: `machine:${runner}:${container}:${gen}`, link }
  ```
  The URL is an origin root: undici pools connections per origin, so placements never share keep-alive. `endpointIdentity` (jupyter.ts:182) returns `identity` when it is present. Because it is URL-independent, the terminal's remembered pty (terminal.ts:322-337) survives the new port a home restart brings.
- **The link.** `KernelLink { up; rttMs; since; next(timeoutMs): Promise<'up' | 'lost' | 'timeout'> }`, one per placement gen, read off its machine's tunnel. RTT is an EWMA of the PONGs, and the p95 over 5 min feeds the chooser, the help pads and the panel.

### 4.6 The agent's end
New module `server/src/runner-agent/tunnel.ts`.
- **Dialling.** It dials `wss://<home>/api/runners/v1/tunnel` while the sync reply says `kernels.tunnel: 'open'` (or `'reconnect'`, home holding no tunnel of it up). As built, home says so while the machine holds any placement and, holding none, while it may take a class (standing, `active`, classes on, not trusted, home's build): eligibility needs the tunnel up and its RTT (§6.3), so a machine that dialled only once placed could never take its first class (§20.4). The agent loads the tunnel module on the first reply that asks for one.
- **`reconnect` is no order to cut.** On `reconnect` the agent drops its tunnel only after 10 s without hearing home on it, so a reply written during a stall and delivered after it cannot cut a tunnel that works again.
- **Reconnects and proxies.** It honours `HTTPS_PROXY` (`installOutboundProxy`). Backoff runs 0.5→5 s for five tries, then the 0.23 `Backoff` (1–30 s), with `relayState` to tell "home offline" from "refused". A refusal (a marked 401, 403 or 426, or a close with 4400, 4401, 4403, 4409 or 4426) goes straight to the 1–30 s backoff, and `Retry-After` sets the least wait; the relay is asked on the first failure and every fifth, for the log only.
- **Whose close ends the streams.** A close with home's own codes (1011 and every `TUNNEL_CLOSE` code, `HOME_ENDS`) ends the agent's side of every stream at once, so jupyter_server starts buffering for the replay; 1001 (Caddy on the relay sends it at a reload) and any other close are a cut the streams resume after (§4.8).
- **Streams.** For `OPEN(key, gen)` it looks up its own placement record. A stale gen gets `REFUSED stale`. Otherwise it connects TCP to `127.0.0.1:<port>`, the port it read with `docker port <c> 8888/tcp`; a Jupyter it cannot connect to gets `REFUSED starting`. Home never names a host or a port, so nothing else on the machine is reachable.

### 4.7 Liveness
- Each side sends PING every 10 s (`TUNNEL_PING_MS`). The relay cuts idle connections at 30 s, and y-websocket's 30 s lesson applies. As run (K0, §20.1.2): relay2 kept tunnels and sockets through 20, 40 and 70 s of silence with no pings; the 10 s PING stays for the probe, the quiet mark and the dead timer.
- After 6 s without a frame (`TUNNEL_PROBE_MS`) an end sends an extra PING at once, and after 12 s (`TUNNEL_QUIET_MS`) it is *quiet* until the next frame: home's `isUp` is false and `since` is the last frame heard, so a black-holed path turns the room's chip amber at 12 s, long before the dead timer (SB, §17.2 B.4).
- After 25 s without any frame (`TUNNEL_DEAD_MS`) a side terminates the socket, with no close handshake on a dead link; with K3b that is a cut, and the streams wait for the next socket.
- Every frame home receives counts as `noteCall(runnerId)`, so path evidence sees tunnels as well as syncs.
- A tunnel down while syncs keep arriving means *alive but unreachable*. Home replies `tunnel: 'reconnect'` and fails over only after 120 s (§11.1).

### 4.8 Resumable streams (K3b: built, K0 asked for it)
- **The rule.** Build K3b if K0 sees tunnel resets more often than once per class-hour on the EU path, or output lost in its 10 s and 60 s cuts. Otherwise §5.5 alone settles what a reset eats. K0's 60 s cut reset the tunnel and lost about 50 KB in flight each way, and a relay restart cuts every tunnel at once, so K3b was built in wave 2; its wire details are §20.3.
- **Retention.** Senders keep unACKed bytes for 120 s (`TUNNEL_RESUME_MS`), at most 4 MiB per stream (`TUNNEL_RETAIN_BYTES`).
- **Resume.** After a reconnect, HELLO carries `resume: [{stream, rx}]` and WELCOME answers `{resumed, streams: [{stream, rx}]}`. Each side resends from the peer's `rx`.
- **The inner sockets** (`JupyterKernel`'s at home, the agent's to Jupyter) stay open through the cut. The kernel just looks quiet for its length. As written into the parity job (K13, §17.3): a resume keeps the bytes but not a socket that jupyter_server closes by itself — its kernel WebSocket pings, and a cut longer than its ping timeout (about 90–120 s) closes the inner channel at the machine's end; that stream then resets, and §5.5 settles what it carried.
- **When resume is impossible** (a new agent or home life, a retention overflow, more than 120 s), the stream resets and §5.5 settles what it ate.
- **The test.** A seeded property test (random cuts, black holes, reconnects and agent restarts) requires every stream to deliver exactly the bytes sent, once and in order, or to reset.

### 4.9 Relay numbers and rates (D18)
- **Bandwidth and latency.** About 9.5 MB/s on one stream through relay2 (0.23 rehearsal, note 49). RTT home↔machine is RTT(relay2↔vsos) + RTT(relay2↔machine): about 53 ms for an EU machine and 133 ms for a US one (estimates; K0 measures). As run (K0, §20.1.2), on an EU path crossing relay2 twice: tunnel echo p50 91 ms, p95 317, p99 377; one tunnel stream moved 2.6 MiB/s machine → home with a 1 MiB window (window-bound) and 9.3 MiB/s home → machine; a plain HTTP GET moved 35 MiB/s on one stream and a PUT 21.5.
- **What crosses twice.** Room output goes machine → relay2 → home → relay2 → browsers. A class averages about 25 KB/s, and a burst of 30 attempts with plots is at most 60 MB.
- **TLS** ends on relay2 for the tunnel exactly as it does for students' browsers (D27).

Everything shares the one TCP leg relay2↔vsos, so bulk is paced below its capacity:

| Flow | Direction | While any class is live on a machine | Otherwise |
|---|---|---|---|
| Class blobs (pushes, epochs) | home → machine | 4 MiB/s (`classBulkMBps`). A push a Run waits on is promoted to 8 MiB/s | 8 MiB/s |
| Class uploads (kernel writes, epochs, artifacts) | machine → home | 4 MiB/s: the agent paces at the rate the reply names, and home reads through the same bucket | 8 MiB/s |
| Competition blobs | home → machine | 2 MiB/s («Раздача посылок во время занятий») | «Скорость раздачи» (8) |
| Tunnel: interactive and council | both | unthrottled at home; at most 6 MiB/s with a 2 MiB burst from each machine | same |

The 4 MiB/s and the barrier's 8 MiB/s are first numbers: R1 checks the collaboration rule during a 150 MB sync, and K0 may lower them. K0 kept them, on one condition: pacing must be smooth, never per-second bursts (unpaced uploads made a 2 MB figure take 2.5 s). As built (§20.8), every bucket refills continuously with a burst of at most 256 KiB (`CLASS_PACE_BURST_BYTES`), and there is one bucket per flow for all machines together (blobs.ts: `competitionPace`, `roomPace`, `promotedPace`, `classUploadPace`), the agent pacing its own uploads at the reply's `classBulkMBps` besides; the owner's numbers are «Файлы занятий» and «Раздача посылок во время занятий» (`ClassMachineSettings`). The promoted push runs at `max(classBulkMBps, 8)`.

### 4.10 Rejected
- **The agent as the Jupyter client, relaying execute events.** A second protocol for execute, iopub, stdin, interrupt, restart, terminado, the guard and the council reports: duplicate semantics on two builds.
- **Durable spooled streams with write-ahead.** About 2.1k LOC that duplicate jupyter_server's own buffering.
- **frp TCP proxies per room.** They need `RELAY_TOKEN` on machines.
- **Home dialling machines.** Machines sit behind NAT.
- **HTTP/2.** frps speaks HTTP/1.1 to the backend.
- **One path-prefix listener.** Viable (`channelsUrl` keeps the path, jupyter.ts:929-937), but it shares one undici pool, and per-placement ports cost nothing.
- **TLS-PSK inside the tunnel.** Rejected by D27.

## 5. Home's kernel client over a link

These are the only behavioural changes below `KernelEndpoint`. Each one closes a path by which a network problem would otherwise become a death, a duplicate or a hang.

### 5.1 Reconnects wait for the link
- `scheduleReconnect`/`reconnect` (jupyter.ts:1042-1077) count no attempts while `link.up` is false. They await `link.next()`, and `'up'` reconnects.
- `waitForSocket` (jupyter.ts:1079) extends its 45 s deadline (`SOCKET_WAIT_MS`) while the link is down.
- terminal.ts's `scheduleReconnect` (:1435) gets the same two edits.

An outage therefore never spends the 8-try budget (`RECONNECT_MAX_ATTEMPTS`, :113), never declares a death, and never reaches `dispose()`.

### 5.2 Ending a kernel from outside
- **The method.** New `JupyterKernel.endFromOutside(cause: 'lost' | 'fenced', words)`, about 25 lines. It aborts pending work, stops reconnecting, sets the phase `dead` (unexpected) and records `endedBy = {cause, words}`. It sends no `DELETE`.
- **Detach, not dispose.** `ensureKernel` (index.ts:1547-1553) calls the existing `detach()` (jupyter.ts:867) instead of `dispose()` (whose `DELETE` is at :912-918) when `endedBy` is set. Otherwise that `DELETE` could reach whatever listens on a reused ephemeral port.
- **The words.** `onPhase` (index.ts:1337) writes `endedBy.words` instead of the generic death note. The existing unexpected-death branch drops the queue.

### 5.3 The pump gate
`pump` (index.ts:3147) awaits `placementGate(runtime)` before `ensureKernel` (:3181).
- It resolves at once at home and for a reachable placement.
- While the placement is unreachable it waits; after 10 s the waiting cell reads «Нет связи с машиной «vast-3» · 0:12…».
- On failover it rejects, and the queue drops with the failover note.
- Under «ждать машину» it waits until the machine returns or someone presses «Перенести сейчас».

Without the gate, a Run during an outage would fail `POST /api/sessions` after 60 s.

### 5.4 Restart and interrupt while unreachable
- **Refused in words.** `restartSession` (index.ts:1728) and the interrupt path refuse for an unreachable placement, and say so to the person who pressed. As built, the kernel client refuses too: `restart()` on a link endpoint throws while the link is down and touches nothing; interrupt is refused only while a cell computes (a press with nothing running still clears the queue).
- **A restart whose answer is lost** (a reset mid-request) becomes `RestartUnknown`. Today a non-OK answer turns the kernel `dead` (jupyter.ts:845-848), and a thrown request ends in `restartSession`'s catch, which marks the room `dead` (index.ts:1763-1770). For machine endpoints the phase stays `restarting` (expected) instead, and the room reads «Перезапуск отправлен, ответа нет…».
- **Settled by looking.** When the link returns, one silent execute evaluates the guard's report expression:
  - an error (the guard module is not loaded) means a fresh process: the restart happened (`resetAllCells`, «Ядро перезапущено»);
  - a report means the old process lives: the status goes back, and the room reads «Перезапуск не дошёл…».

  A failover settles the question otherwise.
- **As built, by the process, not the guard** (`settleRestart`, K3c): the guard can be installed into a fresh process before anyone looks, so its report proves nothing. A kernel process is recognised by the id ipykernel stamps on its replies (`header.session`, drawn once per process): one `kernel_info_request` after the link returns, and another process than the one the restart was sent to means the restart happened («Перезапуск прошёл: переменные сброшены.»), the same one that it missed («Перезапуск не дошёл — переменные на месте.»), even busy and silent; no process heard before the restart counts as happened; a kernel that never answers throws `RestartUnknown` again. The parity job pins `header.session` on the real jupyter_server (§17.3). A restart that can never be settled is let go of with no `DELETE`, and the room gets the existing "did not come back" note.

### 5.5 `reconcileAfterReset()`
After any reconnect that followed a reset (not a resume). As built (K3c), it runs after every reconnect of a link endpoint: one `kernel_info_request` whenever the kernel's process id is known, and a reply from another process is handled as a `restarting` status heard live (pending work aborted, the phase restarting-unexpected, the comeback awaited). Jupyter saying busy is asked again, up to 20 rounds; only executions that were out at the cut and have no reply are settled, and a 60 s silence (a cell still computing) settles nothing:
1. The kernel sends one `kernel_info_request` on the shell channel and waits for its reply. jupyter_server answers it after replaying what it buffered for the session; the Linux parity job pins this ordering on the real server (§17.3). Resumed streams never need it (§4.8), but a cut past jupyter_server's own ping timeout closes the channel there, and the reconnect that follows is this case.
2. Then one `GET /api/kernels/:id`. If `execution_state` is `idle` while executes are still pending, they are settled as lost: «Связь с машиной прервалась — результат ячейки потерян…». The cell ends `error`, and the queue moves on.

About 30 LOC. It closes the "cell running forever" hole that a lost `execute_reply` would open, because the watchdog only detects 404 (jupyter.ts:779-793). It helps the broker path too.

### 5.6 Help budgets
- `inspectIn`, `briefIn` (`BRIEF_WAIT_MS` 400, index.ts:5138), `completeIn` and `moduleFacts` add `min(1000, 2 × rtt p95)` for machine placements, so jedi help does not time out on distance alone.
- `liveKernel` (index.ts:4926) returns null while the placement is unreachable, and hovers say «машина не отвечает». As built, the answer carries a flag (`InspectAnswer.unreachable`, with reason `busy`) rather than a new `InspectMiss` value, which older tabs would show as "undefined"; the editor reads «Нет связи с машиной ядра — справка появится, когда она ответит» (`room.signature.unreachable`) and asks again as for a busy kernel. Help is refused at once while the road is down. On the test backend `completeIn` answers its canned list only when no kernel is live, as `inspectIn` does.

### 5.7 Terminal
- The re-resolve at terminal.ts:1472 runs for `kernelBackend() === 'broker' || term.endpoint.link`. A new identity gives the existing «ядро класса заменено».
- For machine rooms, quiet detection adds `min(600 ms, 2 × jitter p95)`, so a jittery link does not end a command early (`quietPadMs`; the link's average RTT stands in as an upper bound until a p95 is injected through `useLinkJitter`). A machine shell's command cut mid-run is probed once the road is back.
- **The prime rule** (F3): a terminal socket's first frames never end a prime before its greeting went, and the prime's deadline is reset when each socket opens. Through the tunnel the handshake's answer and the first frames nearly always arrive in one read; taken for the end of a prime not yet begun, they let queued commands reach the shell before its greeting, whose prime then swallowed their output (scenario A failed one run in six).

### 5.8 The run-limit SIGINT retry
A limit signal that cannot reach the kernel (via `stopRunningItem`, index.ts:4011) marks the limit `pending`. When the link returns and the same item is still running, the signal goes again. `beforeNext` still keeps the next item from starting before it settles.

## 6. Placement

### 6.1 Roles and slots
`KernelRole` (pool.ts:81) widens to `'room' | 'own' | 'council'`, and `slotFor` gives `<id>#council`. pool.ts's Docker branch refuses `council` («пул консилиума бывает только на машинах»).

| Role | Holds | Container on the machine | GPU |
|---|---|---|---|
| `room` | every class notebook's kernel (one Jupyter session per notebook, as today) and the shared terminal | `colloq-class-<i6>-<id>-room`, pids `roomPids` (512) | a whole card if the environment needs one |
| `own` | every personal kernel of the class (≤ `ownMax`, 60) | `-own`, pids `ownPids` (2048), `ownLimits` (pool.ts:167) | never (pool.ts:1203) |
| `council` | N worker kernels, one Jupyter session each (`session-<root>~w<n>.ipynb`) | `-council`, own's profile; class folder `:ro`, epochs `:ro`, scratch `:rw` | none in v1 (D11) |

### 6.2 The per-class setting
- **Storage.** A new column, `sessions.placement` (JSON, through `ensureColumn`, next to `memory_mb` and `cpus` at db.ts:476/488):
  ```json
  {"room": "home|machines", "own": "home|machines", "council": "shared|machines",
   "fallback": true, "failover": "auto|wait", "failoverSec": 60, "workers": "auto|n", "attemptMb": 1024}
  ```
- **Who sets it.** Staff, in the class's «Ресурсы», among machines the owner opened to classes, while the owner's instance switch «Учителя отправляют занятия на машины» is on (D4, on by default). As built: the class's teachers while the switch is on and the owner always; anyone else's change is refused with `server.onlyTheOwnerDecidesWhereClassesCompute.5ef976`, and a teacher kept out sees the form greyed with «Где считать занятия, сейчас решает владелец…». The setting is the seminar PATCH's `placement` (checked field by field, an unknown field refused, before any other field of the request is written). Under the broker the seminar view leaves `placement` out and the PATCH refuses a change with 400 (D26). A change re-tells staff their `kernel:machine` frames (`kernelMachinesChanged`), so «Ждать машину» pressed in one tab reaches every other.
- **Defaults.** Everything at home, so nothing changes for anyone who does nothing. The owner may pick another default for new classes; vsos uses D31's preset. As built, that is the owner's «Новые занятия по умолчанию» (`ClassMachineSettings.newClasses`, «Всё здесь» by default), applied as a class is created through a hook in db.ts (`useNewClassPlacement`: db.ts cannot import the settings), and a GPU class takes «Всё на машине с картой» under any preset but «Всё здесь». A class whose row holds no setting reads everything here with the owner's «Переезд через» (`placementDefaults`).
- **Presets:** «Всё здесь», «Консилиум и личные тетради — на машинах», «Всё на машинах», «Всё на машине с картой» (`CLASS_PLACEMENT_PRESETS`). The form draws three tiles; for a GPU class the third is the card's. As built in 0.25.0 (F4), the second tile reads «Личные тетради — на машинах», and the form draws no «Консилиум» part nor its two numbers (`COUNCIL_POOL` false, shared/admin.ts): the attempts run in the class notebook's kernel whatever the field says, so a choice there would change nothing. The field is stored as the presets set it, for 0.26.0.
- **Bounds** (K8). A class's memory and cores are held to the place of every slot they reach (`placedBounds`, kernel/resources.ts): this server's for a slot here; for a slot set to machines, the biggest machine that takes classes, by its ledger with nothing held there (`ClassPlacements#machineBounds`: memory less the host's reserve and the placement cushion, cores less the agent's one), never above what that machine can give; the tighter of the two, named by its place, when the number reaches both (vsos's D31: the class notebook here, the personal ones on machines). The number reaches the personal notebooks only while their rules give them none of their own; the council's pool sizes itself by its attempt memory (0.26). The seminar's PATCH and its creation refuse a number past the bound in words naming the place («На машинах, где считается это занятие, памяти можно выдать от 512 до 63 232 МБ: больше не даст самая большая из них, «vast-3».», or this server's), and a move of the setting is refused, before anything is written, while the class holds a number the new place cannot give («Памяти у занятия — 24 576 МБ: уменьшите её, прежде чем менять, где оно считается.» followed by the new place's bound). The seminar view carries its `bounds`, which the class form draws as its machines' line («На машинах — память до 61,8 ГБ, ядер до 31: …»), and `GET /api/instance/resources` carries `limits.machines`. The personal notebooks' own numbers (their rules) are held to where their slot computes in the same way (`ownNumberBounds`, the forms through `ownNumberMax`, F4). A slot set to machines whose class's own stored number is past this server's bound does not fall back here when no machine takes it: the room reads «Ни одна машина сейчас не может взять ядро, а этот сервер даст не больше 15 360 МБ памяти — у занятия 24 576 МБ. …» (`pastThisServer`).
- **Fallback and failover.**
  - `fallback` («если машин нет — здесь», on): with no eligible machine, the slot starts at home through the existing Docker path and its admission (`reserveKernelMemory`, `gpuRefusal`), with a note.
  - `failover` / `failoverSec` (D13): «если машина пропала: перенести через 60 с / ждать машину».
- **Council-cell settings (0.26.0).** Two new `CouncilSettings` fields (notebook.ts:575) are rows in the console's «Регламент» sheet, which is the council's one place for settings:
  - `lane: 'pool' | 'shared'` («Попытки считаются: отдельно, параллельно / в общем ядре по очереди»);
  - `refresh: 'auto' | 'manual'` («Состояние для попыток: следует за ядром / по кнопке»). Both default as in D8 and D9.

### 6.3 Choosing a machine
`chooseMachine(sessionId, role, need)` in `kernel/remote/placement.ts`.

A machine is eligible only when all of these hold:
- **Liveness and trust.** It is a `liveRunner` (heard.ts:320): `active`, `classes = 1`, not quarantined for classes, build equal to home's (for new placements, 0.23 decision 5), and its tunnel is up.
- **Facts.** `facts.classes` says host networking, perimeter `ok` with a mode at least as strict as home's, canary `ok`, and not on home's daemon.
- **Image.** The class revision is portable and ready, or will be ready within `CLASS_START_MS`.
- **Memory.** Free memory minus the intents not yet acknowledged must cover `memoryMb + 256`: the stale-capacity rule of `runnerRoom` (lease.ts:122).
- **CPU and card.** CPUs fit, and a GPU room gets a card with no share in use.

Among eligible machines, prefer, in order:
1. the machine holding another slot of the class: one folder copy, and the epoch stays local;
2. the machine that hosted the class last, if its `stopped` row is at most 7 days old: a warm folder copy. As built, this rank is gone (F4): no copy is warm there by then — the agent removes a class's copy once home names the class nowhere on that machine (§20.7.3) — so it bought nothing, and a week of it could keep a class on a far link;
3. the lower RTT p95. Over 150 ms the class form says «далеко: +N мс на ячейку»;
4. the most free memory, then the name.

The council slot prefers the machine of the notebook's main kernel. A second machine is used only for a slot that fits nowhere else (D5).

**As built** (`ClassPlacements#candidates`, then `#eligibility`, K5a1). The filters run in this order, and the first one a machine fails is its refusal in the class form's live line (`MachineRefusal`):
- `avoided`, checked before every other: the slot left that machine within the last 30 minutes (`AVOID_MS`: any loss, a move by hand, a start given up), so such a machine reads `avoided` whatever else it fails;
- `not-live`: not a live runner — standing `active` by the owner's word and its own, of home's build, heard. A drained machine (the agent's `runner drain`, «Осушить», an update or a leave under way) and one quarantined for submissions are not live: they take no new placement and keep the ones they hold. The outlook reports an outdated machine as `outdated`;
- `classes-off` (or trusted), `quarantined` (for classes), `sealed` (a hidden-test lease held, D3), `tunnel` (down or quiet);
- `facts` (none reported yet), `host-network`, `perimeter` (not `ok`), `canary` (not `ok`), `same-daemon`. The machine's own network floor (`facts.mode`) is not compared with home's: the intent carries home's mode and the machine applies the stricter of the two (D21, §20.7). Unknown facts fail closed (an unknown `sameDaemon` reads true);
- `image`: the revision neither ready nor being fetched there, or failing;
- `full`: the machine holds `REMOTE_PLACEMENTS_MAX` (64) live placements already, the slot's own row aside;
- `memory` (free less what home asked and the last sync had not accounted for, including resizes not yet applied, below `memoryMb + 256`), `cpus`, `card` (a whole card: cards with no busy share, less GPU rooms placed there that hold none yet).

The preferences gain one rank: the image ready there goes ahead of the lower RTT. The live line names the machines that fit with their free memory and card count, and «далеко» over 150 ms.

### 6.4 One capacity ledger per machine
- Placements join the agent's `holding()` with their memory and CPUs. `freeCapacity` then reports one truth for submissions and classes, with no new arithmetic.
- Classes go first by ordering, never by preemption (D24): `takeForRunner` runs after the same reply's intents have taken their share. A running submission is never killed for a class, and «Места» limits submissions further.
- As built (K8), the same ledger bounds a class's numbers (§6.2): the most one container may be given there is the machine's memory less the host's reserve and the cushion, and its cores less one, counted for every machine that takes classes whether it is online, quarantined or drained (as the submissions' ceiling counts them, so the bound does not drop with a missed sync or an update), but not for one whose class facts keep it from every placement (`factsRefusal`: off the host's network, its perimeter or canary not passing, on this server's daemon). A GPU class's class notebooks on machines are held to the machines with cards. Memory and cores may name different machines.

### 6.5 GPU
- A GPU room on a machine gets one whole card. The agent picks it with `pickRunnerGpu`, restricted to cards with zero busy shares, marks every share of it busy in `cardReport`, and labels the container `colloq.gpu=<device>`. Home's competition take then sees no share there.
- A machine with no free whole card is not eligible. A GPU class with no GPU machine falls back to home's `KERNEL_GPUS`, or to `gpuRefusal`, as today.

### 6.6 Images
- **Portable only** (D22). Only revisions that `portableRevision` (want.ts:63) accepts are placed. A teacher-built environment stays at home, and the form says «Среда собрана на этом сервере — на машинах её нет».
- **Prefetch.** Class revisions join `want` for machines with classes; GPU revisions go only to machines with cards.
- **Pinned.** A placement pins `revision_id`, so a recreate or a failover uses the same image. Epochs depend on it (§9.3).

### 6.7 State
```sql
CREATE TABLE remote_placements (
  session_id TEXT NOT NULL, role TEXT NOT NULL,          -- room | own | council
  gen INTEGER NOT NULL,                                   -- bumps on every (re)placement; fences everything
  runner_id TEXT NOT NULL,
  state TEXT NOT NULL,                                    -- starting | ready | unreachable | stopping | stopped | lost
  environment TEXT NOT NULL, revision_id TEXT NOT NULL,
  memory_mb INTEGER NOT NULL, cpus INTEGER NOT NULL, gpu TEXT, workers INTEGER,
  container TEXT, ready_at INTEGER, ended_at INTEGER, reason TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, role));
-- remote_runners: classes INTEGER NOT NULL DEFAULT 0, classes_quarantined_at INTEGER, classes_resumed_at INTEGER
-- remote_runner_codes: classes INTEGER NOT NULL DEFAULT 0
-- sessions: placement TEXT (JSON, §6.2)
```
- A slot with no live row (`starting`, `ready`, `unreachable` or `stopping`) runs at home, if it runs at all. Existing rooms therefore carry no rows. `stopped` and `lost` rows are history for the chooser.
- There are no revision triggers. Usage, link state and file progress live in memory, as heard.ts does for leases.
- As built, history rows are never pruned: there is one row per slot, so its gen never starts over. A placement after a loss pins the lost row's `revision_id` while the slot has not come back since, in the same environment, and while that revision is still portable (§6.6); a class whose image changed mid-class may therefore come back here when no other machine holds the old one.

### 6.8 Asynchronous ensure, over the sync
`MachineKernels.ensure(sessionId, environment, revision, cpus, memoryMb, role)` has `RuntimeClient.ensure`'s signature (runtime-client.ts:174):
1. Upsert the row: `gen + 1` if it is new, on another machine, or after `lost`.
2. `wakeRunner`.
3. Await `placementReady(key, gen)` within `CLASS_START_MS` = 180 s. Pulls are prefetched, so this is container start plus readiness, typically 5–15 s.
4. Check the echo with `checkRuntimeEndpoint` (environment, revision digest, gen).
5. Open the listener and return the endpoint.

While it waits, the slow-start notice (`SLOW_START_NOTICE_MS` 8 s) speaks with the machine's words: «Запускаем ядро на машине «vast-3»… образ ↓ 45 %». A start failure throws `RuntimeRequestError(words, 503, failure)` with a `RuntimeStartFailure`, and the existing advice takes it from there (index.ts:1633).

As built: the room's log gets «Запускаем ядро на машине…» without the name, and staff the named sentence in the `kernel:machine` frame; the notice is silent while the machine is unreachable, and `ensureKernel` refuses to start an unreachable slot at all (the pump sends such a start back to its gate). A `failed` report keeps the row while the agent retries (10 s, doubling to 5 min), for at most `CLASS_START_MS` after the first failure: then the start is given up there — the waiting starts get the machine's words, the row stops, and the slot avoids that machine for 30 minutes — which is no failover and counts for no quarantine. A start error whose text names the slot's machine reads «Ядро не запустилось на машине — подробности у преподавателя.» in the room.

**Warm start.** The first participant opening the room ensures its machine slots, the folder copy, the `cells` session and the guard, so the first Run costs one round trip. The idle sweep stops them after `roomIdleMin` (D25).

As built: the class notebook's warm start is the existing `/join` warm-up (its `ensureKernel` for the `cells` session and the guard); the control socket's warm start covers the personal notebooks' slot only, through `warmSlot(sessionId, role)`, which places on a machine or does nothing — never a fallback here, never a refusal — skips a slot already placed or running here (`pool.ts · runsHere`), and shares its gen with a Run that arrives meanwhile. Finished, archived and stopping classes and broker homes are not warmed.

### 6.9 Tokens, ids, fencing
- **The token.** `placementToken = HMAC-SHA256(SESSION_SECRET, "placement:<id>:<role>:<runner>:<gen>")`, cut to 40 characters, alongside `roomToken` (pool.ts:123). It is deterministic, so a home restart re-derives it with nothing stored. It changes with the gen and the machine. `SESSION_SECRET` never leaves home.
- **Fencing.** Every intent, report, OPEN, PUT and reading carries the gen.
  - The agent labels containers `colloq.placement=<id>:<role>:<gen>` and refuses an OPEN for a stale gen.
  - Home answers anything from an older gen with 409 `stale`. As built, the code is 409 `revoked` (`REMOTE_ERRORS` has no `stale`; the agent drops the file), at the PUT door; `placementCurrent` counts a `stopping` row at the current gen as current, and only a loss or a newer gen fences. Sync reports carry a gen but no role, and gens of different slots on one machine may coincide, so a report is fenced through the copy's own gens (§8, §20.8) rather than at the sync.

### 6.10 Slot operations: early branches, not a refactor
pool.ts gains `if (machinePlaced(sessionId, role)) return machineKernels.X(…)` at the top of:
- `endpointForSession` (2120), `dropRoomKernel` (2301), `dropOwnKernel` (2341);
- `applyMemoryLimit` (1489), `applyOwnLimits` (1538), `applyCpuLimit` (1686), `reapplyInstanceDefaults` (1794);
- `listRoomKernels` (586), `runningKernelLimits` (1750), where machine rows hold 0 MB;
- `forgetSessionKernel` (2380).

Stops and resizes become durable intents:
- **Stop** sets the row `stopping`, and the reply omits the slot. The agent removes the container and reports it gone. An owner stop awaits that report, as `removeSlot` must confirm today (pool.ts:2271).
- **Resize** updates the row. The agent runs `docker update --memory --memory-swap --cpus` and answers `applied` or `absent`. As built, a memory raise must fit what the machine has free plus the 256 MB cushion, or it answers `failed` and the row keeps its numbers, as home's own admission does (CPUs are not checked, as at home); a raise that did not reach the running kernel is said in the room: «Новый предел памяти не дошёл до работающего ядра — ядро получит его при следующем запуске.»
- **A stop on a machine silent for 5 minutes** counts as done here; an owner's stop waits at most 30 s, and only while the machine still calls. A slot running here stays here while the class's setting says machines: `endpointForSession`'s machine branch leaves it (`runsHere`), so a changed setting takes effect at the slot's next start.

`usage.ts`, `postmortem.ts`, `resources.ts` (machine rows never enter home's `takenMb`) and `routes/admin-running.ts` get one early branch each. The 79 call sites of `kernelBackend()` stay untouched: a machine placement is not a backend.

## 7. The kernel host on the agent

New module `server/src/runner-agent/kernels.ts`, owned by `Agent`.

### 7.1 Pure cores moved from home
- **`kernel/room-spec.ts`.** `roomRunArgs(spec)` emits everything `runArgs` emits today, with every input explicit: name, role, image, mount, network, publish, card, memory, CPUs, pids, network mode, profile, token, hash seed, labels, extra mounts. pool.ts's `runArgs` becomes a wrapper.
  - The agent appends `--pull=never`, the submission log caps (`--log-driver=local --log-opt max-size=8m --log-opt max-file=2`) and its labels: `colloq.kind=class-kernel`, `colloq.placement`, `colloq.role`, `colloq.session`, `colloq.gpu`, `colloq.profile`, and its `INSTANCE_LABEL`.
- **`PYTHONHASHSEED`** (D28) is the seventh variable: `classHashSeed(sessionId)`, 1 + (sha256("colloq-hashseed:" + id) mod 4294967295). It is the same number for the class's room, personal and council containers, so set and string-dict order agree between the teacher's kernel and the workers.
  - It is not part of the recreate check. A container started before the upgrade runs without it until its next start, and the console says so once.
- **`kernel/perimeter-core.ts`** (about 450 lines moved). The pure builders, plus `roomHardeningArgs`, with chain prefix, network name, pids, mode and profile as inputs. perimeter.ts keeps the readers that touch `resourceValue` (perimeter.ts:101 → db.ts) and re-exports the rest. On machines the bridge is `colloq-mrooms-<i6>` (ICC off, IPv6 off) and the chains are `COLLOQ-MR<i6>-FWD`, `-IN` and `-DENY`.
- **`kernel/postmortem-core.ts`.** `CGROUP_SCRIPT`, `parseReading`, `killedByMemory`. `describe` stays at home, because the words are home's.
- **The bundle rule.** tests/runner-import-graph.test.mts keeps `FORBIDDEN` unchanged and checks that the three cores load nothing on it. Agent words travel as `remoteText` markers through the i18n shim (0.23 note 9).

### 7.2 Start, ready, stop, resize
1. **Start.** Revision ready (`Images`), then the disk floor (the room folder's size included), then the card for a GPU room, then the perimeter, then `docker network create` with `networkCreateArgs` if the network is missing, then `docker run`.
2. **Ready** is an authenticated `GET /api/status` from the agent, within 90 s.
3. **A failure** reports `RuntimeStartFailure` words (`memory`, `cpu`, `gpu` or `other`), with at most 300 characters of detail.
4. **Stop** is `docker rm -f`. A stop that arrives during a start is finished by the start, as pool.ts's `abandoned` does (pool.ts:2096).
5. **Resize** is `docker update`. As at home, a changed `--cpus` does not change thread variables in a live container.
6. **Records.** Each placement is written with `writeWhole` to `<state>/placements/<id>-<role>.json`: gen, container, image, revision, spec digest.

As built (K4): a start home still wants is retried after a failure, 10 s doubling to 5 min; a start is refused on a trusted machine or one holding a sealed lease («this machine holds the hidden test»), and running class containers are not removed for it. A container the census finds dead is read for the post-mortem and started again at the same gen (`docker start`: a fresh Python, the packages a student installed into the container kept), as home starts its stopped rooms; home's next question gets the reading taken at death, since a restarted cgroup has lost its counters. OOM kills and card memory are read at most once a minute per container. `resized` is reported only for the numbers the current intent asks. The spec digest hashes the profile and `MACHINE_ROOM_FLAGS` too.

### 7.3 Adoption: kernels outlive the agent
- **At start.** The agent lists `docker ps -a --filter label=colloq.kind=class-kernel --filter label=<INSTANCE_LABEL>`, matches the containers to its records, reads their ports, and reports them in the first sync. Home keeps current gens and omits stale ones, which the agent then removes. As built, they are reported in the second sync: §15's rule (no block before a reply carried one) wins, and the first sync of a life with adopted containers is held 0 ms and already counts them out of `free`. A container whose record this build cannot read (an older or newer shape) is kept, held as `starting`, and taken up as it runs once home names its slot at that gen; removed otherwise.
- **Sweeps never touch them.** The 0.23 `sweep` (sync.ts:512) filters by the run and check labels, so it never touches class containers; a test pins this.
- **Stopping.** SIGTERM leaves class containers running. The final draining sync carries `kernels.bye`:
  - `restart` when `colloq-host runner update` left `<state>/restart.marker`; home then holds the placements for 120 s (D23). As built, colloq-host writes the marker before every stop it makes of a running agent (an update, a replacement for new settings) and removes it after the stop, read or not;
  - `stopping` otherwise;
  - `leaving` on leave.
- **Ends.** The 401 path (`unauthorized`, sync.ts:978) and leave remove class containers and their folders. As built, so does a move to another home, and the removal is asked again with a backoff until docker lists none. A 400 or 413 refusal of a sync carrying the kernels block (a home rolled back to 0.24) makes the agent drop the block, close its tunnel, log it once and go on without it.
- **Versions.** A build mismatch («устарел») blocks only new placements. Adopted containers keep their argv until they next start.

### 7.4 Census and post-mortem
- **Census.** Every 10 s while placements live: one batched `docker stats --no-stream` plus `inspect`, the pair `containerCensus` uses. Per placement it reports usage, limit, CPUs, CPU %, start time, OOM kills and card memory.
- **Post-mortem.** When `onPhase` sees an unexpected restart or death of a machine kernel, `pm.explain` asks through `kernels.postmortem: [key]`. The agent returns a reading: `inspect` (OOMKilled), `exec CGROUP_SCRIPT` and `logs --tail 40`. Home explains it with `killedByMemory` and `describe`.

### 7.5 Networking and co-location
- **Host networking** (D19). The agent runs with `--network host`: `colloq-host run_runner` and the panel's plain join command (`runnerJoinCommands`, byte-equal to `colloq-host runner_code`) both gain the flag.
  - The agent reads its own `HostConfig.NetworkMode` through `COLLOQ_RUNNER_CONTAINER` into `facts.classes.hostNetwork`. Without it the machine is not eligible: «нужен --network host — перезапустите машину командой из панели».
  - That is how it reaches rooms on `127.0.0.1:<port>`: home's host form (pool.ts:1224), with the same perimeter. The IN chain refuses the rooms subnet to the host.
  - It grants nothing new: the agent already holds the Docker socket, opens no listening port, and keeps its control door on a Unix socket.
  - Under host networking the hostname is the host's, so the entry point finds the agent's own container in `/proc/self/mountinfo` (`locate_self`) and exports it as `COLLOQ_CONTAINER`.
- **Co-location is refused** (D20). The agent sets `facts.classes.sameDaemon` when a home's containers are on its daemon, and `colloq-host runner up` refuses classes there. The distinct label is defence in depth. As built, both ask the same three things: a home's container, its rooms (`colloq.kind=room-kernel`) or its rooms' network (`colloq.kind=room-network`), which stays after every room went idle, as on a pip or `make dev` home between classes; the panel reads «на этой машине стоит сервер Colloq — занятия нельзя».

### 7.6 Perimeter re-check, admission canary, orphan rule
- **Perimeter.** `ensureMachinePerimeter` follows `ensureRoomPerimeter` (perimeter.ts:802): it fails closed, runs before every start, and takes the helper from the agent's own image by ID. Home's mode is the floor, and `KERNEL_BLOCKED_CIDRS` arrives with each intent; the machine may add ranges, never remove them.
- **Re-check.** Every 60 s while placements live, the rules are checked again and a missing rule is reinstalled. After three failures in a row the agent stops every class container and reports `perimeter: 'failing'`; home fails the machine's placements over and raises an owner banner.
- **Admission canary.** At each agent start, before the machine becomes eligible, a throwaway container with the class argv checks (adapted from ops/runtime-smoke.ts:106-165):
  - uid is not 0, CapEff is 0, NoNewPrivs is 1;
  - no Docker socket and no agent files are visible;
  - 169.254.169.254, the host, the LAN and IPv6 are refused;
  - another class's loopback port is unreachable;
  - the folder round-trips.

  The result is `facts.classes.canary`.

  As built (K4): facts, the perimeter install and the canary run on the first reply that carries the kernels block, or at adoption when class containers were adopted, not at every agent start, so a machine that only takes submissions never gets iptables rules or the privileged helper. The canary needs a class image on the machine (until then the panel reads «проверка допуска пройдёт, когда на машине будет образ класса»), opens two ephemeral listening ports for its few seconds (any connection to them is a failure), and runs again 10 min after a failure; a start waits for it. `failing` holds until an install succeeds, nothing starts while it holds, and the containers it stopped are reported `stopping` until docker no longer lists them; before the first install and after a single failure the state is `refused`. `facts.mode` is the machine's own floor (`COLLOQ_ROOM_NETWORK`), not home's.
- **Orphan rule.** A class container whose home has been silent (no sync reply, no tunnel frame) for `roomIdleMin`, and whose kernels are idle in the census, is stopped by the agent itself. This also covers a home rolled back to 0.24, which ignores the new tables. As built: silent means no reply carrying the block and the tunnel down, for 120 min (`KERNEL_TIMINGS.orphanMs`, roomIdleMin's default); idle means CPU at most 5 % for 5 min; placements that do not run, and containers whose record cannot be read, are removed too.

## 8. Files both ways

### 8.1 Layout
- **The copy.** The class folder copy lives at `<state>/rooms/<id>/`, owned by uid 1000 with folders 2775 (setgid) and files 0664, as `sessionDir` makes them. One copy per machine serves the class's containers there.
- **Copied, never linked.** Content is copied from the CAS, never hard-linked: an `open('r+')` must not rewrite a blob that submissions mount.
- **The baseline.** `<state>/rooms/<id>.baseline.json` maps path → sha256 (or `dir`) as both sides last agreed. It is written with `writeWhole`, so it outlives a restart of either side, and it is what gives "base" its meaning.

### 8.2 Home → machine: the barrier
New module `server/src/kernel/remote/files.ts`.

**Change detection.** `forgetTree(sessionId)` (workspace.ts:346) bumps a counter, `treeEpoch[sessionId]`. Every home writer already calls it:
- writeText (:1058), which covers the editor and `projectBooks`;
- uploads (routes/files.ts:347/578);
- the tree verbs (:628/648/811/833/909);
- `broadcastFiles` after every cell (control.ts:839). That covers a local kernel writing, the vsos default case: room at home, personal kernels on a machine.

**`filesBarrier(sessionId, runnerId)`** runs after `flushToDisk` in `runOne` (index.ts:3358) and in `runCouncilOne` (:4437), after `flushFile` at `file:run` (control.ts:4942), and in the oracle's `run_file` (ai/agent.ts:1229-1236).
1. **Fast path.** The counter is unchanged, the last push is acked and the last walk is at most 10 s old: return with no walk and no round trip.
2. **Walk.** Otherwise a local stat walk: hashes come from `cachedSha256` (dependencies/files.ts:141), keyed by stat, at most 5000 entries, about 5–20 ms. Diff against the acked manifest; an empty diff returns.
3. **Push.** Otherwise a `RemoteFilesPush`:
   - removes;
   - **moves** wherever a removed and an added path share a sha (`movePath` and folder renames become renames on the machine);
   - puts: inline up to 64 KiB each and 1 MiB per reply, larger files through `GET blobs/<sha>` (`BlobSource room`, scoped to machines with a placement of that class and that sha pending);
   - folders.
4. **Wait.** `wakeRunner`, then wait for the ack while bytes keep moving: at most 120 s, and 30 s with no progress refuses the cell («Файлы не дошли до машины…»). The cell shows «Файлы едут на машину: 12 из 150 МБ». A push a Run waits on is promoted to 8 MiB/s (§4.9).

**The agent applies a push in order:** moves, then removes, then puts.
- Each write goes to a `TEMP_FILE`-shaped name, then a rename.
- Each change updates the baseline, and the ack rides the next sync, sent at once.

As built (K6a, K6b; details in §20.8): pushes also go out by themselves 1 s after any write here (D16), so a Run usually finds the copy current; the barrier never waits for the room's notebook files, which every run's outputs rewrite — nor, since F4, for a push in flight that carries nothing else (students typing keep the notebooks' projections, and their pushes, coming; K12 measured runs behind them at a p95 of 13.8 s); small files past one reply's 1 MiB inline budget wait for the next push of a chain rather than becoming blob GETs, and the barrier waits for the chain's last; a copy keeps at most 2 pushes unacked; a Stop ends a wait at the barrier (the cell is left at rest); the ack is the held placement's `files.pushSeq`. A copy is tied to the gens it serves: home naming the class on a machine at gens its copy never served starts the copy again with a full push.

### 8.3 Machine → home: scans, reports, pulls
New module `server/src/runner-agent/room-files.ts`.
- **When the agent scans.** On home's `scan` request, sent after every cell or attempt. And by itself: every 5 s while a stream of the class carried bytes in the last 60 s, else every 30 s. This closes today's gaps: nothing during a long cell, nothing after a terminal command. As built, "busy" is the census's word (a container's CPU above the idle line, or just ready) — the agent's tunnel keeps no per-class byte counts — and the next scan is due from the last one's start.
- **How it scans.** A `TreeStamp`-style walk (workspace.ts:323-343). Changed files are hashed through `HashBook` only after 2 s without change (`CLASS_FILE_QUIET_MS`), so a checkpoint is not caught half-written. A scan home asks for after a cell skips the quiet rule, because the writer is done. As built, "without change" means stats, ctime included, held for 2 s on the agent's own clock across scans (mtimes are not trusted: `cp -p` keeps old ones), and a new top-level folder is sent only once nothing new appears in it, 30 s at most (`newFolderMs`), so `pip install -t .` or `tar x` never goes half done. The walk is asynchronous and yields every 256 entries; it hashes in place through a descriptor that follows no link, and what travels (pulls, conflict copies) is copied to `<id>.staging` as it is hashed; inline content is read and hashed again before it goes.
- **The report.** `changed {path, sha256, bytes, base, inline?}`, `removed {path, base}`, `skipped {path, bytes, why}`. Inline means up to 64 KiB each and 128 KiB per request.
- **Pulls.** For larger files, home answers `pulls`. The agent first copies the file to its own staging (so the bytes match the reported sha), then sends `PUT /api/runners/v1/rooms/:session/files?path&gen`: gzipped, paced, with `X-Colloq-Sha256` and `X-Colloq-Bytes`. Classes get 2 upload slots of their own (`REMOTE_CLASS_UPLOADS`), so they never starve submissions. As built (K6b, F3): the PUT body is paced and chunked, with no `Content-Length`; a pull for «Привезти» names no sha256 (the file as it is now, the PUT says which); nothing over `machineFileMb` is staged except for «Привезти», and nothing over the room limit at all; a version gone before its PUT is let go of (reported `removed` with the sha it was reported with, so home drops the pull); home drops a «Привезти» pull whose path comes back in `released`, and lets a kernel's pull go after 60 s when the machine says nothing is pending (after an agent restart, say).
- **Home's apply.** Home validates (§8.6), writes through `workspaceFs` (temp file, then rename) and fires the unchanged `onWorkspaceChanged` hooks, debounced per class at 400 ms. Open editors follow through `watchDisk`.
- **The verdict.** Home answers per path, `{accepted, refused}`. An accepted path moves into the baseline. A refused one is overwritten by home's next push. As built, verdicts may come in any later reply, a change with no answer is said again after 60 s, and every reply's kernels block carries a number (`replySeq`) the agent says back (`heard`): home sends once more the verdicts of replies the agent never took in (F3; an agent's cut of its own held sync could drop the reply carrying them). A pulled conflict copy's verdict waits until its bytes have landed.

### 8.4 Conflicts, tombstones, renames
**The one rule.** A machine change applies only if home's current sha equals the change's `base` (an absent file counts as null). Otherwise home wins (D16).

| Case | Outcome |
|---|---|
| The kernel writes `out.csv`, which home never touched | Applied |
| Both sides changed the content, and it differs | Home's version stays. The machine's version is saved as `out (с машины 14-32).csv` if it fits the caps, and staff see a note. Home's version is pushed back |
| Home deleted `old.csv` while a loop rewrote it | The delete holds: the change is dropped, with a note. The loop's next write after the push has `base = null` and applies as a new file. Nothing comes back |
| The kernel deleted a file home has since replaced | Home's file is pushed back |
| The kernel renamed `a.csv` to `b.csv` | Seen as a remove plus an add with the same sha. Home runs `movePath`, with no upload |
| A notebook file (`isBookFile`, books.ts:587) changed on the machine | Refused and re-projected. A cell on a machine can no longer delete a notebook tab with `os.remove`: a small, deliberate change |
| A report from an older gen | 409 `stale` (as built: 409 `revoked` at the PUT door; a late list is named in the room only for a gen the class lost there) |

The base comes from the persisted baseline. After a home restart, home rebuilds its acked manifest from the agent's `full` report, so writes made while home was down are pulled. After an agent restart, the baseline file says what home last agreed.

### 8.5 Caps, filters, package trees, «Привезти» (D17)
- **Synced paths.** Only what `normalizePath` (shared/paths.ts) accepts: depth ≤ 8, segments ≤ 120 characters, path ≤ 400. Never hidden names, `__pycache__`, `TEMP_FILE` names, symlinks or special files. A file with several hard links travels as content.
- **The caps, new for kernel writes.** Kernel writes coming home were never capped before (routes/files.ts:283-290).
  - Per file: «Файл с машины — до» (`machineFileMb`), 200 MB, a live setting.
  - Per class: the room limit (`sessionLimitBytes`, 1024 MB).
  - Per walk: 5000 entries.
  - A file over a cap stays «на машине». The kernel log says once: «model.pt (2,1 ГБ) больше предела 200 МБ и остаётся на машине. Если машина пропадёт, файл пропадёт тоже».
- **Package trees.** When a `*.dist-info/RECORD` (or an `.egg-info/installed-files.txt`) appears, the agent marks every path it lists machine-only (`why: 'package'`). The tree shows one collapsed row, «пакеты (pip -t) — на машине, 2,1 ГБ». `pip install -t . torch` never touches the relay.
- **«Привезти».** Staff press it on a «на машине» row, and home pulls that one path. A file over the per-file cap is allowed this way, still within the room limit. As built (F4), the press hears its own answer (`files:fetched`: `accepted`, `brought` — the file is here already — or `refused` with the words), and the panel lets the press go on it, or on a socket that closed, rather than on a 10 s timer.
- **Delete of a «на машине» row** (F4). Staff's delete of a row only a machine has (a file, or a folder made up of such rows) goes there: a remove of that path rides every push of the copy until one carrying it is acked, and the row goes with that ack (the machine has removed it), or sooner when the machine reports the path gone (`released`). Students are refused as for any file. The agent removes such a file with no conflict note (it was one home knew stays there: said as skipped, or refused for a cap), so nothing comes back as a new file; a push's acked remove also drops every «на машине» row under the path.
- **A proxy's 413** (F4). A proxy in front of home that refuses a body this large (nginx's `client_max_body_size`, Caddy's `request_body`) answers 413 without home's marker: the agent takes it as a refusal, not a hiccup, keeps that version on the machine, and says it left there with the reason `proxy` (`RemoteSkipReason`) until the file changes; home lets its pull go, shows the row «на машине», says once «model.pt (150 МБ) остаётся на машине: прокси перед этим сервером не принял файл такого размера. …», and refuses its «Привезти» in words until the proxy's limit is raised (server.html#proxy). Before, the agent sent the whole file again up to eight times a round.

### 8.6 What a machine reports is participant data
- **Home re-checks** every path and type and never creates links. It writes through `createAnchoredFilesystem`.
- **Bytes.** Sha256 and byte counts are checked after decompression. Staging uses `TEMP_FILE` names, which `sweepAllStaleUploads` cleans after a crash.
- **Scope.** A machine's credential reaches only the classes placed on it, at their current gen. Each machine is limited to 10 reports a second and 1000 paths per report. As built: one report per class per sync and 1000 paths per sync across its reports (`REMOTE_REPORT_PATHS_MAX`), the syncs themselves within the machine's 240 a minute, and the class doors in buckets of their own (`roomBlob`, `roomFile`, 1200 a minute each).
- **The agent** walks with the anchored filesystem too (already in its bundle), never follows links, and copies before it hashes: a kernel can plant `ln -s /var/lib/colloq-runner/runner.json x.csv`.

### 8.7 Pull barriers and lag
- `filesSettled(sessionId, timeoutMs)` asks every machine of the class for a scan and waits for the reports to apply. It runs:
  - before the class-end refresh (publish/class-end.ts:159-170, within its 2 min);
  - before a class page build (publish/materials.ts);
  - before the oracle's `movedFiles` (ai/agent.ts:1586);
  - before failover's final note (as built: before «Перенести сейчас» off a machine that answers, for up to 10 s, `MOVE_SETTLE_MS`; before the owner's «Не принимает занятия», for every class of the machine at once (`settleRunner`, F4); and before a leave, on the agent's side, which settles its classes' files for up to 10 s before its sync says `leaving` (`settleForLeave`, F4); a silence leaves nothing to ask, and a revoke waits for nothing);
  - before a download of a pending file, and before a move or copy of a path with pending changes.
- A new file a kernel just wrote is listed only once it has reached home. An existing file the kernel rewrote serves its previous version until its pull lands, seconds at most.
- «Работают сейчас» shows each placement's lag: «файлы: синхронно», «↑ 3 файла, 12 МБ» or «2 файла только на машине».

### 8.8 Failover and files
- **Lost.** Only the unsynced tail: at most one scan interval of writes, plus «на машине» files, which the failover note names. As built, the failover note gives the time of the files («файлы — по 14:31:58», the machine's last report) and names no file; each «на машине» file was named once in the kernel log when it stayed there.
- **Late reports** from the old gen get 409.
- **A returning machine** diffs its copy against its baseline and reports at most 50 changed paths (`late_changes`). Home names them in the room, refuses them, and the agent deletes the copy. As built, the agent waits up to 60 s for the old containers to go before it says the list; home names it (without the machine's name) only for a gen the class lost on that machine and for classes the machine served in this life, and an ordinary stop's leftovers are named in the stop's own words («Ядра на машине остановлены; изменения в файлах, которые не успели доехать до сервера, отброшены: …»). When the class is placed on that machine again at new gens, the copy is kept rather than removed, and an old placement's late writes may then be accepted (the agent cannot tell).

## 9. The council on machines (0.26.0)

**Not built in 0.25.0** (D29, §20.9). Nothing of this section runs yet: no epoch is exported, no council slot is placed, and every attempt runs in today's notebook FIFO, in the notebook's kernel wherever it runs. The class setting's `council` field and the presets that set it are stored already, while the form draws its «Консилиум» part, «Попыток одновременно» and «Память на попытку» only with the pool (`COUNCIL_POOL`, F4); the contract carries the council's fields for 0.26.0; pool.ts's Docker and broker branches throw an internal English error for a council endpoint (`COUNCIL_ON_MACHINES_ONLY`), and placement.ts refuses a council slot no machine takes with `ef5702` («Пул консилиума бывает только на машинах.»).

### 9.0 Синхронизация в консилиуме простыми словами

*Для владельца. Технические подробности — в §9.1–9.12.*

**Как сейчас.** Попытки студентов считаются в том же ядре, что и тетрадь преподавателя: по одной, в общей очереди вместе с его ячейками. Перед каждой попыткой ядро делает личные копии данных, после неё возвращает всё как было. Поэтому:
- при тридцати попытках по 2 секунды последний ждёт больше минуты;
- долгая ячейка преподавателя держит всех, застрявшая попытка держит очередь;
- перезапуск ядра стирает то, на чём считают попытки.

**Как будет на машинах.**

*Откуда ядро попытки берёт переменные преподавателя.* Ядро тетради делает **снимок** своих переменных — «состояние для попыток». В снимок входят:
- таблицы и массивы;
- модели, а также функции и классы из тетради;
- импорты — по имени модуля;
- состояние генераторов случайных чисел и настройки: опции pandas и numpy, matplotlib, текущая папка.

Большие числовые куски (столбцы таблиц, массивы, веса моделей) лежат в снимке отдельными файлами, и у каждого имя по его содержимому. Снимок один раз едет на машину консилиума. Если тетрадь сама считается на этой машине, он не едет никуда.

На машине работает **пул исполнителей** — обычные ядра Python, от двух до шестнадцати, сколько поместится; можно поставить и «по исполнителю на студента». Каждый исполнитель один раз загружает снимок и дальше считает попытки по одной. На время попытки исполнитель целиком её: своё ядро, свой процессор, свой потолок памяти. Большие числовые данные лежат в памяти машины один раз на всех исполнителей; попытка получает свою копию только того куска, который меняет.

*Когда снимок обновляется.*
- Когда преподаватель открывает консилиум.
- Когда он нажимает «Обновить состояние».
- Сам — в режиме «следует за ядром», он включён по умолчанию. Если после снимка преподаватель выполнил ячейку, следующая попытка сначала ждёт новый снимок: до пяти секунд, обычно доли секунды, потому что переснимается только то, что изменилось. Если новый снимок не успел, попытка считается на прежнем, а на карточке написано «состояние 14:05 — без ячеек 8–9».

В режиме «по кнопке» снимок меняется только кнопкой. Перезапуск ядра тетради снимок не стирает: попытки считаются на прежнем, пока преподаватель снова не выполнит ячейки.

*Что видит и меняет попытка.*
- Она видит переменные снимка — ровно те, что были в ядре тетради в момент снимка, с тем же состоянием случайных чисел. Одинаковые попытки печатают одинаковые числа, как сегодня.
- Она видит файлы занятия, но только для чтения. На машине лежит копия папки, свежая к началу попытки.
- Свои переменные попытка меняет как хочет. После неё они выбрасываются, и исполнитель возвращается к снимку — тоже как сегодня.
- Файлы, которые попытка пишет (`out.csv`, картинки), ложатся в её личную папку, а не в общую: тридцать попыток больше не перетирают один `out.csv`.
- Жадная попытка получает `MemoryError` сама; соседи и тетрадь преподавателя этого не замечают.

*Что возвращается.*
- Вывод — текст, картинки, ошибки — приходит автору и преподавателю, как сейчас. Отметки ✓/✗ и показ классу работают как сейчас.
- Файлы попытки — на её карточке: до 20 файлов, каждый до 1 МБ, всего до 5 МБ («файлы попытки: out.csv 12 КБ»).
- В ядро тетради не возвращается ничего: переменные преподавателя попытка испортить не может.
- Общее состояние по-прежнему меняет только «В ячейку и запустить». Эта кнопка выполняет решение в ядре тетради по-настоящему, и его файлы ложатся в общую папку.

*Если что-то нельзя скопировать.* В снимок не попадают открытое соединение с базой, открытый файл, генератор, поток, данные на видеокарте и переменная больше 2 ГБ. Пульт один раз показывает их список: «Не переносится: conn (соединение с базой), batches (генератор)».
- Попытку, которая обращается к такой переменной, исполнитель сам отправляет считаться по-старому — в ядро тетради, в общую очередь. На карточке написано, почему.
- Если попытка добирается до такой переменной окольным путём (`globals()['conn']`), она получает понятную ошибку, а не чужие данные.
- Весь консилиум считается по-старому, если в снимке есть данные на видеокарте, снимок не собрался, машин нет или машина консилиума пропала.
- Строка «Попытки считаются» в регламенте пульта возвращает старый способ и вручную.

*Чем это отличается от сегодняшнего.*
- Попытки идут одновременно, а не по одной, и не ждут ячеек преподавателя. Преподаватель может спокойно считать свои ячейки и даже перезапустить ядро — консилиум продолжит работать.
- Попытка видит состояние на момент снимка, а не «живое». На каждой карточке написано, на какой момент.
- Файлы попыток больше не попадают в общую папку — они на карточке.
- Если машина пропала посреди попытки, попытка один раз пересчитывается — на другой машине или в ядре тетради. Пауза между запусками студенту не засчитывается.
- Без машин, а также пока пул поднимается (первые 5–15 секунд), всё работает как сейчас.

### 9.1 The model
- **Today's semantics, kept.** An attempt is a function of (shared state, attempt text). Its effects on variables are thrown away (`leave`). Its randomness starts from the shared RNG state, so identical attempts print identical numbers (`_snapshot`, council-isolation.ts:890).
- **Why a pool is cheap.** Attempts carry no state from one run to the next, so their kernels need be neither persistent nor personal. A pool of interchangeable workers holding the same frozen state is enough. «У каждого свой ресурс» holds per attempt (a process, a CPU, a memory ceiling); «или пул ресурсов» is the pool's size.
- **One-way and versioned.** The notebook's kernel, wherever it runs, is the primary. Workers are read replicas of one frozen moment, the epoch. Every run records the epoch it saw (`CouncilRun.epoch`).

### 9.2 The epoch: when it is taken, and where it goes
- **When.**
  - The council opens (`cell:lock` → `'council'`, control.ts:5033).
  - The teacher presses «Обновить состояние» (`council:epoch`).
  - Automatically (D8): the main runtime counts its *history runs*, the executes that store history (teacher cells, open-cell runs, adopted runs, the oracle's `run_cell`). Attempts and service runs never count. The epoch records the counter. When the counter has moved and the cell's refresh is automatic, the next dispatch asks for one refreeze (at most one in flight) and waits at most 5 s (`COUNCIL_EPOCH_WAIT_MS`). Then it dispatches on the newest ready epoch, and an older epoch's card says «состояние 14:05 — без ячеек 8–9».
  - A main-kernel restart alone does not mark the epoch stale; the first history run after it does.
- **One live epoch per notebook.** A second council cell in the same notebook shares it.
- **How it is taken.** The export is a service item in the main runtime's own FIFO (`QueueItem {cellId: 'epoch:<seq>', epoch}`), so it runs between the teacher's cells, never under one. The queue strip shows it as «снимок состояния».
  - It is one silent execute, reported through `user_expressions`, like the isolation entry.
  - It never starts a kernel: with no live main kernel, the epoch is empty by construction.
- **Where the files go.** The kernel writes to `/tmp/colloq-epoch/<seq>/` inside its own container. Personal kernels and attempts live in other containers and cannot reach that folder.
  - Home (for a home kernel) or the agent (for a machine kernel) collects it with `docker cp`, checks each file against the report's sha, moves it into its CAS, and removes the folder.
  - **Main kernel at home:** the files go to `DATA_DIR/council-epochs/<id>/`. The pool's machine fetches the shas it lacks with `GET blobs/<sha>` (`BlobSource epoch`, scoped to that council placement) and hard-links them into `<state>/council/<id>/epochs/`. Hard links are safe there, because that mount is read-only.
  - **Main kernel on the pool's machine:** nothing crosses the relay.
  - **Main kernel on another machine:** that agent sends the missing shas to home (`PUT epochs/<sha>`, paced), and home serves them on.
- **Caps.** At most 2048 MB in total (`COUNCIL_EPOCH_MB`). At most 256 MB to ship per refresh across the relay (`COUNCIL_EPOCH_SHIP_MB`); only buffers the other side lacks count.
  - A first epoch over the caps keeps the council shared, with the reason.
  - A refresh over them keeps the previous epoch: «новое состояние не помещается — попытки на состоянии 14:05».
- **Registry.** `council_epochs(session_id, root, seq, manifest_sha256, body_sha256, bytes, ship_bytes, report_json, main_runs, incarnation, created_at)`. The last two per notebook are kept. Files go when nothing references them, and home's epoch store is capped at 4 GB, LRU.

### 9.3 Export and load (Python, in the same hidden module as `enter`)
**The format.** An epoch is a manifest plus files named by their sha256:
- `manifest-<sha>.json`: imported modules, left names with their reasons, buffer shas in order, process-state keys;
- `stream-<sha>.pkl`: the pickle without its big buffers;
- one file per out-of-band buffer of 64 KiB or more.

Unchanged buffers keep their sha across refreezes and are neither rewritten nor shipped. A buffer is re-hashed only when its adler32 at the same address and size changed against the previous export's table, which the hidden module keeps. A refreeze of an unchanged 1 GB state takes about 0.3 s.

```python
def export(ns, out, budget, settings):
    """Carried names in ONE pickle stream (one memo: a model and its optimizer stay one graph);
    numeric buffers out of band, content-addressed. Every name is tried alone first, to name what fails."""
    for name in sorted(_list(ns)):                 # skips In, Out, _, _i3, get_ipython, exit…
        obj = ns[name]
        if isinstance(obj, types.ModuleType): imported[name] = obj.__name__; continue
        if _on_cuda(obj): left.append((name, 'cuda')); continue
        size = _trial(obj, budget - total)          # pickle to a counting sink; buffers only measured
        if isinstance(size, str): left.append((name, size)); continue
        carried.append(name); total += size
    _write(out, {n: ns[n] for n in carried}, _portable(_snapshot()), imported, left)
    # Pickler(protocol=5, buffer_callback=…): cloudpickle's, from joblib if not installed

def load(ns, manifest, body_sha, settings):
    head, body, buffers = _open(manifest)          # every buffer: mmap(ACCESS_COPY), private copy-on-write
    if hashlib.sha256(body).hexdigest() != body_sha: raise …
    state = pickle.loads(body, buffers=buffers)    # numeric blocks become zero-copy views
    … import modules by name; _rebind notebook functions to THIS namespace; bind _NotCarried sentinels;
    … apply process state; threadpool_limits(settings['threads']); write 1000 to /proc/self/oom_score_adj
```

Six details make this correct.
1. **cloudpickle.** `import cloudpickle`, else `from joblib.externals import cloudpickle`. scikit-learn ≥ 1.4 in kernel/requirements.txt brings joblib with it, so no image changes. Without it, notebook-defined functions and classes become left names.
2. **One stream, then rebinding.** cloudpickle captures a notebook function's globals by value. In the same stream, the memo makes those captures the *same objects* as the carried names. `_rebind` then rebuilds each `__main__` function with `types.FunctionType(code, ns, …)`, and does the same for methods of notebook classes. `f()` in a worker therefore sees the worker's `df` after `df = df.dropna()`, exactly as in the shared kernel.
3. **Shared pages, private writes.** Mapped buffers are shared by all workers through the page cache and charged once to the council container's cgroup. `_make('ndarray')` in `enter` (council-isolation.ts:702) gains one branch: an array backed by the epoch gets a fresh private mapping per attempt in O(1), instead of `.copy()`, and that mapping is dropped at `leave`. pandas copy-on-write lazy copies already cost O(1).
4. **Memory, said plainly.** `_arm_memory` sets RLIMIT_AS to the current VmSize plus room (council-isolation.ts:858-872), so the mapping itself does not eat an attempt's ceiling. But RLIMIT_AS does not bound copy-on-write writes into pages already mapped: those are bounded by the epoch's size per worker and by the cgroup. Two rules close the gap:
   - each attempt writes into its own fresh mapping (detail 3);
   - a worker whose private dirty memory after an attempt exceeds `attemptMb` (read from `smaps_rollup`) is recycled.
5. **The cap is mandatory.** `_memory_cap(floor, headroom, cap)` requires `cap` (`attemptMb`, D33) for workers. Today it reads the cgroup's remaining memory (council-isolation.ts:835-844), so N workers in one cgroup would each claim the whole remainder. Each worker also writes `oom_score_adj = 1000` at seed, so the cgroup's OOM killer picks a worker, never jupyter_server: killing jupyter_server would end every worker's session.
6. **The same image and hash seed.** Workers run the main kernel's pinned revision, so pickles never cross library versions. They share the class's `PYTHONHASHSEED` (§7.1).

### 9.4 What cannot travel, and the check in the worker

| Kind | Example | In the epoch | An attempt that uses it |
|---|---|---|---|
| Modules | `np`, `pd`, `plt`, a local `utils` | by name, re-imported. A local module comes from the synced folder, so an edited `utils.py` is newer than the teacher's import (noted) | works |
| Notebook functions, classes, instances | `def score(df)`, `class Net` | cloudpickle by value, rebound | works |
| Data in `_plan`'s list | ndarray, DataFrame, containers, sklearn, torch on the CPU, sparse, RNGs | pickle 5. Numeric blocks go out of band and are shared; object and string columns and torch storage are copied per worker | works |
| Other picklable objects | a matplotlib `fig`, a `requests.Session` | tried, with a per-name byte cap | works |
| Unpicklable objects | open file, socket, DB connection, generator, thread, lock | left, as a `_NotCarried` sentinel | goes to the shared kernel |
| CUDA | `model.cuda()` | `left: cuda`; the whole council stays shared (D11) | shared kernel |
| Over budget | a 3 GB frame | left, `over budget` | shared kernel |
| Process state outside `_portable` | `%config InlineBackend`, IPython formatters | not carried (the same gap today's restore has) | defaults |

**The check.** `enter` gains `_colloq_needs(source)`: it parses the attempt with `ast` and uses `symtable` to find the global names it reads and does not assign. It runs inside the same execute as the entry, so it costs no round trip, and only when the epoch has left names at all.
- If a needed name is left, the entry refuses. The worker leaves, and the job moves to the notebook's FIFO, keeping its place. The card reads «посчитано в общем ядре: использует conn — её нельзя перенести».
- Indirect access (`globals()['conn']`) hits the sentinel, which raises `NotCarried: переменная conn не перенесена на машину консилиума (соединение с базой); такие попытки считаются в общем ядре`.
- The console shows the left names once per epoch: «Не переносится: conn (соединение с базой), batches (генератор)».

### 9.5 The pool
- **The container.** One `council` slot per class per machine, placed like the other slots (§6.3), with no card.
  - Memory: workers × `attemptMb` + epoch buffers + 512 MB, grown live with `docker update`.
  - CPUs: the number of workers, within what the machine has free.
- **Workers are hidden `Runtime`s.** `getRuntime(sessionId, '<root>~w<n>')`, with role `council` and a `pool` back-reference.
  - `ensureKernel` → `endpointForSession(…, 'council')` → `JupyterKernel.connect` gives each worker its own session in the council container. `ensureGuard` runs per worker.
  - **Seeding** is one line in `pump`, next to the guard: `if (runtime.pool) await ensureSeeded(runtime)`, a silent `load(…)` whose report comes back in `user_expressions`.
  - A hidden runtime writes nothing to the room document: about six early returns in `setStatus`, `syncQueue`, `resetAllCells`, `kernelNote`, the kernels map and activity.
- **Isolation per attempt is today's.** `runCouncilOne` runs unchanged on the worker. Its entry gains three inputs: the source (for the check), the run id (for the scratch folder) and the cap. Three executes per attempt, as today, each costing one tunnel round trip.
- **Recycling.** The worker restarts (`kernel.restart()`, which keeps the session) and reseeds silently when:
  - the entry was not ok, or the exit left threads or processes behind;
  - the run was still stuck after the second SIGINT;
  - the kernel restarted or died;
  - its private memory after an attempt is over `attemptMb`;
  - it has served 20 attempts (`COUNCIL_WORKER_REUSE`), which bounds leaked modules and `pip` drift;
  - the epoch changed. This one rolls: at most 2 workers reseed at once, idle ones first.
- **Sizing (`workers: 'auto'`).**
  - Start `min(4, auto)` workers at council open, in parallel with the export.
  - `auto = clamp(ceil(online students / 3), 2, min(16, fit))`, where `fit = (free − buffers − 512) / attemptMb`.
  - Grow by 2 every 5 s while the queue is longer than the idle workers. Shrink by 1 a minute, down to 2, after 3 min with an empty queue.
  - Stop the pool 15 min after the notebook's last council closes.
  - «Попыток одновременно: авто / N» accepts up to 32; N = class size means «по исполнителю на студента».

### 9.6 Dispatch: a router in front of unchanged pumps
New module `server/src/kernel/council-pool.ts`, with hooks in index.ts.
- **Which queue.** `requestCouncilRun` keeps its rules. Its first new line sends the attempt to the pool queue when all of these hold:
  - the cell's `lane` is `pool`;
  - the pool has a seeded worker of a usable epoch;
  - the epoch has no CUDA;
  - the pool's machine is reachable.

  Otherwise the attempt joins today's notebook FIFO, untouched.
- **Assignment.** `assign(pool)` moves the head attempt into an idle worker's own queue (never more than one) and calls `pump(worker)`. The teacher's runs (`by: 'host'`) go ahead of authors' (D12).
- **What the queue helpers learn.**
  - `councilQueuePosition` (index.ts:4026) also looks in the pool queue and counts only attempts ahead, never teacher cells.
  - `cancelCouncilRun` (:3925) and `purgeCouncilRunsOf` (:3952) search the pool queue and the workers; a ban interrupts the worker running that person's attempt.
  - `retimeCouncilRun` (:4316) re-arms the limit on the worker running the job.
- **Limits and controls.**
  - Each worker has its own `RunLimit`. A stuck worker is recycled, never "restart the notebook kernel".
  - The console's interrupt reaches the worker. A restart of the notebook kernel leaves the pool alone, and the console says so.
- **Visibility.** `kernelWorkOf` (:4103) adds `pool`. `busyOf` (:2508) and `stopBlocker` (:2625) see busy workers, so an owner's stop still refuses unless forced. The idle sweep counts a busy worker as class work.

### 9.7 What an attempt sees and writes (D10)
- **Variables.** The epoch's carried names, plus modules re-imported by name. Not the cells the teacher ran after the epoch; the card names the epoch's time.
- **Randomness and process state.** The epoch's, so identical attempts print identical numbers in every worker.
- **Files.**
  - The class folder copy is mounted read-only at `/workspace/<id>`, synced at the barrier before the attempt, exactly as for a cell.
  - The attempt's working folder is `/colloq/scratch/<runId>`. It holds a skeleton of the class tree: real folders, with files as symlinks into the read-only mount; at most 2000 entries, else the top level only.
  - So `open('data.csv')` reads the class file, while `to_csv('out.csv')` and `savefig('fig.png')`, subfolders included, write into the scratch folder. Overwriting a class file fails with `Read-only file system`.
- **Artifacts.**
  - `leave` lists the new regular files in the scratch folder.
  - Home asks the agent to collect them (`collect`), and the agent PUTs at most 20 files, each up to 1 MB and 5 MB in all, to `DATA_DIR/council/artifacts/<attempt>/<runId>/`.
  - The card lists them for the author and the teachers. Larger files are named with their size and not brought.
  - The scratch folder is then removed.
- **`pip install` in an attempt** lands in the council container's user site, shared by its workers until they recycle. That is parity with the shared kernel, and the console names it.
- **Resources.**
  - About one CPU, with threads limited at seed, and a ceiling of `attemptMb`.
  - A `MemoryError` stays the author's.
  - `os._exit` and `exit()` are refused by the held guard, as today.
  - An OOM kill costs one attempt, never the class.

### 9.8 Outputs, marks, show, adopt
- **Outputs.** Unchanged. The worker's iopub feeds `CouncilOutputBuffer` at home (64 KB of text, 2 MB of data), frames go to `job.onChange` every 400 ms, then to `recordRun`, `council_attempts.run_json` and the fan-out. Attempts never touch Yjs.
- **New optional fields**, which old clients ignore:
  - `CouncilRun.epoch?`, `placed?: 'pool' | 'shared'` and `files?`;
  - `CouncilKernel.pool?` (protocol.ts:1887): `{where, workers, busy, queued, epoch: {seq, at, carried, left: {name, why}[], behind}}`.
- **✓/✗** (`setMark`, council.ts:821) and **show** (`setShown`, council.ts:871) are unchanged. When `behind > 0`, the badge's footnote names the epoch's time.
- **Adopt** (control.ts:5330) is unchanged. "And run" is an ordinary host run in the **main** kernel, on its live state, writing the shared folder: the only way an attempt changes shared state. When `behind > 0`, the console warns «ядро ушло вперёд на 3 ячейки после снимка — результат в тетради может отличаться».

### 9.9 Shared mode, always available
An attempt runs in today's notebook FIFO, unchanged, when any of these holds:
- the class's council is `shared`, or the cell's lane is;
- no machine is eligible;
- the pool is not ready yet, which is normal in the first 5–15 s after open;
- the export failed, the epoch holds CUDA, or it is over the caps;
- the attempt reads a left name;
- the pool's machine is unreachable or lost.

The card's footnote says which. If the pool is not ready within 60 s of the first attempt, the console says «пул не поднялся: …», with the machine's words.

### 9.10 Failures
- **The pool's machine is lost mid-attempt.** The attempt is re-run once (D15): at the head of another pool machine's queue, else in the shared kernel. The card notes «пересчитано в общем ядре: машина пропала», and the rerun pause is not charged.
- **The main kernel is lost or restarted.** The pool keeps its epoch and goes on: the independence the owner asked for.
- **A home restart.** Workers are re-attached by session path. A run that was mid-attempt becomes `ServerRestarted` through `settleGhostRun` (council.ts:254), and its worker is recycled. Epoch rows survive, so routing still knows the left names.

### 9.11 Numbers (estimates, replaced by R2)

| Quantity | Value |
|---|---|
| Export: a 500 MB numeric frame plus a fitted `LogisticRegression` | 1–3 s in the main kernel the first time; about 0.1–0.3 s for an unchanged refreeze |
| Shipping it home → machine at 4 MiB/s | about 2 min the first time, then only changed buffers; nothing when the main kernel is on the pool's machine |
| Worker memory | about 250–350 MB baseline plus the non-shareable structure plus the attempt; share 1024 MB |
| 8 workers, 500 MB numeric epoch | about 9 GB container, numeric buffers counted once |
| Overhead per attempt | 3 executes × one tunnel round trip (about 0.1 s) plus entry copies: about 0.3–0.6 s |
| 30 attempts of 2 s on 8 workers | about 8–10 s of wall time, against 60–75 s today |

### 9.12 Rejected
- **Replaying the teacher's cells** into each worker. It reruns side effects 30 times, diverges silently on randomness, time and downloads, and is undefined for interrupted or deleted cells.
- **A template process plus `fork()`** with an executor outside ipykernel. A second output path with its own fidelity, and fork safety against libgomp, torch and arrow threads; council-isolation.ts:24-26 already rejected fork. Copy-on-write mapped buffers give most of the memory win with stock kernels. Revisit only if R2 shows 16 workers over budget.
- **A container per attempt.** 3–5 s cold starts, about 250 MB per slot, Docker churn, and the attempt loop re-implemented on the agent.
- **A full reseed after every attempt.** Seconds per attempt, and it would throw away the proven guard, ceiling and process-state code.
- **Analysing attempt sources at home.** The server image has no Python: `python3` is only in the root Dockerfile's build stage.
- **A pool at home.** Deferred, not rejected; vsos has no room for it.

## 10. Personal notebooks on machines
- **The slot.** The `own` slot is placed like `room`: one container per class on one machine (D5, D6), holding every personal kernel of the class within `ownLimits` (pool.ts:167). It is placed when the class's setting says `own: 'machines'`.
- **Unchanged rules.**
  - `ensureKernel`'s ceiling (index.ts:1499-1510) counts the class's live personal kernels across home and machine, against `ownMax` (60).
  - `ownIdleMin` (30) retires scopes, and `dropOwnIfEmpty` (index.ts:2083) becomes a durable stop.
  - No GPU, by construction.
  - The known weakness of one shared `JUPYTER_TOKEN` inside `-own` (SECURITY.md «Out of scope», first item) is the same on a machine.
- **Mixed placement is first-class.** With `own` on a machine and `room` at home (vsos's default), the room's kernel reads home's disk and the personal kernels read the machine's copy; the barrier and the scans keep them one folder. With `room` on A and `own` on B there are two copies, each synced with home.
- **The cost.** Forty students at 300–500 MB each is 12–20 GB, which one 32–64 GB machine holds. Per-notebook containers (their own token and cgroup) come later, with soft reservations (D6).
- **Failover** is per slot, and a lost machine's personal kernels come back at their next Run.
- **As built** (K8, wave 4; F4). The room's words for a class whose personal notebooks alone are on the machine are their own: «Нет связи с машиной личных тетрадей · 0:12…», «Машина личных тетрадей не отвечает с 14:32:05. Их ядра поднимутся заново…», «Ядра личных тетрадей подняты на другой машине.», and the class notebook's log hears none of the class notebook's sentences for them. Besides (§20.13):
  - **The ceiling** counts the class's personal kernels that are up or coming up (`holdsOwnPlace`), here as on a machine, whether the machine answers now or not, and none ended from outside; the look and the mark of a start are one synchronous stretch, so four pressed at once against a ceiling of three refuse exactly one, in the existing words.
  - **The container's stop.** `dropOwnIfEmpty` of a slot on a machine is the durable stop of that placement at its gen (`stopSlot` → `ClassPlacements#stopAt`): only a notebook with a Python there, coming, or work waiting for one keeps it (`keepsOwnContainer`), and only a placement some personal kernel of the class came up on in this process is stopped (`ownPlacementsUsed`), whichever notebook retires last; a warm start nobody used stays for the Run it was made for.
  - **Idle retirement** waits for a road that is down only while the kernel's placement is still the slot's live one; a kernel whose placement went is retired and let go of without a `DELETE`. And a placement stopped under kernels by nobody here (a refused ready echo, a start its machine kept failing) ends them there and then (`endUnderStop`, F4): «Ядра личных тетрадей на машине остановлены: следующий запуск поднимет их заново, переменные пропали.» (the class notebooks' «Ядро на машине остановлено: …»), once for the slot, with no `DELETE`, and their places under the ceiling come back at once.
  - **The warm start** goes through `warmSlot` only when the class says `own: 'machines'` and its rules allow a personal notebook (`ownBooks: 'on'`, or a notebook given to its owner): a lecture pays for no container it cannot use.
  - **The own container's limits** follow `ownLimits` (memory, cores, `KERNEL_OWN_PIDS`), asked of the machine's ledger, and the contract refuses a card for the `own` slot: an agent handed one anyway runs no `--gpus`.
  - **Bounds** of the class's numbers, and of the personal notebooks' own, by where each slot computes (§6.2).

## 11. Failover and fencing

### 11.1 Detection
Placements are checked in a `classTick` called from liveness.ts's 5 s `remoteTick` (:74). While any class placement lives, home probes itself every 5 s (`CLASS_PROBE_MS`, against 30 s for leases), and evidence counts for 15 s (`CLASS_EVIDENCE_MS`).

| Signal | What home does |
|---|---|
| Tunnel down, syncs arriving | `unreachable`: the chip turns amber, and the reply says `tunnel: 'reconnect'`. After 120 s (`CLASS_TUNNEL_STUCK_MS`) home fails over, because the class cannot compute |
| Tunnel down and no sync: `provenSilence` ≥ the class's `failoverSec` (60 s), outside the boot grace (`REMOTE_BOOT_GRACE_MS` 180 s) and outside a `bye{restart}` grace (120 s) | `lost` → failover, unless the class says «ждать машину» |
| The same without path evidence | Nothing. Home's own road is down, so nobody can reach the class anyway |
| The machine reports the container gone or broken | Recreate on the **same** machine: a fresh Python, the same gen, today's death words. Not a failover |
| Revoke, «Не принимает занятия», `leave`, a perimeter that fails closed | Immediate failover, with the reason |
| «Перенести сейчас» (staff, after 10 s unreachable; on a reachable machine «Перенести на сервер» with a confirmation) | Immediate failover |

**As built** (K5a1, SD, F; §20.4):
- Which rule moves a slot is decided per outage (`outageRule`): `tunnel` only when the machine was heard after this life saw the tunnel go, and within 15 s (`SYNCS_COMING_MS` = `CLASS_EVIDENCE_MS`: a machine holding placements is held at most 10 s a sync, so a live one is heard well inside it); `silence` after 15 s with nothing heard, or right after a `bye`; otherwise not known yet, and no time is promised (`failoverAt` null). The stuck tunnel's 120 s count from the later of the tunnel going down and the start of the machine's current run of reports (`streakAt`), so the path coming back after an outage of home's own road is no stuck tunnel.
- Staff are told without a time first, then with the time once the rule is known, and again whenever it changes (a stuck tunnel whose syncs then stop too); «не отвечает с» counts from `PlacementView.quietSince`, the machine's last word for a silence. The first `unreachable` event after `bye: 'restart'` carries `cause: 'updating'`.
- «ждать машину» also suspends the stuck-tunnel failover.
- «Перенести сейчас» is the room's `kernel:move {root?}` (staff); «Перенести на сервер» is the owner's «Перенести занятия» on the machine's row (`POST /api/admin/runners/:id/classes/move`, every live slot). Off a machine that answers, the move first waits up to 10 s for the class's files. Neither lands on this server for certain: the next start only keeps away from the machine it left (30 min, `AVOID_MS`) and takes another eligible machine if there is one, so no sentence says «на этом сервере» at the moment of the loss (F3).
- The machine reporting a container gone is recreated there by the agent itself, at the same gen (§7.2).
- A cut of only the machine's leg — the relay lit, home's probe through it passing, the machine's syncs gone with its tunnel — is a proven silence: the class fails over after its `failoverSec`, before jupyter_server's own ping timeout would close the inner channel; an outage of the whole relay proves nothing and keeps the class (K13 writes both into the parity job, §17.3).

### 11.2 Sequence
1. One transaction marks the row `lost` with its cause. From that moment the listener is closed and the upload doors answer 409.
2. For each runtime of the slot, `endFromOutside('lost', words)` (§5.2) ends the kernel. The room reads:
   > «Машина «vast-3» не отвечает с 14:32:05. Ядро поднимется заново: переменные пропали, файлы — по 14:31:58. Запустите ячейки снова.»

   As built, that is staff's sentence (the `kernel:machine` note, the owner's log); the room's document reads it without the name («Машина не отвечает с 14:32:05. Ядро поднимется заново: …»), and a class whose personal notebooks alone moved hears «Машина личных тетрадей не отвечает с 14:32:05. Их ядра поднимутся заново: …». Status after a failover is `off`, not `dead`: nothing is raised again until the next Run.
3. The queue is dropped with «Очередь сброшена: ячейки рассчитывали на переменные, которых больше нет» (D14). The running cell gets «Эта ячейка выполнялась на машине «vast-3», когда та пропала. Неизвестно, успела ли она закончиться; на новом ядре её нет».
4. The next `ensureKernel` detaches the dead kernel. `endpointForSession` places again with `gen + 1`: on another eligible machine, else at home through the Docker path and its admission (`fallback`), else a refusal with words. As built, the room is told where once the kernel runs again: «Ядро поднято на другой машине.» (`28c860`; personal notebooks `3d0553`), or here the fallback note «Ни одна машина сейчас не может взять ядро — оно поднимается на этом сервере.»; refused for memory here after a move, it reads the «No room at failover» words with the numbers.
5. The terminal sees a new identity («ядро класса заменено»), and its pty is new.
6. A lost council slot re-places its pool or falls back to shared (§9.10).

### 11.3 A returning machine
Its first sync lists the old gen, and home's reply omits it. The agent reports the paths it changed after the fence (§8.8), then removes the container and the folder copy. Its late PUTs and readings get 409.

### 11.4 Restarts and updates
- **Home restart.** Placements are in SQLite, and agents keep their containers. The boot grace blocks failover while tunnels reconnect. `ensureKernel` re-attaches by session path, so the variables survive. File state is rebuilt from the agents' `full` reports.
- **Agent `kill -9`.** The containers are adopted, and the tunnel is back within seconds. Streams reset unless K3b resumes them; §5.5 settles at most the running cell. As built, an agent restart is a new tunnel life, so its streams always reset (K3b resumes only the same agent's), and the kernel client's reconnect and §5.5 settle what they carried; scenario D.18 keeps `x` and the pty across it.
- **`runner update`** (D23). `bye{restart}` holds failover for 120 s while the update pulls first, drains, then restarts the agent (colloq-host:1535-1600). As built, the drain counts leases only (`held` is the attempts held): class containers keep running through it, and the draining machine takes no new placement. A home restart loses the queue, which lives in memory, as at home.

### 11.5 Owner actions
- `revokeRunner` and `untrustRunner` (release.ts:445/498) gain a sibling, `unclassRunner`.
  - Revoke and unclass fail every placement of the machine over **first**.
  - Then they cut its `room` and `epoch` blob streams (`cutBlobStreams`) and answer `placements: []` (unclass) or 401 (revoke).
  - The agent's 401 path removes class containers, folder copies, epochs, scratch folders and artifacts.
- `colloq-host runner leave` on a machine with classes asks first: «на машине 2 занятия: уход перенесёт их на сервер, переменные пропадут (--force)».

As built (K5b, K9a, K10): revoke fails the machine's placements over, marks it revoked, cuts every blob stream to it and closes its tunnel with 4401 at once. Unclass (`unclassRunner`, the panel's «Не принимать занятия») fails them over first, then turns the flag off and sets `classes_winding_down` on the row, writes `unclassed` with how many moved, closes the tunnel with 4403 and wakes the held sync; every reply then says to hold nothing until a sync of the machine lists no class container (the panel reads «убирает занятия: ждём, пока машина остановит их ядра»), and the wind-down survives restarts of both sides. A block listing class containers from a machine without classes starts the same wind-down. A leave fails over with the cause `leaving` when the machine's leaving sync revokes it, after its drain. As built (F4), neither moves a class before its files: the owner's unclass waits, through the PATCH, for every class of the machine to settle (`settleRunner`, up to 10 s each, at once) while the machine still answers; the agent's leave scans every class copy once its runs are done, says what it found, uploads what home pulls, and only then — or at 10 s — sends the sync that says `leaving` (`settleForLeave`). A revoke waits for nothing. `colloq-host runner leave` exits 3 (`LEAVE_HOLDS_CLASSES`) with the question in English, as all its messages are; `--force` says yes, and `make runners-down` answers it, having asked already. The owner's doors: `PATCH /api/admin/runners/:id {classes}` (a trust and classes pair refused in words before any write) and `POST /api/admin/runners/:id/classes/resume|move`.

### 11.6 Class quarantine (D32)
Two silence failovers on one machine within 30 min set `classes_quarantined_at`. The machine takes no new placements, and the owner sees a banner with «Вернуть», which sets `classes_resumed_at`. Submissions are unaffected. The counter is separate from the 0.23 submission quarantine and counts events, not placements.

As built: one `class_failover` line per outage (causes `silence` and `tunnel`; an outage is the stretch with the tunnel down, and a home restart in the middle of one starts another), counted with `runnerEventsOf(id, ['class_failover'], max(now − 30 min, classesResumedAt))`; moves by hand never count. «Вернуть» on the banner and «Вернуть занятиям» in the machine's menu are `POST …/classes/resume`: `resumeRunnerClasses`, a `classes_resumed` line, and a wake.

### 11.7 Failure table

| Failure | Detected by | Kernel | Queue | Files | Council | Words |
|---|---|---|---|---|---|---|
| Relay blip under 25 s | the tunnel closes or pings stop (as built: 12 s without a frame, `TUNNEL_QUIET_MS`) | untouched | waits at the gate | waits | workers untouched | chip amber; a note only after 10 s (as built: counted from the last frame, so a black hole's note comes as the chip turns) |
| Tunnel cut, syncs flowing | tunnel down, syncs heard | untouched; failover after 120 s | waits | waits | waits | «Нет связи с машиной…» |
| Machine destroyed | silence on both channels, with evidence | failover at 60 s, fresh kernel | dropped | as of the last sync; «на машине» files named | running attempts re-run once; the pool re-places or falls back | the failover note |
| Agent `kill -9` | the tunnel closes, then returns | adopted; reconnect and replay; §5.5 | waits seconds | baseline on disk | workers re-attached | none, or the lost-result line for the running cell |
| `docker kill colloq-runner` (a manual stop, 0.23 note 48) | silence | failover at 60 s | dropped | as above | as above | as above |
| `runner update` | `bye{restart}` | adopted | waits up to 120 s | intact | continues | «агент на машине обновляется» after 10 s |
| Home restart | boot | re-attached by session path | lost (it lives in memory), as today | rebuilt from full reports | ghost runs → `ServerRestarted` | today's «Reconnected» note |
| One of two machines partitioned | silence plus the other's evidence | only that machine's placements fail over | dropped | as of the last sync | as above | per room |
| Home's own leg down | no evidence | nothing fails over | waits | waits | waits | nobody can reach the class anyway |
| Revoke, unclass, leave | owner action | immediate failover | dropped | late writes refused | as above | the owner's reason |
| Container gone or broken | agent report | recreated on the same machine | dropped (a death) | intact | the pool reseeds | post-mortem words |
| Perimeter rules gone | the 60 s re-check | reinstalled; after 3 failures stopped, then failover | dropped | as of the last sync | slot stopped | the fail-closed note and banner |
| Machine disk full | ENOSPC on a push | untouched | the barrier refuses after 30 s with no progress | kernel writes still come home | new slots refused | the barrier words |
| No room at home at failover | admission | another machine, else none | — | — | — | «На сервере нет места…» |
| Stolen machine secret | the tunnel replaced from another address | — | — | — | — | event; banner at more than 3 replacements in 10 min |

## 12. Security and trust

**What a class machine sees.** Every cell and the class folder, personal notebooks, attempts the teacher has not shown, outputs, the terminal, process memory (including any token pasted into a cell) and epochs, which are the teacher's data. There is no "open half", unlike submissions.

**What it never sees.** `SESSION_SECRET`, other classes, the database, staff cookies, `OPENAI_API_KEY` and `RELAY_TOKEN`.

| Threat | Gains | Limited by |
|---|---|---|
| A stolen class machine secret | The data of the rooms placed there; forged outputs and files inside those rooms only, at their current gen | «Принимает занятия» off by default and owner-only; revocation fails over at once; `tunnel_replaced` events and the banner; the events log; file caps and validation |
| A container escape on a class machine | That host: its rooms, CAS, cards and the agent's secret | No hidden test beside classes (D3, `machineFit` gains `classes`); one ephemeral VM per term; purge on revoke; `make runners-down` |
| The Vast host operator | Everything on the VM | The owner's choice per machine |
| Root on relay2, or anyone holding `RELAY_TOKEN` | Already reads students' traffic, since TLS ends there; now kernel traffic too | D27 (0.23 decision 4) |
| A student with an open cell in the main kernel | Can monkeypatch the export, just as they can monkeypatch the shared kernel today to watch attempts | Parity. The export folder sits in the producing container's `/tmp`, out of reach of personal kernels and attempts; epochs are read-only to workers |

**Kept invariants.**
- The kernel's environment is exactly the six variables (pool.ts:1234-1273) plus the class's `PYTHONHASHSEED`, held by the argv parity test.
- Jupyter is published on 127.0.0.1 only, so Vast VMs' public IPs never see port 8888. Its `allow_origin='*'` and XSRF settings (kernel/Dockerfile:95-96) are reached only through the agent.
- The tunnel opens only streams home starts, to ports from the agent's own records.
- The perimeter is home's, with home's mode as the floor (D21). Rootless Docker and nftables-only daemons (the helper exits 20 or 21) and `open` machines are refused, with words. It is re-checked every 60 s and fails closed. As built, an `open` machine is not refused: `open` never applies on a machine (an open home sends `blocked`, a machine's own `open` is ignored, and the stricter of the two modes wins, `machinePerimeterPlan`), and home's blocked ranges travel with every intent; with more than 64 of them (`REMOTE_BLOCKED_CIDRS_MAX`) live placements fail over (`blocked`) rather than run behind a cut list, and an invalid entry keeps new placements away.
- No agent state is mounted into class containers: only `rooms/<id>` read-write for room and own, and the class folder read-only, epochs read-only and scratch read-write for the council.
- The admission canary passes before a machine is eligible.
- Students' internet traffic leaves from the machine owner's IP, and the guard does not cover the terminal, as at home. The join dialog says so.

## 13. UI and words (Paper page «18 · Занятия на машинах»)

### 13.1 Artboards to draw
The page is drawn before any UI code, as page 16 was for 0.23. Pages 15–17 exist (G1–G4, M1–M7, N1–N3), so this page is 18, with artboards Z1–Z10. Every screen also works at phone width (Z10). The console follows the app's theme, so Z8 is drawn light and dark.

1. **Z1 · Ресурсы · «Машины» · посылки и занятия · владелец** (1440).
   - The 0.23 block «Машины для посылок» becomes «Машины», and each row shows the chips «посылки» and «занятия».
   - A class machine's line: «Занятия: 3 класса · 22 из 60 ГБ · карта 0 занята классом · связь 48 мс (p95 80)».
   - The row menu gains «Принимает занятия» (with its warning) and «Перенести занятия».
   - Readiness lines: «образ ↓ 45 %», «нужен --network host — перезапустите машину командой из панели», «периметр: у Docker нет iptables», «на этой машине стоит сервер Colloq — занятия нельзя».
   - The quarantine banner: «vast-3 дважды пропадала за 30 минут — занятия на неё не отправляются · Вернуть».
   - The owner's settings: «Учителя отправляют занятия на машины», «Новые занятия по умолчанию», «Переезд через: 60 с», «Файл с машины — до 200 МБ», «Файлы занятий: 4 МБ/с», «Раздача посылок во время занятий: 2 МБ/с».
2. **Z2 · Подключить машину · «Принимать занятия»** (1100). The 0.23 dialog gains the checkbox «Принимать занятия — машина увидит код, данные, файлы и личные тетради студентов». «Доверить скрытый тест» is greyed while it is on, with the reason (D3).
3. **Z3 · Машина · карточка · занятия** (1440).
   - Per class on the machine: slots, memory, CPU, link, files lag.
   - Recent events, such as «перенесено на сервер 14:33 (не отвечала 60 с)» and «связь перехвачена с адреса 5.6.7.8».
   - «Перенести занятия».
4. **Z4 · Занятие · Ресурсы · «Где считается»** (1240).
   - Presets on top.
   - Three rows, «Тетради класса», «Личные тетради» and «Консилиум», each with «Здесь / На машинах» («В общем ядре / На машинах» for the council).
   - «Если машин нет — здесь»; «Если машина пропала: перенести через 60 с / ждать машину»; «Попыток одновременно: авто / N»; «Память на попытку: 1 ГБ».
   - The live line: «Подходят: vast-3 (свободно 41 ГБ · 4090), lab-2 (18 ГБ) · далеко: +140 мс на ячейку».
   - The refusals: «Среда собрана на этом сервере — на машинах её нет», «Нужна видеокарта: на машине с картой», «Машины не принимают занятия — Ресурсы → Машины».
   - As built in 0.25.0 (F4): two rows, «Тетради класса» and «Личные тетради»; the «Консилиум» row and its two numbers come with the pool (`COUNCIL_POOL`), and the second tile reads «Личные тетради — на машинах». Under the numbers, the machines' line («На машинах — память до 61,8 ГБ, ядер до 31: больше не даст самая большая из них, «vast-3».», K8), drawn from the seminar's `bounds`.
5. **Z5 · Комната · ядро на машине** (1240).
   - The chip: staff see «Ядро · vast-3 · 52 мс», students «Ядро на машине»; then amber «Нет связи с машиной · 0:23», «Переносим на сервер…», «На сервере · переехало в 14:33». As built (F4), the moving chip reads «Переносим ядро…»: the next start decides where it lands, another machine as much as this server.
   - As built (F4): while a slot starts slowly on its machine, staff read the server's own sentence above the notebook («Запускаем ядро на машине «vast-3»… образ ↓ 45 %», `data-machine-starting`); before, it reached their session and was never drawn.
   - The kernel-log notes of §13.2.
   - A waiting cell's «ждёт машину», and a cell's «файлы едут на машину: 12 из 150 МБ».
   - The staff banner with «Перенести сейчас» and «Ждать машину»; the restart refusal.
6. **Z6 · Файлы · что на машине** (1240, and on the phone).
   - «С машины едут 2 файла · 40 %».
   - «model.pt · на машине · 2,1 ГБ · Привезти».
   - A collapsed «пакеты (pip -t) — на машине, 2,1 ГБ».
   - A conflict copy, «data (с машины 14-32).csv», with its note.
   - As built (F4): a «на машине» row's Delete removes the file on the machine (§8.5); a row the proxy in front of the server refused reads «{name} ({size}) остаётся на машине: прокси перед сервером не принимает файлы такого размера. …».
7. **Z7 · «Работают сейчас» · занятия на машинах** (1440).
   - A class row with sub-rows «класс · личные · консилиум», each «на vast-3 · 3,1 из 8 ГБ · 12 % ЦП · файлы: синхронно / ↑ 3, 12 МБ / 2 только на машине».
   - The budget bar «0 МБ здесь».
   - Stop on an unreachable machine says «остановится, когда машина выйдет на связь».
8. **Z8 · Пульт · консилиум на машинах** (900×700, light and dark).
   - The regulation sentence gains «попытки — отдельно, 8 одновременно · состояние следует за ядром».
   - The «Регламент» sheet gains two rows: «Попытки считаются» and «Состояние для попыток».
   - The pool strip: «8 готовы · 12 считают · 5 ждут · vast-3 · состояние 14:05 · Обновить».
   - The «Не переносится: …» line; «снимок состояния» in the queue strip; «исполнитель перезапущен»; the adopt warning.
9. **Z9 · Карточка попытки · где посчитана** (1240: the student's sheet and the console's work view).
   - Footnotes: «посчитано отдельно · состояние 14:05», «состояние 14:05 — без ячеек 8–9», «в общем ядре: использует conn», «пересчитано в общем ядре: машина пропала».
   - «файлы попытки: out.csv 12 КБ, fig.png 40 КБ»; «попытке не хватило памяти (предел 1 ГБ)».
10. **Z10 · Телефон** (390). Z1's row, Z4's form, Z5's chip and banner, Z6's rows, Z8's strip and Z9's footnotes at phone width.

**Data path.**
- Kernels-map entries gain `where: 'machine' | null`, `link: 'ok' | 'lost' | 'moving'` and `linkSince`. Old tabs ignore unknown fields, and `KernelStatus` (notebook.ts:317) stays closed.
- Machine names reach staff only, over the control socket. Students see «на машине».
- As built (K5a2, K9a, F3): staff get `{t: 'kernel:machine', role, machine, note?}` frames, which the session keeps by role (`web/src/lib/kernel-machines.ts`) and clears on reconnect; the chip reads them (Z5) and the banner shows the frame's note, the server's waiting sentence. Every sentence the room's document gets is the unnamed variant (`server.ts` keeps both), a start error that names the machine is replaced in the room by «Ядро не запустилось на машине — подробности у преподавателя.», and the document never holds a machine's name (scenario A.1 checks it).

### 13.2 Words
This table is the locale source. ru and en go into shared/locales: `server.ts` for notes the server writes, `room.ts` for the room and the console, `admin.ts` for the panel. Kernel notes follow the «Ядро …» style.

As built, the rows below are spelled as the code writes them (tests/remote-kernels-contract.test.mts holds the server's rows word for word). A sentence that names the machine goes to staff only — the `kernel:machine` frame's note, the owner's log — and the room's document gets the same sentence without the name (`server.ts` keeps both: «Нет связи с машиной · 0:12. …», «Машина не отвечает с 14:32:05. Ядро поднимется заново: …», «Эта ячейка выполнялась на машине, когда та пропала. …», «Владелец отключил машину.»); a class whose personal notebooks alone are on the machine has sentences of its own («Нет связи с машиной личных тетрадей · 0:12. …»). No sentence says where a kernel comes back before it does (F, F3).

| Event | Text (ru) | Who |
|---|---|---|
| Unreachable for 10 s | «Нет связи с машиной «vast-3» · 0:12. Ядро и переменные на ней целы — ждём связь. Новые запуски подождут.» | staff (the room without the name), chip |
| Waiting (staff) | «Машина «vast-3» не отвечает с 14:32:05. Ждём до 14:33:05, потом поднимем ядро заново (переменные пропадут).» + «Перенести сейчас» / «Ждать машину»; under «ждать машину»: «Машина «vast-3» не отвечает с 14:32:05. Ждём её: ядро переедет только по «Перенести сейчас».» | staff |
| Agent updating | «Агент на машине «vast-3» обновляется. Ядро и переменные на ней целы — новые запуски подождут.» | staff (the room without the name) |
| Back | «Связь с машиной «vast-3» вернулась через 37 с.» | staff; the room «Связь с машиной вернулась через 37 с.», only if the first note went out |
| A reply lost in a reset | «Связь с машиной прервалась — результат ячейки потерян. Ядро и переменные целы; запустите ячейку снова.» | the cell |
| Failover | «Машина «vast-3» не отвечает с 14:32:05. Ядро поднимется заново: переменные пропали, файлы — по 14:31:58. Запустите ячейки снова.» | staff, owner log (the room without the name) |
| Came back | «Ядро поднято на другой машине.» / «Ни одна машина сейчас не может взять ядро — оно поднимается на этом сервере.» | room |
| Running cell at failover | «Эта ячейка выполнялась на машине «vast-3», когда та пропала. Неизвестно, успела ли она закончиться; на новом ядре её нет.» | the cell (without the name) |
| Queue dropped | «Очередь сброшена: ячейки рассчитывали на переменные, которых больше нет.» | room |
| Restart refused | «Нет связи с машиной «vast-3» — перезапуск сейчас не дойдёт. Нажмите, когда связь вернётся.» | the person who pressed (the button's own words: «Нет связи с машиной — перезапуск сейчас не дойдёт. …», room.ts) |
| Restart, answer lost | «Перезапуск отправлен, но ответа нет: связь с машиной прервалась. Узнаем, когда она вернётся.» → «Перезапуск прошёл: переменные сброшены.» or «Перезапуск не дошёл — переменные на месте.» | room |
| Interrupt refused | «Нет связи с машиной — остановить ячейку сейчас нельзя. Предел времени сработает, когда связь вернётся.» | the person who pressed |
| Revoke / unclass / leave | «Владелец отключил машину «vast-3».» / «Машине «vast-3» больше не доверено вести занятия.» / «Машину «vast-3» отключают.» + «Ядро поднимется заново, переменные пропали.» | staff, owner (the room without the name) |
| Perimeter fails closed | «Сеть на машине «vast-3» вышла из-под контроля: ядро остановлено ради безопасности и поднимется заново.» | staff (the room without the name), owner banner |
| No room at failover | «На сервере нет места для ядра этого занятия: занято 14 из 15 ГБ. Освободите память или подключите машину.» | room, teacher |
| Late writes | «Машина «vast-3» вернулась после переезда; её изменения в файлах после 14:32 не приняты: out.csv, model.pt.» | owner; the room without the name, only for a gen the class lost there |
| Stopped with late writes | «Ядра на машине остановлены; изменения в файлах, которые не успели доехать до сервера, отброшены: out.csv, model.pt.» | room |
| Conflict | «data.csv изменили одновременно здесь и на машине. Оставлена версия сервера, версия с машины — «data (с машины 14-32).csv».» | files panel, staff |
| Delete wins | «old.csv удалён на сервере; изменения, сделанные в нём на машине, отброшены.» | files panel |
| Over a cap | «model.pt (2,1 ГБ) больше предела 200 МБ и остаётся на машине. Если машина пропадёт, файл пропадёт тоже.» · «Привезти» | files panel, kernel log once |
| Refused by the proxy (F4) | «model.pt (150 МБ) остаётся на машине: прокси перед этим сервером не принял файл такого размера. Если машина пропадёт, файл пропадёт тоже.»; «Привезти» refused: «model.pt не привезти: прокси перед этим сервером не принимает файлы такого размера. Предел поднимает его администратор.» | kernel log once; the person who pressed |
| Stopped under its kernels (F4) | «Ядро на машине остановлено: следующий запуск поднимет его заново, переменные пропали.» (personal notebooks: «Ядра личных тетрадей на машине остановлены: следующий запуск поднимет их заново, переменные пропали.») | room |
| A class's number past its place (K8) | «На машинах, где считается это занятие, памяти можно выдать от 512 до 63 232 МБ: больше не даст самая большая из них, «vast-3».» (cores: «…ядер можно выдать от 1 до 31: больше нет у самой большой из них, «vast-3».»); a class set to machines whose number this server cannot give: «На этом сервере занятию можно выдать от 512 до 15 360 МБ памяти: больше не останется самому серверу.» (cores: «На этом сервере ядер занятию можно выдать от 1 до 8: больше у него нет.»); a class all here hears today's words | the class's form (PATCH, creation) |
| A move past the class's number (K8) | «Памяти у занятия — 24 576 МБ: уменьшите её, прежде чем менять, где оно считается.» / «Ядер у занятия — 16: уменьшите их число, прежде чем менять, где оно считается.», each followed by the new place's bound | the class's form |
| No fallback past this server (K8) | «Ни одна машина сейчас не может взять ядро, а этот сервер даст не больше 15 360 МБ памяти — у занятия 24 576 МБ. Уменьшите память занятия или дождитесь машины.» (cores: «…а ядер этот сервер даст не больше 8 — у занятия 16. …») | room |
| The machines' bound (K8) | «На машинах — память до 61,8 ГБ, ядер до 31: больше не даст самая большая из них, «vast-3».» (one number: «На машинах — память до 61,8 ГБ: …», «На машинах — ядер до 31: …»; two machines: «…память до 61,8 ГБ («vast-3»), ядер до 63 («lab-2»): больше не даёт ни одна из них.») | the class's form (admin.ts) |
| Barrier | «Файлы едут на машину: 12 из 150 МБ…» / «Файлы не дошли до машины: 30 с без движения — ячейка не запущена.» | the cell |
| Slow start | «Запускаем ядро на машине «vast-3»… образ ↓ 45 %» | staff (the room «Запускаем ядро на машине…») |
| Memory raise not applied | «Новый предел памяти не дошёл до работающего ядра — ядро получит его при следующем запуске.» | room |
| Hover while unreachable | «Нет связи с машиной ядра — справка появится, когда она ответит» | the editor (room.ts) |
| Quarantine | «Машина «vast-3» дважды пропадала за 30 минут — занятия на неё больше не отправляются.» · «Вернуть» | owner banner (admin.ts) |
| Tunnel replaced | «Связь машины «vast-3» за 10 минут 4 раза перехватывали с разных адресов: 5.6.7.8, 9.10.11.12. Проверьте, не утёк ли её ключ.» | owner banner (admin.ts) |
| Pool not ready (0.26.0) | «Пул ещё поднимается — эта попытка посчитана в общем ядре.» | card |
| Left names (0.26.0) | «Не переносится: conn (соединение с базой), batches (генератор).» | console |
| Rerouted (0.26.0) | «Посчитано в общем ядре: использует conn — её нельзя перенести.» | card |
| Older epoch (0.26.0) | «Состояние 14:05 — без ячеек 8–9.» (one cell: «Состояние 14:05 — без ячейки 8.») | card |
| Adopt behind (0.26.0) | «Ядро ушло вперёд на 3 ячейки после снимка — результат в тетради может отличаться.» | console |
| Lost mid-attempt (0.26.0) | «Машина пропала посреди попытки — пересчитано в общем ядре. Пауза между запусками не засчитана.» | card |
| Hash seed (0.26.0) | «Порядок множеств в попытках может отличаться от тетради: её ядро запущено до обновления.» | console, once |

## 14. Packaging and deploy
- **The same image and agent.** `colloq-host run_runner` (deploy/vast/colloq-host:1275) adds `--network host`. The `colloq.config` sum changes, so `runner up` or `runner update` replaces the agent container while class containers keep running. `runnerJoinCommands` and `colloq-host runner_code` (:1760) stay byte-equal, both with `--network host` and `--stop-timeout 90`.
- **Codes.** `colloq-host runner-code --classes` (ops/runner-code.ts) and the panel's «Принимать занятия» set `remote_runner_codes.classes`. A code with classes cannot also carry «доверенная» (D3). `make vast-runner CODE=…` needs nothing new, since the code carries the flag.
- **`runner up` with classes** checks first: rootful Docker with iptables, cgroup v2, no colloq instance on this daemon (refused, D20), and the disk floor (the 0.23 40/120 GB plus class folders). As built, "with classes" is an explicit `--classes`, which the panel's bare command for a classes code ends with: the code is opaque, and a machine learns its flag only after joining (`make vast-runner` and the Vast on-start pass none, and skip the check). It asks for a `DOCKER-USER` chain (none means `"iptables": false`, the nftables backend or no iptables), a daemon that is not rootless, cgroup v2, no Colloq container, rooms or rooms' network on this Docker, and 20 GB for the class folders (`CLASS_DISK_GB`) on top of the floor, 5 % short of it still passing; every problem is named before anything is written, pulled or started.
- **`runner update`** writes `<state>/restart.marker` before it stops the agent, which makes the final sync say `bye: 'restart'`. It refuses before stopping anything when the new tunnel protocol differs from home's. As built: the marker is written before every stop colloq-host makes of a running agent and removed after it; the protocol check runs only while class containers exist, reads the new image's protocol from its entry point (`TUNNEL_PROTOCOL=` in entrypoint.sh, held equal to `shared/remote-tunnel.ts` by a test) and takes the running agent's as home's, and lets the update through when the new image is the release home runs. The update drains first, through the agent's own `colloq-vast runner drain` (colloq-host has no `runner drain`), which counts leases only (`held`, the attempts held), so class containers run through it uncounted.
- **`runner leave`** asks before moving classes (§11.5). **`runner status`** gains `tunnel: up / down · RTT` and `classes: {room, own, council}`. As built: the leave exits 3 with its question (`--force` answers it); the status keeps stdout the agent's JSON line, now with `tunnel {up, rttMs} | null` and `classes {room, own, council}`, and writes `tunnel: up · RTT 48 ms` and `classes: room 1 · own 1 · council 0` to stderr, with a warning when an agent that reports classes runs off the host's network. `class_count` and the leave's question count this tree's agent's containers only, by its instance label.
- **The move from 0.24** (K10). A machine's first update to 0.25 is run by its colloq-host of before, which installs the new colloq-host only at its end, so the agent comes back still on Docker's bridge: it takes submissions and no classes, and `runner status` warns. A second `colloq-host runner update` moves it; `make runners-update` makes that second update by itself (the fleet survey's `off_host` verdict, `NETWORK_SCRIPT`), and a Vast VM's on-start fixes it on the next boot (it installs the image's colloq-host, and the settings' fingerprint counts the network). Agents from before classes are never `off_host`.
- **State.** `<state>/rooms/`, `<state>/placements/`, `<state>/council/` and `restart.marker` are new, all under the dedicated state dir and its system-root refusals (0.23 note 23).
- **Fleet.** `make runners-update` keeps classes alive (adoption). `make runners-down` fails classes over before destroying, through leave.
- **Docs.**
  - docs/pages/{ru,en}/runners.html gains «Занятия на машинах», which removes «They do not run room kernels» (runners.html:49).
  - council.html gains «Консилиум на машинах»; security.html the exposure list; server.html the vsos preset.
  - This file becomes docs/architecture/remote-classes.md.
  - As built (K11a): runners.html gained six sections, `#classes` (what a class machine runs, opening it to classes, what it needs, the owner's settings), `#classes-where`, `#classes-room`, `#classes-files`, `#classes-failover` and `#classes-ops` (status, update, drain, leave, the move from 0.24), and lost «They do not run room kernels» from its limits; its panel words follow the block's new name «Машины»; server.html's `#runners` gained the D31 preset and what the server needs (the tunnel through the proxy, the self-probe of `PUBLIC_URL`), `#network` and `#proxy` the tunnel's WebSocket, and `#proxy` the bodies of class files coming home (one request each, up to «Файл с машины — до», and up to «Все файлы занятия до» for «Привезти»); security.html gained `#classes`; SECURITY.md the class machine's in-scope and out-of-scope items. council.html waits for 0.26.0 (K11b).
- **Order of updates.** Home goes first: vsos needs 0.25 through Teleport before any class relies on machines (0.23 risk 13).

## 15. Protocol additions
There is no new `REMOTE_PROTOCOL`. The `kernels` block is optional in both directions:
- the agent sends it only after a reply that carried it, so a 0.24 home's strict parser never meets it;
- a 0.24 agent ignores it in replies, since agent parsers ignore unknown keys (0.23 note 25);
- home sends it to every machine with classes, including one with an outdated build, because live placements must keep reconciling; only new placements need build equality.

```ts
// shared/remote-kernels.ts (new; strict parsers at home, tolerant ones on the agent)
export type RemoteKernelRole = 'room' | 'own' | 'council'
export interface RemotePlacementIntent {
  key: string; gen: number                       // key = `${sessionId}:${role}`
  environment: string; revision: { id: string; ref: string; layers: string }
  memoryMb: number; cpus: number; pids: number; gpu: boolean
  network: 'blocked' | 'none'; blockedCidrs: string[]
  token: string                                  // placementToken, 40 chars
  hashSeed: number                               // the class's PYTHONHASHSEED
  workers?: number                               // council: planned pool size
}
export interface RemotePlacementHeld {
  key: string; gen: number
  phase: 'pulling' | 'starting' | 'ready' | 'failed' | 'stopping'
  container?: string; revision?: string          // echoes, checked like RuntimeClient.ensure
  failure?: RuntimeStartFailure & { detail?: string }
  usage?: { usedMb: number | null; limitMb: number; cpus: number; cpuPercent: number | null; startedAt: number; oomKills: number }
  card?: { device: string; usedMb: number | null }
  files?: { pushSeq: number; pending: number; pendingBytes: number; heldOnly: number; heldOnlyBytes: number }
  resized?: RuntimeResizeResult['outcome']
}
export interface RemoteFilesPush { sessionId: string; seq: number; full: boolean; promoted?: boolean
  put: { path: string; sha256: string; bytes: number; dir?: true; inline?: string }[]
  remove: string[]; move: { from: string; to: string }[] }
export interface RemoteFilesReport { sessionId: string; gen: number; seq: number; full?: boolean
  changed: { path: string; sha256: string; bytes: number; base: string | null; inline?: string }[]
  removed: { path: string; base: string }[]
  skipped: { path: string; bytes: number; why: 'size' | 'room' | 'count' | 'package' | 'proxy' }[]   // 'proxy': F4, §8.5
  late?: string[] }                              // changed after the fence (≤ 50), §8.8
export interface RemoteEpochIntent { sessionId: string; root: string; seq: number
  manifest: { sha256: string; bytes: number }; buffers: { sha256: string; bytes: number }[]
  from: 'home' | { container: string; dir: string } }
export interface RemoteKernelsRequest {
  placements: RemotePlacementHeld[]; reports: RemoteFilesReport[]
  epochs: { sessionId: string; root: string; seq: number; ready: boolean; missing?: string[] }[]
  readings: { key: string; gen: number; reading: PostmortemReading }[]
  tunnel: 'up' | 'down'; bye?: 'restart' | 'stopping' | 'leaving'
  classes: { hostNetwork: boolean; perimeter: 'ok' | 'no-dockerd' | 'no-iptables' | 'refused' | 'failing';
             mode: 'blocked' | 'none' | 'open'; canary: 'ok' | string; sameDaemon: boolean }
}
export interface RemoteKernelsReply {
  placements: RemotePlacementIntent[]            // the whole wanted set: omitted = remove
  pushes: RemoteFilesPush[]
  verdicts: { sessionId: string; seq: number; accepted: string[];
              refused: { path: string; why: 'base' | 'book' | 'cap' | 'path'; copy?: string }[] }[]
  pulls: { sessionId: string; gen: number; paths: { path: string; sha256: string }[] }[]
  scan: { sessionId: string; full?: boolean }[]
  epochs: RemoteEpochIntent[]
  collect: { sessionId: string; runId: string; files: { name: string; sha256: string; bytes: number }[] }[]
  postmortem: string[]
  rates: { classBulkMBps: number; machinePaceMBps: number }
  tunnel: 'open' | 'reconnect' | 'closed'
}
// RemoteSyncRequest.kernels?: RemoteKernelsRequest · RemoteSyncReply.kernels?: RemoteKernelsReply
// RemoteJoinReply.classes?: boolean · codes: classes
// shared/remote-tunnel.ts (new): the frame codec of §4.3, lanes, the constants below
```

**As built** (K2, K4, K6b, F3; `shared/remote-kernels.ts` is authoritative where it differs from the block above):
- **Intents.** `RemotePlacementIntent.shm` is required (`REMOTE_SHM`: a size docker reads); `pids` within `REMOTE_PIDS` (64–32768), `cpus` within 1–`REMOTE_ROOM_CPUS_MAX`; at most `REMOTE_PLACEMENTS_MAX` (64) a reply.
- **Pushes.** `put` is an exclusive union, a file `{path, sha256, bytes, inline?}` or a folder `{path, dir: true}`, so a folder carries no hash or size; a base may be `'dir'` (a folder that became a file, or a removed folder). One push per class per reply; at most `REMOTE_PUSH_PATHS_MAX` (5000) paths.
- **Reports.** One report per class per sync; at most 1000 paths (`REMOTE_REPORT_PATHS_MAX`) and 128 KiB inline per sync, across all reports; a `full` report comes in pages, `page {index, last}` required with `full: true`, each page with its own `seq`; `released?` lists paths no longer held on the machine (counted in the 1000); a root is `cells` or `nb:` + 1–400 characters (`isRemoteRoot`).
- **Echo.** `ready` echoes `remoteRevisionDigest(ref)`, the sha256 after the @ of the pinned ref, never docker's image id.
- **Lag.** `RemotePlacementHeld.files` is `RemoteFilesLag` (`pushSeq` is the ack; 0 means a copy kept from earlier gens that waits for home's next push), at most `CLASS_LATE_MAX` (50) late paths.
- **Replies.** `caps?: {machineFileMb, roomMb}`, sent only when not the defaults (200 MB, 1024 MB); a pull may omit `sha256` («Привезти»: the file as it is now, and the PUT says its hash); `replySeq` numbers every reply's block and the request's `heard` says it back, only after a reply carried one, so an older home never meets the key; home then sends once more the verdicts of replies sent before the one heard.
- **Epochs (0.26.0).** A reply's epochs are those not yet reported ready, repeated until they are; omitting one never removes it; `REMOTE_EPOCHS_MAX` 128, `REMOTE_EPOCH_FILES_MAX` 8192.
- **Cross-block rules** (`shared/remote-runner.ts`): a sync with live placements uses the 10 s busy hold; a `bye` is refused in an `active` sync; a reply carrying the hidden test is refused when its kernels block holds placements (D3); a join reply with both `trusted` and `classes` is refused. `REMOTE_SYNC_BYTES` 4 MiB and `REMOTE_REPLY_BYTES` 32 MiB were raised for the worst cases. A 400 or 413 of a sync carrying the block makes the agent drop it (§7.3).

**Doors under `/api/runners/v1`:**
- `GET tunnel` (the upgrade);
- `PUT rooms/:sessionId/files?path=&gen=`: gzip, at most `machineFileMb`, or the room limit for «Привезти»; as built, with `X-Colloq-Sha256` and `X-Colloq-Bytes`, only for a pull home asked of that machine (`pullFor`), staged at the top of the class folder and placed once its bytes check; it answers 200 `{path, sha256, bytes, verdict}`, 409 `revoked` for a fenced gen, 404 for a file or version not asked for, 413, 422, 503 or 507, in the classes' own rate bucket (`roomFile`, 1200 a minute) and their own 2 upload slots. As built (F4), it and the attempts' upload door are spared Node's 300 s request timeout while their bytes move (net/long-body.ts: the body is read at the classes' shared pace, and the door's own 60 s stall timer stands in), and a 413 without home's marker is a proxy's refusal, never retried (§8.5);
- `PUT epochs/:sha256?session=&gen=` (0.26.0): raw, accepted only for an epoch home asked that placement for;
- `PUT council/:sessionId/runs/:runId/files/:name?gen=` (0.26.0): artifacts, 1 MiB each at most;
- `GET blobs/:sha256`, with the new sources `room` and `epoch` (0.26.0). As built, a `room` blob is served only to a machine with a placement of that class and that sha pending in one of its pushes, a push's moved files included (`blobFor`), counted in the `roomBlob` bucket; a 410 makes home walk the folder afresh.

**Staff doors:**
- `PATCH /api/admin/runners/:id {classes}`, `POST /api/admin/runners/:id/classes/resume`, `POST /api/admin/runners/codes {classes}` (owner);
- the seminar PATCH gains `{placement}` (the class's staff);
- control-socket messages: `kernel:move {root?}` and `files:fetch {path}` (staff), `council:epoch {cellId}` (host). The two new `CouncilSettings` fields ride the existing settings frame. As built (F4), `files:fetch` is answered to the tab that pressed: `{t: 'files:fetched', path, outcome: 'accepted' | 'brought' | 'refused', message?}`; `tree:remove` (and `DELETE /api/sessions/:id/file`) of a row only a machine has removes it there (§8.5).
- As built (K9a, F3): the owner's door is `POST /api/admin/runners/:id/classes/:action` with `resume` or `move` (every live slot of the machine; with nothing to move, 409 in words); `GET /api/admin/resources/classes` (staff) and `PUT` (owner, audited as `settings.resources_changed` with target `classes`) hold the owner's «Занятия на машинах» (`ClassMachineSettings`, `backend` beside them); `GET /api/admin/seminars/:id/placement` gives the class's staff the form's live line (`ClassPlacementOutlook`, with the class's `failover` and the viewer's `editable`, which the room reads when an outage begins). The PATCH with `trusted: true` on a machine with classes, and with `classes: true` on a trusted one, is refused in words before any write. Audit actions: `runner.classes`, `runner.classes_resumed`, `runner.classes_moved`; `runner.enrolled` carries `classes`. Staff get `{t: 'kernel:machine', role, machine, note?}` frames; `files:fetch` is staff only (`council:epoch` is 0.26.0).

**Constants** (in `shared/remote-tunnel.ts` and `shared/remote-kernels.ts` unless named):

| Area | Constants |
|---|---|
| Tunnel | `TUNNEL_PING_MS` 10 s · `TUNNEL_PROBE_MS` 6 s · `TUNNEL_QUIET_MS` 12 s · `TUNNEL_DEAD_MS` 25 s · `TUNNEL_FRAME_MAX` 16 KiB · `TUNNEL_WINDOW` 4 MiB interactive / 1 MiB council, 16 MiB per machine (as built, after K0; the council lane's share 12 MiB, `TUNNEL_COUNCIL_SHARE`) · `TUNNEL_SEND_LOWAT` 64 KiB · ACK every 50 ms or 64 KiB · `TUNNEL_STREAMS_MAX` 512 · 12 upgrades/min per machine and address · `TUNNEL_RESUME_MS` 120 s, `TUNNEL_RETAIN_BYTES` 4 MiB and `TUNNEL_RESUME_LIST_MAX` 256 (K3b) · `TUNNEL_MESSAGE_MAX` 64 KiB · replacements: an alert past 3 in 10 min, own-address lines at most 6 an hour |
| Rates | `classBulkMBps` 4 (promoted pushes 8) · `machinePaceMBps` 6 with a 2 MiB burst · competition blobs during classes 2 |
| Liveness | `CLASS_UNREACHABLE_NOTE_MS` 10 s · `CLASS_SILENCE_MS` 60 s (class 30–300 s) · `CLASS_TUNNEL_STUCK_MS` 120 s · `CLASS_EVIDENCE_MS` 15 s · `CLASS_PROBE_MS` 5 s · `CLASS_BYE_GRACE_MS` 120 s · `CLASS_MOVE_NOW_MS` 10 s · quarantine 2 per 30 min · `PERIMETER_RECHECK_MS` 60 s, 3 failures |
| Start and files | `CLASS_START_MS` 180 s · `CLASS_BARRIER_MS` 120 s, 30 s without progress · `CLASS_SCAN_BUSY_MS` 5 s · `CLASS_SCAN_IDLE_MS` 30 s · `CLASS_FILE_QUIET_MS` 2 s · `CLASS_INLINE_BYTES` 64 KiB (128 KiB a report, `CLASS_INLINE_REPORT_BYTES`; 1 MiB a push, `CLASS_INLINE_PUSH_BYTES`) · `CLASS_SYNC_FILES_MAX` 5000 · `REMOTE_CLASS_UPLOADS` 2 · `machineFileMb` 200 (setting) · `CLASS_ROOM_MB` 1024 · `CLASS_PACE_BURST_BYTES` 256 KiB |
| Help | pad min(1000 ms, 2 × RTT p95) |
| Council (0.26.0) | `attemptMb` 1024 · workers 2..16 auto, 32 by hand (`COUNCIL_WORKERS` {min 2, auto 16, max 32}) · `COUNCIL_WORKER_REUSE` 20 · `COUNCIL_EPOCH_MB` 2048 · `COUNCIL_EPOCH_SHIP_MB` 256 · `COUNCIL_EPOCH_WAIT_MS` 5 s · `COUNCIL_POOL_READY_MS` 60 s · `COUNCIL_POOL_LINGER_MS` 15 min · artifacts 20 files, 1 MiB each, 5 MiB total · home epoch store 4 GB |

## 16. Build plan: phases and waves for parallel agents

**Rules.**
1. **Ownership.** Phases of one wave run in parallel and own disjoint files; the table lists every file a phase may touch. An agent that finds it needs a file another phase of its wave owns stops and hands the change to that owner through the lead, or leaves it for the next wave.
2. **Shapes come first.** K2 fixes the contract and the server's words in wave 0. In later waves an optional field may be added to a contract file only by the phase that owns that file in that wave.
3. **Green at every end.** Every phase ends with `npm run typecheck` and the whole `npm test` green on Node 22 (§17.3), plus its wave's e2e scenarios.
4. **Stands.** Agents stop only their own pids, read from a pid file. They never `pkill` or `killall` by pattern, and never touch the live server on :3000.
5. **Double review** goes to K3 and K3b (tunnel and auth), to K6a and K6b (apply, CAS, caps), and to K7b's hooks in `kernel/index.ts`, the 5.6k-line module every class depends on.

| Wave | Phase | What | Owns (+ = new) | LOC | Needs |
|---|---|---|---|---|---|
| 0 | Z0 | The Paper page (§13) | Paper only | — | — |
| 0 | K0 | Measure the relay (§17.5); decides K3b and the constants | +scripts/class-probe.mts | 200 | — |
| 0 | K1 | Pure cores, the hash seed, the class-kernel label; no behaviour change | +server/src/kernel/{room-spec,perimeter-core,postmortem-core}.ts; server/src/kernel/{pool,perimeter,postmortem}.ts; +tests/room-spec-argv.test.mts; tests/{runner-import-graph,kernel-perimeter}.test.mts | 300 new + 600 moved | — |
| 0 | K2 | Contract, tunnel codec, `checkRuntimeEndpoint`, the server's words | +shared/{remote-kernels,remote-tunnel}.ts; shared/{remote-runner,runtime}.ts; server/src/kernel/runtime-client.ts; shared/locales/server.ts; +tests/{remote-kernels-contract,remote-tunnel-codec}.test.mts; tests/remote-runner-protocol.test.mts | 700 | — |
| 1 | K3 | The tunnel, and the kernel client over a link (§4, §5.1–5.2, 5.4–5.5, 5.7) | +server/src/upgrade.ts; server/src/index.ts; +server/src/kernel/remote/tunnel.ts; +server/src/runner-agent/tunnel.ts; server/src/kernel/{jupyter,terminal}.ts; shared/remote-tunnel.ts; +tests/_fake-jupyter.mjs (extracted from kernel.test.mts); tests/kernel.test.mts; +tests/{remote-tunnel,kernel-link}.test.mts; tests/{terminal-endpoint,kernel-channel-reconnect}.test.mts | 900 | K2 |
| 1 | K4 | The kernel host on the agent (§7) | +server/src/runner-agent/kernels.ts; server/src/runner-agent/{sync,state,machine,images,docker}.ts; shared/remote-kernels.ts; tests/_runner-agent-home.mts (a 0.24-strict mode); +tests/runner-agent-kernels.test.mts; tests/runner-agent-sync.test.mts | 950 | K1, K2 |
| 1 | K10 | Packaging (§14) | deploy/vast/{colloq-host,entrypoint.sh,onstart-runner.sh}; server/src/competitions/remote/commands.ts; server/src/ops/runner-code.ts; scripts/vast-runner.sh; Makefile; tests/{vast-runner-host,remote-runner-commands,remote-runner-code}.test.mts | 150 | K2 |
| 2 | K3b | Resumable streams, only if K0 says so (§4.8) | shared/remote-tunnel.ts; server/src/kernel/remote/tunnel.ts; server/src/runner-agent/tunnel.ts; +tests/remote-tunnel-resume.test.mts | 400 | K3, K0 |
| 2 | K5a | Placement at home and its kernel hooks (§5.3, 5.6, 5.8, §6, §11) | +server/src/kernel/remote/placement.ts; server/src/kernel/{pool,index,usage,resources,postmortem}.ts; server/src/db.ts; server/src/admin/resource-settings.ts; server/src/control.ts; shared/{notebook,protocol}.ts; shared/locales/server.ts; +tests/{class-placement,class-kernel-hooks}.test.mts | 900 | K1–K4 |
| 2 | K5b | Sync and liveness of class machines | server/src/competitions/remote/{routes,liveness,release,store,fit,want,heard}.ts; shared/remote-kernels.ts; +tests/remote-classes-sync.test.mts; tests/remote-runners-liveness.test.mts | 500 | K2, K4 |
| 2 | E | The Docker-free e2e harness and its first scenarios (§17.2, groups A, B, D) | tests/_remote-e2e-home.mts; tests/_remote-e2e-docker.mjs; tests/_fake-jupyter.mjs; +tests/_tunnel-fault.mts; +tests/classes-e2e.test.mts | tests | K3, K4 |
| 3 | K6a | Files at home (§8) | +server/src/kernel/remote/files.ts; server/src/workspace.ts; server/src/kernel/index.ts; server/src/control.ts; server/src/ai/agent.ts; server/src/publish/{class-end,materials}.ts; server/src/routes/files.ts; server/src/competitions/remote/{routes,blobs,upload}.ts; server/src/admin/resource-settings.ts; shared/protocol.ts; shared/locales/server.ts; tests/{classes-e2e,_remote-e2e-docker}; +tests/class-files-home.test.mts | 800 | K5a, K5b |
| 3 | K6b | Files on the agent | +server/src/runner-agent/room-files.ts; server/src/runner-agent/{sync,cache}.ts; shared/remote-kernels.ts; +tests/runner-agent-room-files.test.mts | 500 | K4 |
| 3 | K9a | The panel, the room and files UI, visibility | web/src/admin/ui/{Runners,RunningKernels,Resources,ConnectMachine}.svelte; web/src/admin/screens/{RemoteMachine,ResourcesTab}.svelte; web/src/admin/{runners,running-kernels}.ts; web/src/components/notebook/Notebook.svelte; web/src/components/panels/FilesPanel.svelte; server/src/routes/{admin-running,admin-runners}.ts; server/src/competitions/remote/views.ts; shared/{admin,remote-admin}.ts; shared/locales/{admin,room}.ts; scripts/ui-check.mts; tests/{admin-runners-ui,admin-running-kernels,admin-phone}.test.mts | 850 | K5a, K5b, Z0 |
| 4 | K8 | Personal notebooks: the ceiling across home and machine, mixed placement | server/src/kernel/index.ts; server/src/kernel/remote/placement.ts; tests/classes-e2e.test.mts; +tests/class-own.test.mts | 150 | K6a |
| 4 | K11a | Docs for 0.25 | docs/pages/{ru,en}/{runners,server,security}.html; +docs/architecture/remote-classes.md | docs | K6 |
| 4 | K12 | The class load generator | +scripts/class-load.mts; Makefile (`class-probe`, `class-load`) | 250 | K6 |
| 4 | K13 | The Linux parity job with real Docker | +.github/workflows/classes-smoke.yml; +tests/classes-docker.test.mts | tests | K6 |
| R1 | — | The 0.25.0 gate: §17 on Node 22, CI, the parity job, the UI check, rehearsal R1, a fix wave | — | — | wave 4 |
| 5 | K7a | Epoch export, load and the worker's entry (Python, §9.3–9.4, 9.7) | server/src/kernel/council-isolation.ts; +tests/council-epoch.test.mts; tests/council-isolation.test.mts | 500 | — |
| 5 | K7b | The pool at home (§9.2, 9.5–9.10) | +server/src/kernel/council-pool.ts; +server/src/kernel/remote/epochs.ts; server/src/kernel/index.ts; server/src/kernel/remote/placement.ts; server/src/control.ts; server/src/council.ts; shared/{protocol,notebook}.ts; server/src/competitions/remote/{routes,blobs,upload}.ts; server/src/admin/resource-settings.ts; shared/locales/server.ts; tests/{_fake-jupyter.mjs,_remote-e2e-docker.mjs,classes-e2e.test.mts}; +tests/council-pool.test.mts | 800 | K6, the K7a signatures fixed in §9.3 |
| 5 | K7c | The agent's side: epochs, scratch, artifacts | +server/src/runner-agent/council.ts; server/src/runner-agent/{kernels,sync,cache}.ts; shared/remote-kernels.ts; +tests/runner-agent-council.test.mts | 300 | K4, K6b |
| 6 | K9b | Console UI for the pool | web/src/components/council/pult/{PultHeader,PultQueueStrip,PultRules,PultWork,PultStatusLine}.svelte; web/src/lib/council-pult.ts; web/src/components/notebook/CellView.svelte; shared/locales/room.ts; scripts/ui-check.mts; tests/council-pult*.test.mts | 400 | K7b, Z0 |
| 6 | K11b | Docs for 0.26 | docs/pages/{ru,en}/council.html; docs/architecture/remote-classes.md | docs | K7 |
| 6 | K12b | Council bursts in the load generator; epochs in the parity job | scripts/class-load.mts; tests/classes-docker.test.mts; .github/workflows/classes-smoke.yml | 50 | K7 |
| R2 | — | The 0.26.0 gate: §17 again, rehearsal R2 | — | — | wave 6 |

**Order.** Wave 0 → 1 → 2 → 3 → 4 → R1 → **0.25.0** → wave 5 → 6 → R2 → **0.26.0**.

This follows the verdict's dependency order (K0 ∥ K1 ∥ K2 → K3 (+K3b) ∥ K4 → K5 → K6 → K8 → K7 → K9 → K12), with four changes:
- three phases are split into halves with disjoint files: K5a/b, K6a/b, K7a/b/c;
- the UI is split by release: K9a runs beside K6 once Z0 is approved, as P8 ran beside P5 in 0.23, and K9b follows K7;
- packaging, docs, the load generator and CI move into the waves where their files are free;
- if K0 rules K3b out, its agent joins E.

**Not in the waves.** The first cell after a pause no longer waits for `confirmAlive`'s round trip on a machine: R1 measured it (personal notebooks 887 ms against the class notebook's 538 ms at p50 over a 233 ms tunnel), so a machine kernel sends the execute at once and asks the GET beside it; a 404 refuses a run the kernel never heard (rerun on a fresh kernel, as before) and is a death mid-run otherwise (jupyter.ts · send, confirmAlive). Home and broker kernels still ask first. Pipelining Run All stays a measured follow-up.

**Total.** About 9.6k LOC (9.2k without K3b) plus about 6k LOC of tests. The release split is D29: 0.25.0 is K0–K6, K8, K9a, K10, K11a, K12 and K13; 0.26.0 is K7a–c, K9b, K11b and K12b. If one release is required, K7 ships with `council: 'shared'` as the default.

**As run for 0.25.0.** The waves kept their order, with these splits and additions (each build phase was reviewed, double for K3a, K3b, K6a and K6b, and its findings fixed or rejected with a reason):
- wave 0: Z0, K0, K1, K2;
- wave 1: K3 as two phases, K3a (the tunnel, §4) and K3c (the client over a link, §5), with K4 and K10;
- wave 2: K3b, K5a as K5a1 (placement, §6, §11) and K5a2 (the kernel hooks in index.ts), K5b, E;
- wave 2b: I (the wiring: production needs no boot call, §20.4), SA, SB and SD (the scenarios of §17.2 A, B and D on real home and agent processes), F (what they found);
- wave 3: K6a, K6b, K9a; SC (scenarios C); F3 (fixes);
- wave 4: K8, K11a, K12, K13; F4 (the handoffs of wave 4); then R1.
K8 grew beyond its row: it also owns the class's memory and core bounds for slots on machines (kernel/resources.ts, the instance PATCH, the Resources form), the same flaw PR #51 fixed for submission cores. main's 0.25 extras (PR #51) were merged into the branch between waves 3 and 4.

## 17. Verification

### 17.1 Unit tests per module
These run on Node 22 with no Docker and no wall-clock assertions: they count events, not milliseconds (after 71e5929). Fake HTTP servers call `closeAllConnections()` and terminate WebSockets at teardown (0.23: a hung long-poll held CI for 17 min).

| Module | Test file | What it proves |
|---|---|---|
| shared/remote-tunnel.ts | remote-tunnel-codec | Frames round-trip. Unknown kinds, oversized payloads and bad lanes are refused |
| shared/remote-kernels.ts | remote-kernels-contract | Home's strict parsers refuse unknown keys, bad gens, oversized inline blocks and bad paths; the agent's parsers ignore unknown keys |
| kernel/room-spec.ts + pool.ts | room-spec-argv | Home's `runArgs` and the agent's `roomRunArgs` are equal flag for flag for room, own and council, a GPU room and `none` mode, with `PYTHONHASHSEED` as the seventh variable. The only differences are named: image, mount, name, token, `--pull=never`, log caps, labels |
| kernel/perimeter-core.ts | kernel-perimeter | Golden scripts; agent-scoped chain and network names; home's mode as the floor |
| the three cores | runner-import-graph | The agent bundle loads nothing on `FORBIDDEN` |
| kernel/remote/tunnel.ts (home) | remote-tunnel | `cr1` only; browser tokens refused; the origin rule bypassed for this path alone; 4409 replacement; the 12/min cap; `tunnel_replaced` and the banner rule; one listener per placement; a fast `ECONNRESET` while down; lane priority; DRR fairness with a 6 MiB stream against small ones; the lowat rule; windows never exceeded; ACK cadence; TCP_NODELAY |
| runner-agent/tunnel.ts | remote-tunnel | OPEN only for the current gen; an agent OPEN closes the tunnel; no generic forwarding; the 6 MiB/s bucket on a fake clock; backoff and `relayState` |
| K3b resume | remote-tunnel-resume | The seeded property test: random cuts, black holes, reconnects and agent restarts deliver exactly the sent bytes once and in order, or reset on overflow |
| kernel/jupyter.ts | kernel-link, kernel-channel-reconnect | No attempts counted while the link is down; `'lost'` → `dead` with `endedBy` and no `DELETE`; the identity override keeps the pty across a port change; `waitForSocket` extended; `reconcileAfterReset` settles a dropped reply only after the replay; `RestartUnknown` settled both ways by the guard question (as built: by the kernel process's id, §5.4) |
| kernel/terminal.ts | terminal-endpoint | Re-resolve for machine endpoints; the link wait; the quiet pad |
| kernel/remote/placement.ts | class-placement | Every eligibility filter; stickiness (as built, no last-host preference: §6.3); RTT and «далеко»; the whole GPU card; stale-capacity accounting; the gen fence on every input; a token per gen; the state machine with an explicit clock (evidence 15 s, probe 5 s, boot grace, tunnel-only 120 s, `bye` 120 s, `failoverSec`, «ждать машину», «Перенести сейчас»); class quarantine |
| kernel/index.ts hooks | class-kernel-hooks | Gate words after 10 s; the queue dropped at failover; `detach` never `dispose`; the failover note; restart and interrupt refused while unreachable; the limit SIGINT retried on the same item only; help pads; warm start on join |
| competitions/remote (sync, liveness, release, store, fit, want, heard) | remote-classes-sync, remote-runners-liveness | The `kernels` block only for class machines; intents as the whole wanted set; class revisions in `want`; `machineFit` refuses sealed rows on class machines; unclass and revoke fail over first; the faster probe and evidence only while placements live |
| runner-agent/kernels.ts | runner-agent-kernels | Start order; the ready probe; failure markers; a stop during a start; resize; adoption after a restart; the 0.23 sweep leaves class containers alone; census batching; readings; the 60 s perimeter re-check and fail-closed after 3; the orphan rule; parsing the canary; the GPU card marked busy; host-network detection from `HostConfig` |
| runner-agent/sync.ts | runner-agent-sync | `kernels` is sent only after a reply carried it, against the 0.24-strict `fakeHome`; `bye` reasons from the marker; placements in `holding()` |
| kernel/remote/files.ts | class-files-home | The counter fast path; walk and diff; move detection; inline against blob; barrier words, promotion and the stall; the CAS table of §8.4 row by row, conflict copy names included; deletes never resurrect; book paths refused; caps → `skipped`; package rows; «Привезти»; rebuild from a `full` report; TEMP names swept; the anchored apply refuses a symlinked parent |
| runner-agent/room-files.ts | runner-agent-room-files | Apply order (moves, removes, puts); the baseline persisted; the quiet rule; busy and idle cadence; `RECORD` trees; copy before hash; links never followed; pacing; late changes after a fence |
| council-isolation.ts (Python, real `python3` through `drive()`; pandas, numpy, sklearn and torch optional) | council-epoch, council-isolation | Export and load round trip with one memo across names; notebook functions rebound (`df = df.dropna(); f()` agrees with a shared kernel); class instances; RNG parity; module aliases; left names as sentinels with words; budget and per-name caps; CUDA detection; an incremental refreeze reuses unchanged buffers; copy-on-write isolation (worker A's in-place write reaches neither the file nor worker B); `_memory_cap` stays under `cap`, mandatory for workers; `_colloq_needs` cases (comprehension scopes, `global`, `globals()['x']` hits the sentinel); scratch `chdir` and the skeleton (writes local, class files read-only); `oom_score_adj` written; thread limits |
| kernel/council-pool.ts, kernel/remote/epochs.ts | council-pool | Routing (lane, CUDA, not ready, unreachable, the worker's refusal → reroute keeping the place); one attempt in flight per person; replace in place; positions without teacher cells; the teacher lane; cancel, ban and retime on workers; recycling rules; growth and shrink; re-run once on loss without the pause; stale-epoch wait ≤ 5 s, then «без ячеек N»; manual refresh; `kernelWorkOf.pool`, `busyOf`, `stopBlocker`; ingest checks each sha; retention; blob scope; the ship cap counts missing bytes only |
| runner-agent/council.ts | runner-agent-council | The epoch CAS, hard links and read-only mount; the artifact caps; paced uploads; epochs pinned against LRU |
| UI | admin-runners-ui, admin-running-kernels, admin-phone, council-pult* | Classes chips, the toggle and refusals; machine rows with 0 MB here; chip states; the pool strip; card footnotes; phone width |

### 17.2 End to end without Docker: real home and agent processes
`tests/classes-e2e.test.mts`, in `npm test`, about 3–4 min, on the remote-e2e harness.
- **Home** is this test process, with `_remote-e2e-home.mts` attaching the exported `handleUpgrade`. Home's class tick and tunnel liveness read an injectable clock.
- **Agents** are real processes (`_remote-e2e-agent.mts`, their timings shortened by environment).
- **The fake docker** (`_remote-e2e-docker.mjs`) learns class containers: `run` spawns `_fake-jupyter.mjs` on `127.0.0.1:0` with the mount as its cwd, and `port`, `inspect`, `stats`, `update`, `exec` (cgroup lines), `logs`, `cp`, `rm` and `ps` by label all work.
- **`_fake-jupyter.mjs`**, extracted from kernel.test.mts:26-406, has:
  - sessions by path;
  - a tiny interpreter: assignment, `print`, `HOLD`/`RELEASE`, `SLEEP`, `STREAM n ms`, `RAISE`, `OOM`, `WRITE path text`, `READ path`, and `COUNT`, which proves no double execution;
  - offline buffering by `session_id`, with replay before the `kernel_info` reply;
  - `guardAnswer`, `councilExpressions`, canned export, load and entry reports;
  - terminado.
- **`_tunnel-fault.mts`** sits between agent and home with `cut()`, `blackhole()`, `delay(ms)`, `throttle(Bps)` and `heal()`, per direction.

Each scenario asserts what students, teachers and the owner see through their own doors, what the database holds, and the fake's call log; one assertion is that no `DELETE` ever reached a lost placement.

**As built** (E, SA, SB, SD, SC, F, F3): the scenarios live in `tests/classes-e2e-a.test.mts` (A.1–A.3), `-b` (B.4–B.8, with two supporting tests of the tunnel's and the agent's quiet rules), `-c` (C.9–C.13) and `-d` (D.14–D.24, with «D16 · a stuck tunnel whose syncs then stop too» and follow-ups to D.14 and D.20 for files); `tests/classes-e2e.test.mts` keeps the harness's own tests. Every file passed three rounds in a row at the end of wave 3. The agents' timings are shortened through the harness's entry (`_remote-e2e-agent.mts` · `AgentOptions.timings`, which calls main.ts's own `main()` with them as its seams, `AgentTimings.files` included), not read from the environment by product code. Home's clock moves in steps of 5 s or less with event-loop turns: a jump of 12 s or more makes a healthy tunnel quiet. A one-direction `cut` resets the side that direction reaches and leaves the other half-open (TCP cannot drop one direction's bytes without corrupting the stream). `_fake-jupyter.mjs` gained `python [-u] FILE` in its shell, `FILL`, `TRUNCATE`, `MOVE` and `REMOVE`, a real `release()` count and `--calls-file`; `Home.start()` installs `useRemoteClock`. C.12 needs about 600 MB of temporary disk on a Linux runner.

**A. Placement and cells.**
1. Warm start on join; Run → output in Yjs; completion, inspect and brief through the tunnel; interrupt, restart, `input()`, `file:run`, the terminal.
2. Two class notebooks in one room container; ten personal kernels on a machine with the room at home.
3. A home build differing from the agent's: classes keep running, a new placement goes home with the words, «устарел».

**B. Tunnel faults.**

4. A 20 s black hole mid-`STREAM`: no failover, no reconnect attempt counted, the chip amber after 10 s, the "back" note, all output delivered. (As built: amber at 12 s, when the tunnel turns quiet, §4.7.)
5. A cut without resume: inner reconnect, replay, and `reconcileAfterReset` settles the reply the fake dropped on purpose; `COUNT` unchanged.
6. (K3b) A 60 s cut with resume: zero output lost, no inner reconnect.
7. Restart pressed while unreachable is refused. A restart whose answer is cut reads «ответа нет», then is settled one way, and in a second run the other.
8. A run limit firing during a cut lands when the link returns, on the same cell, never the next.

**C. Files.**

9. Upload at home → the next cell reads it. With nothing changed, zero pushes are counted; a 10 KB edit makes one push.
10. A cell writes `out.csv` and `/files` lists it when the cell ends; a rename on the machine becomes `movePath` with no upload; a delete.
11. The editor saves `utils.py` while the kernel writes it: home's version plus `utils (с машины HH-MM).py`. Home deletes while the kernel rewrites: no resurrection.
12. A 300 MB write stays «на машине» with a log line, and «Привезти» brings it; `pip install -t .` gives one package row and no upload.
13. A kernel writes a notebook file: refused, then re-projected.

**D. Failover and restarts.**

14. A partition with a second machine as evidence: failover at the class's `failoverSec` on the clock. Words; the queue dropped; the running cell's fate unknown; files as of the last sync; the stale gen's PUT gets 409; the returning machine reports late changes and removes its container.
15. Home's own path blackholed (both machines silent, the probe failing): no failover, and everything resumes.
16. Tunnel down with syncs flowing past `CLASS_TUNNEL_STUCK_MS`: failover with the tunnel words.
17. «ждать машину»: no failover until «Перенести сейчас», which moves at once.
18. Agent SIGKILL: adoption; `x = 5` survives `print(x)`; the pty is kept.
19. `bye{restart}`: no failover within its 120 s grace, even in silence.
20. Home crash and restart mid-cell: re-attach by session path, `releaseOrphanedWork`, full reports reconcile, nothing fails over in the boot grace.
21. Revoke, «Не принимает занятия» and leave: immediate failover with the owner's words; submissions keep flowing after unclass.
22. The perimeter helper fails three times: class containers stopped, failover, the banner.
23. Two silence failovers inside the window: quarantine; no new placements until resume.
24. Four tunnel replacements from two addresses: events and the banner.

**E. Council (0.26).**

25. Open → epoch → 12 attempts on 4 workers at once (the fake's `HOLD` counts concurrent holds); ✓/✗; show; adopt-and-run in the main kernel.
26. A teacher cell after the epoch: the next attempt waits for the refreeze and runs on the new epoch. With an export slower than 5 s it runs on the old one, with «без ячеек N».
27. An attempt reading a left name is refused by the worker's entry and runs in the shared kernel, keeping its place.
28. A stuck attempt: the second SIGINT, the worker recycles, and the main kernel's queue never moves.
29. The pool's machine lost mid-attempt: re-run once in the shared kernel, the pause not charged.
30. An attempt writes `out.csv` into its scratch folder: listed on the card; the class folder untouched.
31. A home restart with attempts mid-run: `ServerRestarted` once; workers re-attached and recycled.

### 17.3 The full suite on Node 22, and CI on Linux
- **On the Mac, before every push.** `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run typecheck && npm test`. The Mac's `node` is 26, while CI and the image run 22, and fetch/undici and stream behaviour differ between them.
- **CI (`ci.yml`, «Typecheck and tests», ubuntu-24.04, Node 22)** runs the whole suite, unit and e2e, on every PR. The suite still needs no Docker daemon. The Linux-only trap from 0.23 applies: a suite that removes its data folder between tests must close `competitionsFs` first.
- **The parity job.** A new `.github/workflows/classes-smoke.yml` (nightly and `workflow_dispatch`, real Docker, runtime-smoke style, uid 1000) runs `tests/classes-docker.test.mts` under `COLLOQ_CLASSES_DOCKER_TEST=1`. Before merge it runs on the branch with `gh workflow run classes-smoke.yml --ref <branch>`. Home runs with `KERNEL_BACKEND=test`, so it starts no local rooms and does not collide with the agent's chains; the agent runs on real Docker with `colloq-kernel:base`. It covers:
  - placement, cells and the terminal against the real jupyter_server;
  - the replay-before-`kernel_info` ordering after a cut, which pins §5.5;
  - files both ways with fd anchoring and uid 1000;
  - the agent-scoped perimeter installed, and the admission canary passing;
  - (0.26) an epoch export and load with real pandas into 4 workers: copy-on-write isolation, `oom_score_adj`, and a greedy attempt's `MemoryError`;
  - `docker kill` of a room giving a post-mortem reading.

  As built, K13 writes the job and the file in wave 4 (they skip without the variable), and R1 runs them on the branch. How it runs: the agent in a container as uid 1000 on the runner's real Docker (containerd image store, the disk cleaned first, both images built locally and never pushed); the job is nightly, `workflow_dispatch`, and a path-filtered `pull_request` (the workflow, the test, its harness files, `kernel/**`, the agent, home's kernel and remote-competition code, `shared/remote-*.ts`), one run per PR at a time; 90 min for the job and 70 for the test, the file's own bounds adding up to an hour; on failure every labelled container's `docker logs` go into the `classes-docker-logs` artifact, and the last step fails a green run that leaves containers or networks behind. The machines' clock runs at production's cadence — a pass every 5 s, home's probe of its own path through the fault proxy as production's goes through the relay — so a scenario fails over by the real rules; each scenario carries its own timeout signal, its waits stop and say what they waited for, and `after` lists whatever is left (containers, networks, the chains' iptables lines, the tree) and fails if anything is. Every docker call goes to `/var/run/docker.sock` with `DOCKER_CONTEXT` removed, and `before` checks that the file and the agent see one daemon. Besides the list, they pin what the design leans on from the real jupyter_server: the `header.session` of a kernel's replies, constant within one process and new after a restart (§5.4); the kernel WebSocket's ping timeout (a cut longer than it closes the inner channel, which resume cannot prevent); the terminal prime rule and the verdict echo (`replySeq`/`heard`); and, from K6b, folders 2775 and files 0664 owned by uid 1000, `/proc/self/fd` anchoring, and the sparse-file clamp on ext4.
- **Regressions to watch.** kernel, kernel-channel-reconnect, kernel-idle-sweep, kernel-running, terminal*, council-*, remote-e2e, remote-runners-*, runner-agent-*, runner-import-graph, files-delta, uploads, workspace-*, admin-running-kernels, admin-runners-ui*, the broker suites (competition-broker-*, kernel-runtime-*, D26), and `browser-smoke.yml`.
- **Local Docker checks** need `colima start` (Colima was stopped on 13 Oct); prefer the parity job.

### 17.4 Live UI check
Types and tests do not catch a dead handler or a Svelte effect loop, so every UI phase ends in a real browser.
- **`scripts/ui-check.mts --classes-only`** (K9a; K9b adds the pool). It brings up its own stand: a temp `DATA_DIR`, `NODE_ENV=test`, `KERNEL_BACKEND=test`, its own port. It adds an e2e agent with the fake docker and fake Jupyter, joined by a code the owner mints, plus the fault proxy. Then it drives Chrome over CDP:
  - the owner turns «Принимает занятия» on (Z1, Z2), and a teacher sets «Где считается» (Z4);
  - a student runs a cell: «Ядро на машине», and staff see the machine and its RTT (Z5);
  - the proxy black-holes the tunnel: amber after 10 s, «Перенести сейчас» for staff, then the failover note;
  - the files panel shows «на машине», «Привезти» and a conflict copy (Z6); «Работают сейчас» shows machine rows (Z7);
  - (0.26) the pool strip, the «Регламент» rows, and the card footnotes and artifacts (Z8, Z9).
- **How it checks.** It listens to `Runtime.exceptionThrown` and console errors; types with `Input.insertText`; checks every Z screen at 390 px, light and dark; removes its rooms with `DELETE /api/admin/seminars/<id>`; and stops only its own Chrome and server pids.
- **A second pass** runs on the rehearsal rig, in real Chrome tabs against the lab home: never vsos and never the live :3000.
- As built (K9a, wave 3): the check passes 40 steps on the merged tree. It does not drive Z6 in the browser yet (scenario C.12 checks the rows Z6 draws through the participant's door), and it asserts that the staff chip names the machine and that «Ждать машину» saves `failover: 'wait'`.

### 17.5 Vast rehearsal, with numbers
**Rig.**
- **H**: a lab home behind relay2 under a test name, 8 vCPU / 16 GB, standing in for vsos. Never vsos itself. The Mac's path to relay2 never runs through AmneziaVPN: exclude the relay from the VPN, or drive from a VM.
- **C**: a CPU machine, 32 vCPU / 64 GB. **G**: 1×4090, driver 580+. **U** (optional): a US VM, for the RTT comparison.
- **Load**: `scripts/class-load.mts` with 30 synthetic students (control and collab clients: cells, uploads, attempts), plus two headless Chrome tabs for RTT.
- **As built** (K12): `make class-load URL=… N=30 MIN=60 CLASS=home|machines|personal|gpu OWN=… CSV=… BIG=…` (an owner's credential from the environment, `LOAD_SETUP_TOKEN` or `LOAD_STAFF_COOKIE`, never printed; `URL` only from the command line; `exec node --import tsx`, so one Ctrl+C reaches the rig once and a kill of make reaches it too) makes its own seminar through the admin routes, sets «Где считается», joins N students and two staff tabs, runs rounds of cells (print, a 2 MB figure, tqdm at 10 Hz, a long cell, uploads, personal notebooks for `OWN`, council attempts in the shared kernel, completion, interrupt, terminal echo), and deletes its room on any exit, a lost create's room found by its tagged name. Run `CLASS=home OUT=home.json` first, then `CLASS=machines BASELINE=home.json` with the same N and OWN: a baseline is refused unless it is such a run, before anything is made. `CLASS=gpu` needs a GPU environment and reports the card with a `torch.cuda` check; `LOAD_CSV_MB` (default `1,50`) and `LOAD_BIG_MB` (R1: 150, which needs the home's upload limit raised past it, refused at once otherwise) time `to_csv` → the panel and the barrier of a big upload, once a class. The rig sets the room's run limit to its longest cell plus 10 s and runs one personal cell past it; it paces each `term:run` behind the shell's own prompt, gives a click a tenth of the round (1.5–60 s) to be taken, counts what was pressed while the machine was away apart, reconnects as the web app does, samples its own event loop (red past 50 ms at p95), and judges §17.5's targets on what the client can see — the barrier's "0 round trips" stays a server-side count, and the relay's bytes per class-hour are the counters it prints for the operator to read before and after. More than 60 students from one address need it in the home's `SHARED_ADDRESSES`. Fake cells run only in the e2e; the Python cells (tqdm, torch) have not met a real kernel yet (R1).
- **Rules.** Bursts run outside class hours, because relay2 is shared. Never restart relay2's frps; relay restarts are tested on a lab relay only. Kill only your own pids.

**Before the build: K0.** Run from G, C and U against H, never during a class:
1. Tunnel echo RTT at 1 Hz for 10 min: p50, p95, p99 and the longest gap.
2. Throughput with 1, 2 and 4 streams, through a tunnel prototype and through `GET blobs`: per stream, or per box?
3. RTT while 150 MB moves at 8, 4 and 2 MiB/s, paced and unpaced.
4. A 2 MB frame end to end while bulk runs.
5. Cuts (iptables drop) of 10 s, 60 s and 300 s: reconnect time, bytes lost; and resets per hour on an idle tunnel. This decides K3b.
6. Idle behaviour at 20, 40 and 70 s without pings.
7. 3 tunnels plus 30 browsers: count the "work connection pool is full" lines.
8. Collaboration RTT (headless Chrome, a Yjs echo) at baseline, during step 3 and during a burst.
9. 1 MiB frames both ways (PMTU; relay2 caps its routes' MTU, relay-setup.sh:379-400), and frps restart recovery on the lab relay.

The outputs fix the ping interval, the windows, the class bulk and competition rates, the machine pacing, the help pad, and K3b's go or no-go.

**R1 (0.25.0) and R2 (0.26.0): measure.**

| Quantity | Target |
|---|---|
| Tunnel RTT, p50 and p95 | recorded; K0's defaults confirmed |
| `print(1)` click → visible, H-local against C (and U) | ≤ +150 ms at p50, ≤ +400 ms at p95 (C) |
| Completion, value line, interrupt, terminal `echo` (100 each) | completion < 1 s at p95; value line ≥ 95 %; interrupt ≤ 300 ms; echo ≤ 300 ms |
| Run-limit SIGINT latency | ≤ 1 s after the limit |
| tqdm at 10 Hz for 2 min; a 2 MB figure | no stall over 1 s; the figure ≤ +1.5 s |
| Barrier: no change / a 10 KB edit / a 150 MB upload readable | 0 round trips / ≤ 400 ms / ≤ 25 s |
| `to_csv` of 1 MB and 50 MB → the panel | ≤ 2 s / ≤ 15 s |
| Collaboration RTT p95 during the 150 MB sync and the council burst | within 50 ms of the baseline |
| relay2 bytes per class-hour (interface counters before and after a 60 min `class-load`) | ≤ 300 MB without datasets |
| H's CPU while piping | recorded (< 5 % of a core expected) |
| A GPU room on G | `torch.cuda` works, the card is held, no submission takes it |
| 15 personal notebooks | first-run p95 and the own container's memory, recorded |
| (R2) Epoch: export of a 500 MB frame plus a model, an unchanged refreeze, transfer H → C, seed time, private memory per worker (`smaps_rollup`), the container's total | recorded; they replace §9.11 |
| (R2) 30 attempts of 2 s on 8 workers | ≤ 20 s; overhead ≤ 1 s at p95; the main kernel untouched |
| Failover after a destroy | amber ≤ 30 s; a kernel usable at home ≤ 75 s plus its start |

**Inject.**

| Inject | Expect |
|---|---|
| `vastai destroy C` mid-class | Amber ≤ 30 s; failover ≤ 65 s with G as evidence; words; files as of the last sync; the pool re-places or falls back |
| `kill -9` of the agent process inside C | The tunnel is back ≤ 10 s; no failover; variables and the pty intact |
| `docker kill colloq-runner` on C (a manual stop) | Failover after 60 s |
| `colloq-host runner update` on C | `bye{restart}`; adoption; no failover; variables kept |
| Restart H mid-class | Re-attach; variables survive; files reconcile; nothing fails over in the boot grace |
| Block H's relay leg for 2 min | No failover (no path evidence); recovers |
| Partition C from relay2 for 2 min while G talks | Failover after 60 s; C's late reports refused; its containers removed on return; late changes named |
| Cut only the tunnel (`ss -K` on C) | Reconnect; no failover; with K3b nothing lost, without it at most the running cell's result |
| Block the tunnel and the syncs for 20 s, then for 90 s | 20 s: amber chip only. 90 s: failover at 60 s |
| Revoke C; then «Не принимает занятия» on G | Immediate failover; containers gone within one round trip; uploads 401; submissions continue on G |
| Flush `DOCKER-USER` on C; then make the helper fail | Reinstalled within 60 s; after three failures, fail-closed words, failover and the banner |
| Fill C's disk | New placements refused; barrier words; H intact |
| An OOM cell on C | Jupyter restarts the kernel; a post-mortem note with the machine's numbers |
| (R2) A greedy attempt; a stuck attempt | `MemoryError` for its author only; the worker recycled; the main kernel's queue still |
| (R2) A 30-attempt burst while the teacher runs a 60 s cell | Attempts in parallel; the epoch waits ≤ 5 s, then «без ячеек N»; the teacher's lane first |
| Two silence failovers on C within 30 min | The quarantine banner; resumed by the owner |
| Deploy H with a different runner build | Classes keep running; «устарел»; no new placements |

**Accept when** every target holds; no variable is lost on an agent kill, an update or a home restart; no deleted file comes back; the words are right in every case; «Работают сейчас» shows 0 MB here for machine rows; and `make runners-down` leaves no labelled container behind. Then destroy every VM.

## 18. Risks
1. **relay2 is one point of failure** for students, submissions and now kernels. With home's leg down nothing fails over, which is right but stalls everything. A second relay box is the remedy (0.23 Q8), out of scope.
2. **The shared TCP leg.** frp multiplexes everything onto one connection. Pacing, lanes and the lowat rule keep its queue short; K0 measures; a second frpc name is the fallback.
3. **Loss on the machine's leg.** One TCP stream means a retransmit stalls every stream of that machine for at least an RTO. The chip shows link quality, the chooser prefers short links, and the owner picks machines.
4. **Pickle fidelity.** Objects that pickle "successfully" but wrongly, globals outside `_portable`, BLAS digits under other thread counts. Mitigated by the trial pass with left names, the sentinel, the shared switch and «состояние от» on every card.
5. **Worker memory.** Object and string columns and torch storage are copied per worker, and copy-on-write grows with what attempts touch. Mitigated by the mandatory cap, recycling on private memory, `oom_score_adj`, auto-sizing from the census, and R2's numbers.
6. **The replay-ordering assumption** behind §5.5 (jupyter_server answers `kernel_info` after its replay). Pinned by the parity job on the real server; if it fails there, the fallback is 1 s of iopub silence after the reconnect. As built, the same job pins `header.session`, which the restart verdict and the replaced-process check rely on (§5.4, §17.3).
7. **index.ts risk.** About 20 small hooks across K5a, K6a, K8 and K7b, in waves of their own. Double review for K7b, and the kernel and council suites as the regression gate.
8. **A behaviour change for the council.** Pool attempts see an epoch, not live state, and their files no longer land in the shared folder. The card says so; adopt-and-run is unchanged; «Попытки считаются: в общем ядре» restores the old mode per cell.
9. **False failover** costs variables. Two channels, path evidence, the boot and `bye` graces, 60 s with a per-class setting, «ждать машину». Measured in R1.
10. **Exposure.** Classes on rented hosts are protected by policy, not cryptography: an owner flag, off by default, and no hidden test beside them.
11. **Version skew.** The argv comes from the machine's build; the guard, isolation and epoch code from home's. Build equality gates new placements, and adopted containers keep their argv until they next start.
12. **File storms** (`pip install -t .`, checkpoints every epoch): caps, `RECORD` trees, the walk ceiling, the quiet rule, the class upload slots, pacing.
13. **Host networking.** Old plain-`docker run` machines are not eligible until rejoined, and the panel says so.
14. **Run All costs one round trip per cell** (+1.6 s for 30 cells on EU). Pipelining is a measured follow-up. US machines cost about 130 ms a cell and are flagged «далеко».
15. **vsos updates depend on Teleport and Spirit SSO** (0.23 risk 13). 0.25 must reach vsos before a class relies on machines.

## 19. Overruling a default: what moves

| # | If overruled | What moves |
|---|---|---|
| D1 | No tunnel | The design does not stand: live kernels need streams, and the only alternative is the rejected agent-as-Jupyter-client protocol |
| D2 | No separate flag | `classes` folds into «доверенная» or is always on; K5b, K9a |
| D3 | Hidden test beside classes | `machineFit` drops its `classes` check, the panel allows both flags, and threat row 2 grows |
| D4 | Owner-only placement | The class form turns read-only for teachers; K9a |
| D5 | Spread the slots | The chooser scores free memory first; folder copies and epochs are paid per machine |
| D6 | A container per personal notebook | K8 grows by about 400 LOC (a slot per notebook, soft reservations, warm spares) and memory per class rises |
| D7 | Another council model | K7 is replaced: a fork executor (about 900 LOC of Python) or containers per attempt (about 1k LOC on the agent) |
| D8 | Manual refresh only | `refresh` defaults to `manual`: one value |
| D9 | Refuse instead of reroute | The worker's entry refuses with words; no reroute |
| D10 | The shared folder for attempts | `enter` skips the scratch folder, the class folder mounts read-write into the council container, artifacts go; parallel writers tear files |
| D11 | GPU council | Cards for council containers, VRAM slices with the 0.22 watcher, CUDA epochs: a release of its own |
| D12 | No teacher lane | One line in `assign` |
| D13 | Other timings | Constants and the class setting; K0 informs |
| D14 | Keep the queue | Queued cells would run on a fresh kernel without variables and fail; not recommended |
| D15 | No re-run | The card says «машина пропала», and the student presses again |
| D16 | The machine wins, or last writer wins | The CAS rule flips, and conflict copies keep home's version instead |
| D17 / D18 / D25 / D31 / D33 | Other numbers | Settings |
| D19 | No host networking | A per-room `--internal` link network, or Jupyter on a Unix socket (an image change); K4 grows |
| D20 | Co-location allowed | Instance-scoped names already exist; home's census and sweeps need instance filters as well |
| D21 | Looser machines | `open` machines become eligible, and the perimeter promise breaks |
| D22 | Teacher-built environments on machines | A registry of your own (0.23 Q3) |
| D23 | No updates during class | `runner update` refuses while placements live, unless `--now` |
| D24 | Reserved memory for classes | A `class_reserve_mb` per machine, left out of the submission offer |
| D26 | k8s homes | A broker path for placements: a project of its own |
| D27 | TLS inside the tunnel | About 300 LOC (TLS-PSK keyed from the machine secret) |
| D28 | No hash seed | The seventh variable and the console's note go |
| D29 | One release | The pool ships with `council: 'shared'` as the default |
| D30 | Skip K0 | Constants stay provisional, and K3b is decided blind |
| D32 | No class quarantine | One rule in placement.ts |

## 20. As built in 0.25.0: what changed from the text above

Every departure the build made from §0–§19, by area, with its reason. The sections above carry the facts a reader relies on in place (marked «As built»); this list is the whole record. The names in parentheses are the phases of §16 «As run». The departures of K8, K12 and K13 (wave 4) are §20.13–§20.15, F4's fixes of the wave's handoffs §20.16, and what is left §20.17.

### 20.1 The relay, measured (K0)
1. **The rig.** One Vast VM in Stockholm played both ends: a probe home behind its own frpc on relay2 and a probe machine dialling it, so every byte crossed relay2 twice, as machine → relay2 → vsos does. `scripts/class-probe.mts` (modes home, machine, watch and selftest; `make class-probe`).
2. **What it found.** Tunnel echo RTT p50 91 ms, p95 317, p99 377 over 10 min at 1 Hz, nothing lost; the ~300 ms tail is the path's, the same for a browser-like socket. One stream machine → home moved 2.6 MiB/s with a 1 MiB window (window-bound), home → machine 9.3. A 2 MB figure took 0.7–1.8 s idle. Sockets survived 20, 40 and 70 s with no pings. A 10 s cut stalled 10.6 s with no reset; 60 s and 300 s cuts reset after the dead timer and lost about 50 KB in flight each way. 1 MiB frames crossed both ways intact. Paced uploads at 4 MiB/s add ~65 ms to a figure; unpaced ones make it 2.5 s.
3. **What it decided.** `TUNNEL_PING_MS` 10 s and `TUNNEL_DEAD_MS` 25 s stay; `TUNNEL_WINDOW` interactive 1 → 4 MiB and council 512 KiB → 1 MiB, 16 MiB per machine stays; class bulk 4 MiB/s and competition blobs 2 MiB/s during classes stay, paced smoothly (a burst of at most 256 KiB, never per-second bursts); `machinePaceMBps` 6 with a 2 MiB burst stays; the help pad stays; K3b is built.
4. **Left for R1.** The hour of resets on a trickling tunnel (the Vast host went offline at 20 min), a figure behind the class's own uploads on the rehearsal rig, and a caddy reload on the rehearsal relay (it sends 1001, and streams must resume).

### 20.2 The contract and the words (K2)
1. The contract additions are listed under §15 «As built»: the exclusive put union and `'dir'` bases, the required `page`, the per-sync caps across reports, one report and one push per class per sync, the epoch semantics and caps, the root rule, `remoteRevisionDigest`, the raised body caps and the cross-block rules.
2. `checkRuntimeEndpoint(value, {environment, revision?, gen?})` throws `RuntimeEndpointError` with its refusal; `RuntimeClient.ensure` uses it unchanged in behaviour.
3. Words beyond the table: the slow start without image progress, the agent's update note (§11.7), the council's refusal when no machine takes its slot (`ef5702`, placement.ts; pool.ts's Docker and broker branches throw an internal English error instead, §6.1), the left names' reasons (§9.4), the conflict copy's name, and an older epoch of one cell. The owner's banners (quarantine, tunnel replaced) live in `admin.ts`, as 0.23's do. Wave 2 added an unnamed twin of every room sentence (K5a2) and the personal notebooks' own sentences; wave 2b made the failover sentences neutral about where the kernel comes back (F), and wave 3 retired the last that named this server (F3). §13.2 is spelled as the code writes it.

### 20.3 The tunnel (K3a, K3b, SB)
1. **One engine.** The frame engine lives in `shared/remote-tunnel.ts` (`TunnelEnd`, `TunnelStream`, `pipeTcp`, the RTT and pace), so both ends run one copy and K3b extended one place.
2. **The council's share.** `TUNNEL_COUNCIL_SHARE` (the machine's window less one interactive window) keeps a full council lane from holding the room's lane back by a round trip.
3. **The door** (§4.2): no refusal for a quarantine or an outdated build, at the door or at the HELLO (§6.3, §11.6, §15, A.3 and D32 say so; §4.2's text did not); the upgrade cap per machine and address; a replacement at the newer tunnel's HELLO; own-address replacement lines capped at 6 an hour, takeovers always written; the banner counted from the event log, so it survives a home restart; an open tunnel's row re-read every 10 s while frames arrive (4401 revoked, 4403 classes off); 403 `forbidden`, a marked 500 `failed`, and a marked 426 for another protocol and for another version's path; 1011 outside `TUNNEL_CLOSE`. The 101 carries the marker, and the agent takes a 101 without it for a hiccup.
4. **Small rules.** `link.next()` answers at once when the link is already up or lost; `reconnect` redials only a tunnel that has been up 10 s; a refusal goes straight to the 1–30 s backoff, `Retry-After` sets the least wait, and the relay is asked on the first failure and every fifth; a Jupyter the agent cannot connect to answers REFUSED `starting`; a stream's last DATA carries FIN when the end is known, else an END follows; an OPEN's lane must be its role's.
5. **Resume, the wire** (K3b). Resume entries carry `fin`; `resumed` and `streams` come together or not at all; an ACK may carry FIN; a greeting fills at most one frame and lists at most 256 streams (`TUNNEL_RESUME_LIST_MAX`), the oldest, the rest resetting at the reconnect; `TUNNEL_PROTOCOL` stays 1, since no release shipped K3a.
6. **Resume, the rules.** No window is larger than `TUNNEL_RETAIN_BYTES`, so every unACKed byte is kept, and an overflow is a connection that writes 4 MiB more after it was told to pause. Streams still opening at a cut reset (their OPEN or its answer may be lost). A stream is held until the peer confirms it: let go of quietly when the peer no longer lists it and its connection is done both ways, reset otherwise. A new agent life counts as resumable only once the agent answers from it (the seeded property test found a lost WELCOME making home judge the old numbering, and close with 4400). Each side counts the 120 s from the cut of an open socket on its own clock; failed greetings in between do not restart it. The dead timer and a greeting timeout cut; violations, protocol errors and internal errors close. The agent closes its end on home's own codes (`HOME_ENDS`), while 1001 (Caddy's reload) and other codes are a cut. Nothing is kept for `close(runnerId)` (revoke, unclass), the re-check, the agent's `want('closed')` or its `close()`. A local connection that closes before both of its sides finished in order resets its stream. `TunnelResumed.reset` counts the streams the cut cost. A listener's `close()` resets every stream of its connections at both ends.
7. **Quiet** (SB). `TUNNEL_PROBE_MS` 6 s and `TUNNEL_QUIET_MS` 12 s (§4.7): without them a 20 s black hole stayed invisible until the 25 s dead timer. Home's `isUp` is false while quiet, and `since` is the last frame. The agent drops its tunnel on `reconnect` only after 10 s without hearing home.
8. **Log lines.** Home: «machine X up from A, N streams resumed, M reset». The agent: `tunnel-up {tries, resumed?, reset?}`, `tunnel-down {code, reason, upMs}`, `tunnel-overflow {key, gen}`.
9. **Import note.** tunnel.ts imports `callCounts` from competitions/remote/routes.ts, and release.ts imports tunnel.ts: a cycle routes → release → tunnel → routes, safe because nothing reads another module while loading. `lost()` drops the link entry of a gen that never had a listener.

### 20.4 Placement (K5a1, I, SD, F, F3)
1. **The tunnel stays open for every machine that may take a class** (§4.6): §4.6 and §6.3 contradicted each other, since eligibility needs the tunnel up and its RTT. A quarantine never closes it.
2. **Preferences** gain «image ready» ahead of RTT; filters gain `sealed`, `full` and `avoided` (§6.3). Facts' mode is not compared with home's.
3. **A start that fails** keeps its row for at most `CLASS_START_MS` after the first failure, then is given up there: the waiting starts hear the machine's words, the row stops, the slot avoids the machine for 30 min. No failover, no quarantine.
4. **Evidence.** Class path evidence and proven silence come from heard.ts (`classPathEvidence`, `classProvenSilence`), and `classTick` notes a pass without evidence itself (`noteClassBlind`). «Syncs arriving» means heard within 15 s (`SYNCS_COMING_MS`, the evidence window), never the class's `failoverSec`.
5. **The outage rule** (F, `outageRule`): `tunnel` only when the machine was heard after this life saw its tunnel go, and within 15 s; `silence` after 15 s of nothing, or right after a `bye`; unknown otherwise, with `failoverAt` null. `PlacementView.quietSince` says since when the rule counts the machine quiet, and another `unreachable` event with staff's words goes out whenever it changes. Before, every silence began as a stuck tunnel and staff were promised 2 min where the class moved at its `failoverSec`.
6. **The stuck tunnel's clock** (SD) starts at the later of the tunnel going down and the start of the machine's current run of reports (`MachineReport.streakAt`, `tunnelStuckSince`): after an outage of home's own road, the first sync back no longer failed the class over a beat before its tunnel returned.
7. **`bye: 'restart'`** (SD): the first `unreachable` event after it carries `cause: 'updating'`, so the room reads «Агент на машине обновляется…», not «Нет связи…».
8. **The quarantine** counts one liveness line per outage, the stretch with the tunnel down (§11.6); a home restart in the middle of one starts another; moves by hand never count.
9. **Owner settings** are their own `classes.` section (`ClassMachineSettings`, `GET`/`PUT /api/admin/resources/classes`): the resource framework holds numbers only, and its test lists every setting name. The new-class default goes through a hook in db.ts, which cannot import the settings.
10. **Blocked ranges.** An invalid entry places nothing new, and live placements keep the valid ranges (stricter than sending none); more than 64 fail the machine's slots over (`blocked`), in `classTick` and while a reply is built; a list is never cut.
11. **Other choices.** An unreadable `KERNEL_SHM` goes out as `ROOM_SHM`, said once; a stop also fences the link; a stop on a machine silent for 5 min counts as done; «ждать машину» also suspends the stuck-tunnel failover; after any loss the slot avoids that machine for 30 min (`AVOID_MS`); an owner's stop waits at most 30 s, and only while the machine still calls; the council (0.26.0) starts with 4 workers when `auto`, sized workers × `attemptMb` + 512.
12. **History rows are never pruned**: one row per slot, so its gen never starts over. The revision pin after a loss (§6.6) reuses the lost row's revision while the slot has not come back, in the same environment, while it is portable: a class whose image changed mid-class may come back here when no other machine holds the old one.
13. **Resizes** are checked against the machine's free memory plus 256 MB (`failed` otherwise, the row keeping its numbers); unapplied raises count in the stale-capacity rule.
14. **`full`.** A machine holding 64 live placements (stopping ones included, the slot's own aside) takes no more; should one ever hold more, `wantedPlacements` keeps ready and unreachable rows before starting ones and logs the cut. `placementCurrent` is true for `stopping` at the current gen.
15. **The wiring** (I): production needs no boot call. placement.ts hands its functions and `placementClock` to placement-store.ts as it loads (`offerPlacementHooks`), and kernel/index.ts takes them at its own load (`takePlacementHooks`), whichever loads first; the app's routes load placement.ts at boot (routes/admin-instance.ts). A suite's `useClassPlacements(next, clock)` wins, and `null` puts every slot back here. `onPlacementChange` is module level and outlives `usePlacements`; `ClassPlacements#clock` is public.
16. **`warmSlot(sessionId, role)`**: a machine or nothing, never a fallback, never a refusal; it skips a slot placed or running here (`pool.ts · runsHere`), and a Run during a warm start shares its gen (§6.8).
17. **The machines' clock** (I): heard.ts `remoteNow()` and `useRemoteClock(next | null)`, read by the routes, liveness, release and heard; the held sync's wait stays on the wall. Without it a moved test clock made syncing machines look silent.
18. **Words.** English strings became words; the «no machine» refusal keeps the machine list in the log only (`07c43f`); `close()` rejects waiting starts with «Сервер останавливается»; a class-wide owner stop pauses `room`, `own` and `council` starts.
19. **Moves** (F3): «Перенести сейчас» off a machine that answers waits up to 10 s for the class's files first (`MOVE_SETTLE_MS`); a move may land on another eligible machine, so no sentence names this server at the loss.

### 20.5 The client over a link and the kernel hooks (K3c, K5a2, SA, F, F3)
1. **The client refuses too:** `restart()` throws while the link is down, besides index.ts's refusal (§5.4).
2. **Restarts are settled by the process** (`header.session`), not the guard's report (§5.4).
3. **More waits for the road:** a kernel start and its first handshake, the OOM comeback and the terminal open wait as the reconnect does; a run checks the road before the socket; help is refused at once while the road is down. kernel_info status frames of link endpoints do not move the room's indicator.
4. **A channel that opens after `detach`/`dispose` is closed**, for every kernel, home ones included: before, it stayed open as a leaked connection.
5. **`reconcileAfterReset`** re-asks while Jupyter says busy (up to 20 rounds), settles only executions out at the cut with no reply, recognises a replaced process, and runs after every reconnect of a machine kernel whose process is known (§5.5). Not changed: at home a command that ends during a channel drop still stays running (rare at home, and a change for endpoints without a link).
6. **The terminal**: `quietPadMs` from the link's average RTT until a p95 is injected (`useLinkJitter`, installed lazily for load order); the prime rule (F3, §5.7).
7. **The hooks are injected**, not imported (§20.4.15).
8. **Named words go to staff only**, as the `kernel:machine` frame's note; the room's sentences are unnamed, depend on the slot (the personal notebooks' own), and a council-only outage never reaches the room's log. Start errors are checked for the slot's machine name before they go into the room.
9. **After a failover the status is `off`, not `dead`**: there is no proactive start; the next Run brings the kernel up (§11.2, step 4). The waiting cell's «ждёт машину» comes from the link field, not from an output written into the cell.
10. **Interrupt is refused only while a cell computes**; a press with nothing running still clears the queue.
11. **A restart that can never be settled** is let go of with no `DELETE`, the status `dead`, and the room gets the existing «did not come back» note. A restart whose kernel was ended by a failover steps aside (status `off`, no note).
12. **The hover** carries `InspectAnswer.unreachable` (reason `busy`) instead of a new `InspectMiss` value, which `CodeEditor.svelte`'s map would show as "undefined" in older tabs; the word is `room.signature.unreachable` (F3).
13. **Warm start**: the class notebook's is `/join`'s; the socket's covers personal notebooks only (§6.8).
14. **`ensureKernel` refuses to start an unreachable slot** without touching anything, so the join warm-up, a hover and Format no longer hang on a closed road; the pump sends such a start back to its gate. A loss during `ensureGuard` is handled, and a start lost under `PlacementLost` fails with an internal `StartLost`: no machine name, the queue-dropped note.
15. **Staff are told in steps** (F): first without a time, then the timed sentence once the rule is known, again when it changes (`Outage.promised`, `promiseOf`, `tellStaff`); «не отвечает с» counts from `quietSince`; a `bye` settles the rule as silence; once the kernel lands elsewhere a note says so (`movedOff`, `sayWhereItCameBack`). Changing the class's placement setting re-tells staff (`kernelMachinesChanged`, F3).
16. **`completeIn`** answers its canned list on the test backend only when no kernel is live, as `inspectIn` does (SA: no test could see a completion reach a kernel before).
17. **A failed memory raise** is said in the room (`570077`, F3).
18. **The test hook `abandonKernelsForTest()`** (I, F) detaches every kernel with no `DELETE` and no document write, for D.20's crash, council attempts and their pending output included.

### 20.6 The sync and liveness of class machines (K5b)
1. **placement.ts is loaded lazily** (`ClassPort`, `loadClassPort`), never statically: it pulls in the pool, the config and the runtime client and would close cycles through lease.ts and routes.ts. The loader also covers a home restart, whose first answer to a class machine must not be an empty wanted set (the agent would remove every container).
2. **Not every block from a machine without classes is refused.** One that lists class containers starts the stored wind-down (`remote_runners.classes_winding_down`, which survives restarts of both sides); while it is set, every reply says to hold nothing and the machine gets no hidden test; a block listing none ends it, and only an empty block from a machine that is not winding down gets 400. An agent too old to send blocks keeps the flag until it updates, which is harmless: an outdated machine takes no work.
3. **`classRevisionsWanted`** is typed `RemoteWantRevision[]`, and want.ts checks portability again; a GPU class's personal slot wants the image with `gpu: true` (the revision's own bit).
4. **One wanted set a reply:** `noteKernelsReport` runs before `wantedPlacements`, which runs once per reply built (it counts replies for its resize acknowledgement), and the outcome take uses `intentsSent`.
5. **File reports are not fenced by the sync**: a report carries a gen but no role, and gens of different slots on one machine can coincide; the copy's gens and the PUT door fence (§6.9, §20.8).
6. **Not done:** the optional takeover signal (a sync saying `kernels.tunnel: 'down'` while home holds an up tunnel of it from another address).
7. **A GPU room's card**: `classShare` counts a GPU room as holding its card only once its sync entry at its gen carries `card` (the agent picks the card only after the image is ready, and reports it free until then); while any GPU room waits for its card, the take leases at most (whole free cards − GPU leases not yet on a card − waiting rooms) GPU runs, so a run never lands on the room's card. The free shares of cards already in use go unused meanwhile.
8. **A sync decides on the row as it stands after the body**: a revoke during the upload gives 401 before anything is taken in.
9. **The probe is due half a beat early**: interval timers fire up to a millisecond early, and a skipped beat delayed a class probe to 10 s.
10. **D3 at the take**: `machineFit` refuses sealed rows on machines with classes on (or winding down, or holding a live placement: `classesBeside`); `runner.enrolled`'s audit detail carries `classes`.

### 20.7 The kernel host and the perimeter (K1, K4)
1. **Cores.** The machine's argv differs from home's in more than §17.1 names: the network, the publish form (`-p 127.0.0.1:0:8888`), and labels; the log caps are spelled `--log-opt=max-size=8m` / `--log-opt=max-file=2` as docker-runner.ts spells them, right before the image. Guards fail closed: a memory, CPU or process limit of 0, a hash seed out of Python's range, and on the machine path a bad class id, role, gen, label or subnet throw instead of starting a container with no limit. Chains are `COLLOQ-MR<i6>-FWD`, `-IN` and `-DENY` with `<i6>` lower case, as in every other name, and the bridge is labelled `colloq.kind=class-network` plus the instance label.
2. **D21.** An `open` machine is not refused: the intent carries home's floor (an open home sends `blocked`), the machine applies the stricter of the two (`machinePerimeterPlan`: `none` if either says so, else `blocked`, with both lists of ranges), and `open` never applies on a machine. `facts.mode` is the machine's own floor, reported, not compared.
3. **The kernel host** (§7.2, §7.3, §7.6 «As built»): adoption in the second sync; facts, the perimeter and the canary on the first reply with the block, or at adoption; dead containers started again at the same gen by the agent; starts retried 10 s doubling to 5 min, removals on their own clock; counters once a minute; the orphan rule's thresholds (120 min of home's silence, 5 % CPU for 5 min); `failing` held until an install succeeds; the canary's two ephemeral ports; a class's folder copy kept after a normal removal of its containers only while home still names the class on the machine: once a reply to a sync that held none of its containers names it nowhere, the agent removes the copy, its baseline and its staging (`RoomFiles#reconcile`, `wipe`, K6b), so no warm copy waits for §6.3's last-host rank; the tunnel module by dynamic import; unknown facts failing closed; the 400/413 rule; unreadable records keeping their containers; the spec digest hashing the profile and the machine flags.

### 20.8 Files both ways (K6a, K6b, SC, F3)
At home (K6a):
1. **409 `revoked`** for a fenced gen, not `stale`: `REMOTE_ERRORS` has no `stale`.
2. **The settle rule** (§8.7): a settle needs a sync that arrives at least 3 s after the scan went out and after the pushes the machine already had were acked; a sync that crossed the scan never counts; at 3 s the next reply asks again, so a held sync comes back at once. It can still pass early while the agent hashes a large file (the agent does not say which scan it finished: open, R1 measures). Machines not heard within 15 s are not waited for, staff's «Привезти» pulls do not hold a settle, each caller has its own timeout, and a settle counts as recent only when it settled. The page build settles before it enters the publish queue.
3. **Eager pushes** go out 1 s after any write at home (D16) and never replace one in flight; a push planned while another is unacked carries no moves; push numbers start from the wall clock's milliseconds at boot, so they exceed any earlier life's.
4. **Notebooks are off the run path**: the barrier never waits for the room's notebook files, which every run's outputs rewrite; they follow in the background push.
5. **A fresh copy or a rebuild** is decided by whether every live row of the class on that machine was written in this life (`createdAt` ≥ `remoteBootAt`).
6. **Shape changes** (a file where home has a folder, or the reverse) are refused; a folder removed on the machine is removed here only when empty. Whether a path is gone is decided by its nearest folder still here, as the agent decides it.
7. **Notes** go to the room's kernel log without the machine's name, at most 30 per class per 10 min; a late list is named only for classes the machine served in this life, and (SC) only for a gen the class lost there: an ordinary stop said «вернулась после переезда» before.
8. **A Stop ends a wait at the barrier**: the cell is left at rest, a council attempt ends as no run, and the machine-unreachable refusal of Stop no longer applies to a cell still at the barrier.
9. **Pushes**: small files past one reply's 1 MiB inline budget wait for the next push of a chain rather than becoming blob GETs, and a reply holds back a push that would overflow its budget; a copy keeps at most 2 unacked pushes (the oldest one a reply carried and the newest); a pulled conflict copy's verdict waits until its bytes land; a report with the same path, sha and base gets the copy already kept, never a second one; the fast path is skipped while a refusal has not been pushed back.
10. **«Привезти»**: the version brought counts as the base of a later report with no base until a push of that path is acked; `FileEntry.newer` marks a file this server has whose different version stays on the machine («Привезти» lands it on the reported base, replacing this server's file rather than making a conflict copy).
11. **Class traffic has its own rate buckets**: `roomBlob` and `roomFile`, 1200 a minute each; a blob one of the class's pushes names counts in the first.
12. **A copy is tied to the gens it serves**: home naming the class on a machine at gens the copy never served starts it again with a full push, and so does a machine that says it applied fewer pushes than it did, or holds a current slot with no lag; a Run at the barrier waits for that full push. Placement news drops a copy at once and lets its runs at the barrier go.
13. **Small fixes**: the staged file's size is left out of the room count; the topmost missing path is removed; a file here where the machine has a folder is removed there and put again; every missing folder above a package row is made up so the row shows; a target's folders are made only when the checked bytes land (a refused PUT leaves none); a 410 from the blob door forces a fresh walk; downloads, and moves or copies of a path with a newer version on its way, wait for it; `caps` is sent only when not the defaults. Folder modes under the setgid class folder stay what this server's own writers make (a decision for the whole workspace, not this door).

On the agent (K6b):

14. **Busy** is the census's word, not tunnel bytes (§8.3).
15. **The quiet rule**: stats with ctime, 2 s on the agent's clock, no mtimes; a new top-level folder held while new paths keep appearing in it, 30 s at most.
16. **Hashing** in place through a descriptor that follows no link; what travels is copied to `<id>.staging` while hashed; inline content read and hashed again before it goes; nothing over `machineFileMb` is hashed or staged to be kept aside.
17. **The upload** is made in room-files.ts (`homeUploader`: paced, chunked, no `Content-Length`), the client being another phase's; the promoted rate is `max(classBulkMBps, 8)`, since the reply names none.
18. **Report seqs** are seeded from max(the persisted one, the clock in ms), so they never repeat across agent lives; each page of a full report has its own seq, and a page said again keeps it.
19. **Applying pushes**: duplicates are recognised by whole content, not by seq; a full push drops the queued pushes and abandons the one under way, which is never acked; a failed step is skipped only when a later queued push touches the same path; a put whose hash equals the agreed one does not overwrite a pending machine change unless home refused that change; a move whose source is gone re-creates the agreed files at the target by fetching them by hash.
20. **Conflicts**: a machine version that a push overwrites or removes is kept (in memory, the `kept` store, until uploaded or refused or 60 s after the last pull naming it) and reported once with its old base; «Привезти» never sends a kept version.
21. **Fencing** is of the whole copy, decided by the gens recorded in the baseline: the agent waits up to 60 s for the old containers to go, says the late list, then removes the copy; a class placed there again at new gens keeps its copy and reports `pushSeq` 0 until home's next push lands, so an old placement's late writes may then be accepted (§8.8).
22. **Package trees**: a new top-level folder a package owns becomes one skipped entry sized from its RECORD; in shared folders (`bin/`, `lib/`, …) only the listed files stay on the machine; past 5000 entries the rest are skipped as `count`.
23. **Disk**: the room files keep their own hash book (`books/room-hashes.json`, with ctime; the old book is ignored, so every class file is hashed once after the update), and a class blob leaves the CAS once copied. The walk is asynchronous, yielding every 256 entries; the one blob stream ranks its jobs (a promoted class blob, a lease's blob, a class blob, prefetch) and a higher rank preempts the job under way, which resumes with a Range; counts are clamped to `Number.MAX_SAFE_INTEGER`; leftover `.colloq.saving-*` temps go at each copy's first scan after a restart; ownership is set before the mode (the other order cleared setgid on macOS).
24. **Cut syncs** that came before the request reached home delay those reports by up to 60 s; the kept bytes live in memory only, and an agent restart loses them.

Found by the scenarios (SC) and fixed in F3:

25. The agent no longer cuts its held sync after an upload: home had just woken that sync to carry the verdict, and a verdict was sent once. A «Привезти» acceptance enters the baseline at the version its PUT sent; an agreed big file that has not changed is no longer skipped as `size`.
26. Verdicts are said again (`replySeq`/`heard`, §15); a stop names the late files it dropped (`d5fceb`); a «Привезти» pull is dropped when its path comes back in `released`, and a kernel's pull is let go after 60 s when the machine says nothing is pending (after an agent restart, say); a push's moved files are inside the room blob scope.

### 20.9 The council in 0.25.0
The pool (§9, K7a–c, K9b, K11b, K12b) is 0.26.0 (D29). In 0.25.0:
- every attempt runs in today's notebook FIFO, in the notebook's kernel wherever it runs: on a machine when the class notebooks are there, here otherwise;
- the class setting's `council` field (`shared` / `machines`) and the presets that set it to `machines` are stored, with no effect yet; the form draws no «Консилиум» part nor «Попыток одновременно» and «Память на попытку» until the pool is there (`COUNCIL_POOL`, F4), and no word of the panel's promises the pool;
- the contract carries the council's role, epochs, collects and `workers`; placement.ts sizes a council slot (4 workers when `auto`) for when one is asked for and refuses one no machine takes (`ef5702`); pool.ts's Docker and broker branches throw the internal `COUNCIL_ON_MACHINES_ONLY` for a council endpoint; nothing asks for one;
- the council's words (pool not ready, left names, rerouted, older epoch, adopt behind, lost mid-attempt, hash seed) are in `server.ts` for 0.26.0.

### 20.10 The panel and the room (K9a, F3)
1. **Z4**: three tiles, the last a GPU class's card tile; the live line names a card count (the outlook carries no model); the new-class form has no live line (no session yet), only the no-machines refusal; presets are hidden for a teacher kept out, the parts greyed; under the broker the form shows no placement (`classesOnMachines`, `ClassMachineSettingsResponse.backend`).
2. **Z5**: the chip sits in the notebook's bar, not the masthead, with a short form on a narrow bar («Нет связи · 0:23», the timer drawn apart so it never shrinks); the chip and the banner count from the server's clock (`clockSkewMs`); «На сервере · переехало в 14:33» shows within 12 h of the move and while the class is not finished. «Ждать машину» PATCHes the seminar with `placement.failover: 'wait'` and the banner switches at once; it is offered only when the class moves by itself and the viewer may change the setting, read from the frame or from `GET …/placement` when an outage begins; the banner's neutral sentence (`room.machine.banner.lost`) stands in until the server's sentence comes.
3. **Z6**: no «· 40 %» (nothing in the tree carries progress), and the over-cap note leaves out the cap's number; a file only on the machine gets its own menu («Привезти» first for staff; open, download, duplicate and rename disabled, `room.files.machine.notHere`); Run behaves as for any file, and Delete removes the file on the machine (F4, §8.5); «Привезти»'s state comes from the tree (a row both on the machine and `pending`), and a press nobody answered is cleared after 10 s.
4. **Z7**: `RunningMachineSlot.rttMs` («связь 52 мс») and the failover's `filesAt` («файлы — по 14:31:58»), kept per slot from its `lost` event; machine names and the files lag go only to the class's staff.
5. **Z1–Z3**: the class line during an outage counts from the tunnel; the class count is of distinct classes over standing machines; a class-settings load failure other than 404 shows a retry; the role chips sit in the state line on a phone.
6. **Doors and audit** beyond §15: §15 «As built». Class settings are audited as `settings.resources_changed` (target `classes`); the classes toggle, resume and move as `runner.classes`, `runner.classes_resumed`, `runner.classes_moved`.
7. **A canary not run yet reads as a wait**, not a failure.
8. **Words beyond the table**: «проверка допуска пройдёт, когда на машине будет образ класса», «Нет связи · {elapsed}», «0 ядер здесь», «остановится, когда машина выйдет на связь», the neutral banner, the hover word.
9. **The live check** (`scripts/ui-check.mts --classes-only`) does not drive Z6 in the browser yet.

### 20.11 Packaging (K10)
1. colloq-host's messages are English, as all its messages are.
2. `runner up` learns «with classes» from an explicit `--classes` (§14).
3. The tunnel protocol check (§14): the new image's protocol read from its entry point, home's taken to be the running agent's, only while class containers exist, and passed for the release home runs. Finding 3 of its review was rejected because the door accepts outdated builds (§20.3.3): should the door ever refuse them, this check must refuse a build change under live classes too.
4. Exit code 3 for a leave refused for classes, so `make runners-down` can answer `--force` for an operator who already confirmed the destruction.
5. 20 GB for the class folders on top of the disk floor (the design named no number).
6. The move from 0.24 (§14), and `class_count` and the leave's question counted by the tree's instance label, so two agents on one Docker do not ask about each other's classes; the D20 check asks for the rooms' network too. A refused leave on a machine joined with a plain `docker run` has taken it over by then (colloq-host's settings written; nothing of the agent changed).
7. The agent's `runner drain` (`docker exec colloq-runner colloq-vast runner drain`, run by colloq-host's `runner update`; colloq-host itself has no `runner drain`) counts leases only (K10's question, confirmed in `runner-agent/control.ts · drain`: `held` is the attempts held), and so does its leave: class containers run through both uncounted.
8. The entry point finds its own container under host networking (§7.5) and holds `TUNNEL_PROTOCOL=1` equal to the shared constant.

### 20.12 Tests and harness (E, SA, SB, SD, SC)
The scenario files, the timings through the harness entry, the clock steps, the one-direction cut and the fake's additions are under §17.2 «As built». Also: the first harness dialled its tunnel from the test process after stopping the agent (two ends with one credential kept replacing each other); the scenarios use the agent's own tunnel. `mintCode({classes})` mints in the store, as `runner-code --classes` does. The probe uses production code's 10 s abort, so probing through a black-holed proxy waits 10 s (use `cut()` for a fast failure). A reset is passed on after the bytes queued before it, which TCP may drop as the reset lands, as on a real path.

### 20.13 Personal notebooks on machines (K8, F4)
1. **The ceiling counts what is coming up, everywhere.** Kernels still starting count toward `ownMax` here too, not only on machines (`holdsOwnPlace`): forty students pressing Run at once all start before any is up.
2. **Idle retirement** waits for a road that is down only on the kernel's live placement; any retirement lets go of a kernel whose placement was stopped under it, with no `DELETE`. Since F4 such a kernel is ended at the stop itself (`endUnderStop`, «Ядра личных тетрадей на машине остановлены: …»), so its place under the ceiling and its notebook's next Run do not wait for the sweep.
3. **No warm start for a lecture.** A class whose rules allow no personal notebook (`ownBooks` off and no notebook given to its owner) warms nothing.
4. **The machines' bound** (§6.2, §6.4) counts machines online or not, quarantined or drained, and skips those whose class facts rule out every placement; a GPU class's class notebooks on machines are held to machines with cards; memory and cores may name different machines. Drained machines still count, as PR #51's submission ceiling counts them: every agent update drains for minutes, and a bound that dropped then would refuse a form that was fine a minute earlier.
5. **Whose number.** The class's number governs its personal notebooks only while they have no number of their own (`ownLimits`); since F4 their own numbers are held to their slot's place the same way (`ownNumberBounds`, `ownNumberMax`).
6. **Old words where nothing moved.** A class entirely here keeps its old refusal words; the place is named only once a slot the number reaches is set to machines.
7. **The container's stop on machines.** Only a notebook with a Python there, coming, or waiting keeps it (`keepsOwnContainer`); only a placement some personal kernel of the class used in this process is stopped (`ownPlacementsUsed`), at its gen (`stopSlot`, `ClassPlacements#stopAt`), whichever notebook retires last.
8. **The placement-change check** runs in both directions (a class moved here with a number this server cannot give, or to machines with one none can) and ignores rules changed in the same request (the panel never sends both); it refuses the move rather than clamp the number.
9. **The fallback refusal** checks only the class's own stored number (`pastThisServer`): environment defaults are this server's to give, as for a class here.
10. **The form** draws the machines' line from the seminar's `bounds` (Seminars.svelte passes them since F4) and this server's free memory only for a number a slot here takes.
11. **Tests.** «room on A, personal on B» is a scenario of `tests/classes-e2e-own.test.mts`, not a unit test; the fake docker records `--pids-limit`.
12. **Words** (§13.2): the eight server sentences of the bounds and the move (`onTheMachinesThisClassComputesOn.8a0084`, `.dc2f4b`, `onThisServerTheClassMayBe.93fb13`, `.e52ca3`, `theClassHasMbOfMemoryLower.e34f97`, `theClassHasCoresLowerThemBefore.1f3d8b`, `noMachineCanTakeTheKernelNow.f1fc7d`, `.81688a`, their keys renamed to the convention later keys follow: the first words camel-cased, the sha1 of the English) and the panel's `admin.resources.machinesBoundMemory` and `machinesBoundCores` beside the two of wave 3.
13. **Rejected:** a clamp of the class's number on a move (refused instead); ending kernels whose placement stopped under them (done by F4, with room words of its own); a delayed `DELETE` for a notebook retired during an outage (it could kill a session a new kernel re-attached to by path: open, §20.17).

### 20.14 The load generator (K12)
1. **Click patience scales with the class**: a tenth of the round, 1.5–60 s, so an hour-long class still gives a click a minute; while its cell is queued or running, or the socket is down, it keeps waiting up to that cap, and each round the teacher presses the next cell while the long one runs (Shift+Enter), which fills the "behind its queue" row.
2. **The rig sets a run limit on its room**: its longest cell plus 10 s, so that only the cell made to outlive it is stopped; without personal students the row says "not measured".
3. **The 10 KB edit is an upload overwriting a file**: for the files barrier the same change as an editor save.
4. **The CSVs and the big upload** run once a class, in round 1; the bytes row tells the operator how much of these datasets to subtract.
5. **What the client cannot see** stays out: the barrier's "0 round trips for no change" is a server-side count.
6. **Staff reads beyond the plan**: the environments (for `gpu` or a named one), the resource settings (the upload limit, checked before anything is made), «Работают сейчас» every 30 s, and the seminar list (only when a create's answer was lost).
7. **Reconnects** as the web app makes them (its jittered delay and the room's existence asked every fourth failure; y-websocket's ladder and the 30 s silence close), offline acts held back as its queue rules say (`enqueueControl`); a 4403 is never answered by a fresh resync — in the rig's class nothing a rule refuses is edited, so a 4403 is a bug of the rig's or the server's, and the report says so in red.
8. **Found by it** (F4, §20.16): runs waited behind the notebooks' pushes while students typed (the personal notebooks' p95 13.8 s against 41 ms without typing).

### 20.15 The parity job (K13)
1. **As run on GitHub's Linux**: the agent in a container as uid 1000; the containerd image store; the disk cleaned first; one wall-clock wait that lines the long cut up with jupyter_server's ping timer; the ping timeout and the "Replaying" log line recorded in `facts.txt`, not asserted.
2. **A path-filtered `pull_request` trigger** beside the nightly run and `workflow_dispatch`: GitHub dispatches a workflow only from the default branch or one where it already ran, so the release PR's push is what runs it first.
3. **Bounds of 90 min (job) and 70 (test step)** instead of 60/40, so the file's own (7 min before, 48 for the seven scenarios, 5 after) fit inside the step.
4. **The machines' clock is the file's own** rather than `liveness: 'auto'`: auto's probe uses the test's loopback public URL, which never counts as evidence, and the Home harness has no probe option.
5. **What it pins** (§4.8, §5.5, §11.1, §17.3): `header.session` across a second socket and a restart; the inner channel's close after jupyter_server's ping timeout, which resume cannot prevent; a cut of the machine's leg alone failing over at `failoverSec`, before that close, and a dark relay keeping the class; the sparse-file clamp (521 files of holes, `Number.MAX_SAFE_INTEGER` bytes, no sync refused); the agent's restart from sources against the class's `failoverSec` — a slower restart on GitHub's runner is a product finding for R1, not a reason to loosen the test.

### 20.16 Wave 4's last fixes (F4)
1. **A «на машине» row's Delete** removes the file on the machine (§8.5): a remove in every push until one carrying it is acked, the row gone with the ack or the machine's `released`; the agent keeps no conflict note of a file home knew stays there; a push's acked remove takes the rows under it; the room's tree hears every change of the machine's rows at once (before, a new or released row waited for some other change of the tree).
2. **The files first before an unclass and a leave** (§8.7, §11.5): `settleRunner` behind the owner's PATCH, `settleForLeave` in the agent before its sync says `leaving`.
3. **The chip** «Переносим ядро…», not «Переносим на сервер…».
4. **«Привезти» answered** in its own frame, `files:fetched` (accepted, brought, refused in words), the panel letting the press go on it or on a closed socket; no 10 s timer.
5. **A proxy's 413** is a refusal: the version stays on the machine as `proxy`, home lets the pull go and says why once, «Привезти» refused in words (§8.5).
6. **Node's request timeout** spares the machines' upload doors while bytes move (`allowLongBody`, `answerClientError` in net/long-body.ts, with Node's own answer for every other client error): a 1 GiB «Привезти» at the shared 4 MiB/s outlasted Node's 300 s.
7. **Runs wait for no notebook-only push** in flight (§8.2).
8. **No last-host rank** (§6.3): its reason, the warm copy, was gone since K6b.
9. **Kernels whose placement stopped under them** are ended at the stop (`endUnderStop`, §10).
10. **The personal notebooks' numbers** held to where their slot computes, on the server and in both forms (§6.2).
11. **Words that named this server too early**: the machine row's and «Работают сейчас»'s «перенесём в 14:41:19», the perimeter banner's «поднимется заново», the log's «занятия перенесены с машины», colloq-host's and `vast-runner.sh`'s leave lines («moves them off it»), and their panel path «Resources → Machines»; the rate note says the speeds are for all machines together (the buckets are shared); `admin.runners.note` and the machine page's class section no longer promise the council, and `admin.runners.ownerOnly` names machines for submissions and classes.
12. **The council's part** of the class form waits for the pool (`COUNCIL_POOL`, §6.2), and the second tile reads «Личные тетради — на машинах».
13. **The slow start for staff** (§13.1 Z5): the server's named sentence is drawn while the slot starts.
14. **Tests**: the warm test of `class-kernel-hooks` gives its classes `ownBooks: 'on'` (K8's rule); C.12 deletes a «на машине» checkpoint through both roles' sockets; D.21 brings a cell's last file home before an unclass through the owner's door and before a leave; the rest are unit tests beside each change.

### 20.17 Open at the end of 0.25.0's build
- **R1** (the rehearsal): run the parity job (push the branch, open the release PR; then `gh workflow run classes-smoke.yml --ref feat/class-machines` works too) and read `facts.txt` (the ping timeout, the channel's close, resumed or reset streams, the replay order, the post-mortem sentence, the chain names, the file modes, the re-sent verdicts, the agent's restart timings, the clamp's numbers); `class-load` with `CLASS=home OUT=home.json` then `CLASS=machines BASELINE=home.json` at the same N and OWN, `BIG=150` with the home's upload limit raised, the rig's address in `SHARED_ADDRESSES` past 60 students; the Python cells against a real kernel; reconnects across a real home restart; `to_csv` → the panel on the rig (the e2e saw 0.05–1 MB in 0.76–6.7 s, one sample each); per-sync latency against `SYNCS_COMING_MS`; a submissions-only machine's evidence at its 25 s idle hold; the «never took in N replies» lines; the 3 s settle and the move's and unclass's settles against real scan times; scan cost on a large class folder; a caddy reload's 1001; the relay's bytes per class-hour; after a home restart, personal kernels nobody re-attached to are not counted by the ceiling; a notebook retired during an outage (an access change, a deletion) leaves its Python on the machine, uncounted, until the container stops (its `DELETE` times out; a delayed one could hit a session a new kernel re-attached to by path).
- **Lead**: `classPlacements().close()` before `machineTunnels().shutdown()` (optional); the writer's timed flush in a simulated crash (needs an injectable timer in outputs.ts); commit the regenerated `site/docs` with the sources.
- **0.26.0** (K7a–c, K9b, K11b, K12b): the council's pool, and with it the form's «Консилиум» part, its two numbers and its preset's name (`COUNCIL_POOL`); the epoch items of §17.3 in the parity job.
