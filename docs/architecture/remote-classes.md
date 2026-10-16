# Classes on machines («занятия на машинах»): design

**Status:** final design, to be built after the Paper pass (§13). Written 16 Oct 2026 against 0.24.0 (`bc96401`); this file becomes `docs/architecture/remote-classes.md`. It extends `docs/architecture/remote-runners.md` ("the 0.23 doc"). The owner decisions there (§12) and the implementation notes (§13–13e) stay binding, except where a default below says otherwise.

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

## 0. The design in one screen

| Decision | Why it is the right size |
|---|---|
| A class's slots are placed one by one, at home or on a machine. A per-class setting picks where (§6.2). The switch is one early branch in `endpointForSession`, after the gates (pool.ts:2136-2143) and before the backend switch (pool.ts:2144) | `JupyterKernel`, the terminal, `OutputWriter`, the guard, `runCouncilOne` and the idle sweep run unchanged against a `KernelEndpoint` that happens to point at a machine |
| Home stays the Jupyter client. The agent dials one multiplexed WebSocket. Home opens a `127.0.0.1:0` listener per placement and pipes every accepted TCP connection, as a stream, to that container's loopback port on the machine. Lanes are strict, the send buffer is shallow, and machines pace below the relay's capacity | jupyter.ts and terminal.ts keep REST and their two WebSockets byte for byte, and the agent parses no Jupyter. The one TCP leg relay2↔vsos that every student shares never builds a queue ahead of a keystroke |
| The link never turns a network problem into a death. Reconnects wait for the link instead of spending the 8-try budget. Failover detaches instead of sending `DELETE`. Restart and interrupt are refused while a machine is unreachable. A reset that ate a reply is settled by `reconcileAfterReset`. Streams resume after a cut if K0 shows cuts | A relay blip costs at most the running cell's output, never the variables |
| Control stays level-triggered on the 0.23 `POST sync`. Intents, file pushes and pulls, epochs, census and post-mortem readings ride one optional `kernels` block. Home pushes by answering a held sync early (`wakeRunner`, wake.ts:55) | A lost reply, a home restart or an agent restart is a delay, by the same mechanics as leases. There is no push RPC |
| The agent starts class containers with home's argv (`roomRunArgs`, a pure core split out of `runArgs`) and home's perimeter (`perimeter-core.ts`). It adds `--pull=never`, Jupyter on 127.0.0.1 only and a `colloq.kind=class-kernel` label, and it adopts the containers after its own restart | The sandbox is the same by construction, held by an argv parity test. Kernels outlive agent restarts and fleet updates |
| Files: home is the truth. A barrier before every run pushes what home wrote; with nothing written it is a counter compare. The machine reports kernel writes after every run and every 5 s while a kernel is busy. Home applies each change by compare-and-swap on the base: when it loses, it keeps a conflict copy, and deletes never come back. Caps apply; package trees and over-cap files stay «на машине» | Home's ~40 synchronous readers (editor, downloads, publishing, the oracle, backups) keep reading home's disk |
| Council: an epoch (pickle 5, out-of-band buffers by content hash, refreshed after the teacher's history runs) is loaded once into a pool of ipykernel workers. Each attempt runs today's enter → attempt → leave in a worker, in a scratch folder of its own. Names that cannot travel send the attempt to today's shared kernel | Attempts run in parallel, independent of the main kernel and its queue. Outputs, ✓/✗, show and adopt keep working through `CouncilJob.onChange` (kernel/council.ts:65) |
| Failover only on proof: 60 s of silence on both channels with path evidence; a revoke, unclass or leave; or «Перенести сейчас». The kernel comes back at home or on another machine without variables, with files as of the last sync | A relay blip, an agent restart or a fleet update never costs the class its variables |
| Trust is a separate flag, off by default. A class machine gets no hidden test | A class machine sees everything its classes have (§12) |

**Cost.** About 9.6k LOC plus about 6k LOC of tests, in 22 phases over 7 waves of parallel agents with disjoint files (§16). The resume layer (K3b, 0.4k) is built only if K0 says so. Two releases (D29): 0.25.0 is useful on its own, and 0.26.0 adds the pool on top without touching what came before.

**vsos (8 vCPU, 16 GB).** The default for its new classes is «Консилиум и личные тетради — на машинах, тетрадь класса — здесь» (D31). The lecture keeps its latency, and the per-student load (thirty personal kernels, thirty parallel attempts) leaves vsos.

## 1. Goal, acceptance, non-goals

**Goal.** A teacher picks, per class, where it computes. Putting compute on machines covers:
- the class notebooks' kernels, with output, interrupt, restart, help, the terminal and file runs;
- personal notebooks;
- council attempts, which run in parallel and independently of the notebook's kernel and its queue.

Around that:
- files go both ways, with home as the source of truth;
- a lost machine fails over automatically;
- all of it shows in «Работают сейчас», in «Машины» and in the console;
- machines join with the same agent, image and one command as in 0.23.

**Acceptance.** Measured in the rehearsals R1 and R2 (§17.5). These are targets until K0 measures the relay.

| Area | Target (EU machine, home behind relay2) |
|---|---|
| Cells | `print(1)`, click to visible: at most +150 ms at p50 and +400 ms at p95 over the same class at home |
| Help | Completion under 1 s at p95, inside its 2.5 s budget (`SHELL_REQUEST_MS`, jupyter.ts:130). The value line answers within its wait plus the pad at least 95 % of the time |
| Interrupt and limit | KeyboardInterrupt is visible within 300 ms at p95. A run-limit SIGINT lands within 1 s of the limit |
| Terminal | `echo hi` shows its output within 300 ms at p95 |
| Files | A Run after no file change pays 0 extra round trips; after a 10 KB edit, at most 400 ms. A 150 MB upload is readable by the next cell within 25 s. A 1 MB `to_csv` reaches the files panel within 2 s of the cell's end |
| Council | 30 attempts of about 2 s each, pressed within 10 s, all finish within 20 s on 8 workers; today one FIFO takes over 60 s. Per-attempt overhead is at most 1 s at p95. The notebook's queue never holds a pool attempt |
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
     ├─ colloq-class-<i6>-<id>-council  N worker kernels; class folder :ro, epochs :ro, scratch :rw; no card
     └─ submission sandboxes (0.23, unchanged)
   /var/lib/colloq-runner/rooms/<id>/                 the class folder copy (uid 1000, 2775), shared by the class's containers
   /var/lib/colloq-runner/council/<id>/{epochs,scratch}/
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
  - The machine must be `active` or `draining`, have `classes = 1` and a compatible build, and upgrade at most 12 times a minute (`net/too-often.ts`).
  - The request carries `X-Colloq-Tunnel-Protocol: 1`.
- **Refusals.** Before the upgrade, as marked JSON: 401, 403 (classes off or quarantined), 426 or 429. The browser doors keep refusing `cr1` (socket-authorization.ts:63), and this door refuses everything else.
- **One tunnel per machine.** A newer tunnel closes the older one with code 4409.
  - Every replacement writes a `remote_events` row, `tunnel_replaced`, with both addresses.
  - More than 3 replacements from different addresses within 10 min raise an owner banner: a stolen secret looks exactly like that.
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
- **OPEN** goes from home to the agent: `{key: "<session>:<role>", gen}`. The answer is OPENED, or REFUSED `{code: 'gone' | 'stale' | 'starting'}`. An OPEN from the agent is a protocol violation and closes the tunnel.
- **HELLO and WELCOME** open a tunnel session: `{protocol, build, session}`, where `session` is random per agent life. They carry `resume` only with K3b (§4.8).
- No verb rides the tunnel. Placements, files and epochs are the sync's business.

### 4.4 Lanes, windows, pacing
- **Lanes.** Strict priority: control, then interactive, then council. Within a lane, streams take deficit round-robin turns of 16 KiB, so a 6 MiB figure from one kernel interleaves with another kernel's `print`.
- **A shallow socket.** A frame goes to the WebSocket only while `bufferedAmount` ≤ 64 KiB (`TUNNEL_SEND_LOWAT`). Everything else waits in per-stream queues, where the lanes still apply. An interactive frame waits at most about 7 ms (64 KiB at 9.5 MB/s) plus one frame.
- **Windows.**
  - A sender may be at most `TUNNEL_WINDOW` bytes past the peer's ACKed offset: 1 MiB per interactive stream, 512 KiB per council stream, 16 MiB per machine in all.
  - Receivers ACK every 50 ms or 64 KiB, as their local socket drains.
  - A sender out of window stops reading its source socket. A flooding cell is then held in jupyter_server's buffers and behind its iopub rate limit, never in home's memory.
- **Pacing on the machine.** Lanes 1–2 from machine to home pass a token bucket at `machinePaceMBps` (6 MiB/s) with a 2 MiB burst. One figure is never delayed, and thirty attempts' plots cannot fill the shared leg.
- **Limits.** Bulk bytes never ride the tunnel: files and epochs travel by their own HTTP requests, paced as in §4.9. At most 512 streams per tunnel.

### 4.5 Home's end: listeners, endpoints, the link
New module `server/src/kernel/remote/tunnel.ts`.
- **Listeners.** One `net.createServer` on `127.0.0.1:0` per placement while it is `ready` or `unreachable`. Each accepted socket becomes an OPEN on the machine's tunnel. While the tunnel is down, new sockets are destroyed at once: a fast `ECONNRESET` instead of a hang, which `confirmAlive` (jupyter.ts:708-733) reads as alive.
- **The endpoint.**
  ```ts
  { url: 'http://127.0.0.1:<P>', token, instanceId: `${runner}:${container}:${gen}`,
    identity: `machine:${runner}:${container}:${gen}`, link }
  ```
  The URL is an origin root: undici pools connections per origin, so placements never share keep-alive. `endpointIdentity` (jupyter.ts:182) returns `identity` when it is present. Because it is URL-independent, the terminal's remembered pty (terminal.ts:322-337) survives the new port a home restart brings.
- **The link.** `KernelLink { up; rttMs; since; next(timeoutMs): Promise<'up' | 'lost' | 'timeout'> }`, one per placement gen, read off its machine's tunnel. RTT is an EWMA of the PONGs, and the p95 over 5 min feeds the chooser, the help pads and the panel.

### 4.6 The agent's end
New module `server/src/runner-agent/tunnel.ts`.
- **Dialling.** It dials `wss://<home>/api/runners/v1/tunnel` while the sync reply says `kernels.tunnel: 'open'`. Home says so while the machine holds any placement.
- **Reconnects and proxies.** It honours `HTTPS_PROXY` (`installOutboundProxy`). Backoff runs 0.5→5 s for five tries, then the 0.23 `Backoff` (1–30 s), with `relayState` to tell "home offline" from "refused".
- **Streams.** For `OPEN(key, gen)` it looks up its own placement record. A stale gen gets `REFUSED stale`. Otherwise it connects TCP to `127.0.0.1:<port>`, the port it read with `docker port <c> 8888/tcp`. Home never names a host or a port, so nothing else on the machine is reachable.

### 4.7 Liveness
- Each side sends PING every 10 s (`TUNNEL_PING_MS`). The relay cuts idle connections at 30 s, and y-websocket's 30 s lesson applies.
- After 25 s without any frame (`TUNNEL_DEAD_MS`) a side terminates the socket, with no close handshake on a dead link.
- Every frame home receives counts as `noteCall(runnerId)`, so path evidence sees tunnels as well as syncs.
- A tunnel down while syncs keep arriving means *alive but unreachable*. Home replies `tunnel: 'reconnect'` and fails over only after 120 s (§11.1).

### 4.8 Resumable streams (K3b, built only if K0 asks for it)
- **The rule.** Build K3b if K0 sees tunnel resets more often than once per class-hour on the EU path, or output lost in its 10 s and 60 s cuts. Otherwise §5.5 alone settles what a reset eats.
- **Retention.** Senders keep unACKed bytes for 120 s (`TUNNEL_RESUME_MS`), at most 4 MiB per stream (`TUNNEL_RETAIN_BYTES`).
- **Resume.** After a reconnect, HELLO carries `resume: [{stream, rx}]` and WELCOME answers `{resumed, streams: [{stream, rx}]}`. Each side resends from the peer's `rx`.
- **The inner sockets** (`JupyterKernel`'s at home, the agent's to Jupyter) stay open through the cut. The kernel just looks quiet for its length.
- **When resume is impossible** (a new agent or home life, a retention overflow, more than 120 s), the stream resets and §5.5 settles what it ate.
- **The test.** A seeded property test (random cuts, black holes, reconnects and agent restarts) requires every stream to deliver exactly the bytes sent, once and in order, or to reset.

### 4.9 Relay numbers and rates (D18)
- **Bandwidth and latency.** About 9.5 MB/s on one stream through relay2 (0.23 rehearsal, note 49). RTT home↔machine is RTT(relay2↔vsos) + RTT(relay2↔machine): about 53 ms for an EU machine and 133 ms for a US one (estimates; K0 measures).
- **What crosses twice.** Room output goes machine → relay2 → home → relay2 → browsers. A class averages about 25 KB/s, and a burst of 30 attempts with plots is at most 60 MB.
- **TLS** ends on relay2 for the tunnel exactly as it does for students' browsers (D27).

Everything shares the one TCP leg relay2↔vsos, so bulk is paced below its capacity:

| Flow | Direction | While any class is live on a machine | Otherwise |
|---|---|---|---|
| Class blobs (pushes, epochs) | home → machine | 4 MiB/s (`classBulkMBps`). A push a Run waits on is promoted to 8 MiB/s | 8 MiB/s |
| Class uploads (kernel writes, epochs, artifacts) | machine → home | 4 MiB/s: the agent paces at the rate the reply names, and home reads through the same bucket | 8 MiB/s |
| Competition blobs | home → machine | 2 MiB/s («Раздача посылок во время занятий») | «Скорость раздачи» (8) |
| Tunnel: interactive and council | both | unthrottled at home; at most 6 MiB/s with a 2 MiB burst from each machine | same |

The 4 MiB/s and the barrier's 8 MiB/s are first numbers: R1 checks the collaboration rule during a 150 MB sync, and K0 may lower them.

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
- **Refused in words.** `restartSession` (index.ts:1728) and the interrupt path refuse for an unreachable placement, and say so to the person who pressed.
- **A restart whose answer is lost** (a reset mid-request) becomes `RestartUnknown`. Today a non-OK answer turns the kernel `dead` (jupyter.ts:845-848), and a thrown request ends in `restartSession`'s catch, which marks the room `dead` (index.ts:1763-1770). For machine endpoints the phase stays `restarting` (expected) instead, and the room reads «Перезапуск отправлен, ответа нет…».
- **Settled by looking.** When the link returns, one silent execute evaluates the guard's report expression:
  - an error (the guard module is not loaded) means a fresh process: the restart happened (`resetAllCells`, «Ядро перезапущено»);
  - a report means the old process lives: the status goes back, and the room reads «Перезапуск не дошёл…».

  A failover settles the question otherwise.

### 5.5 `reconcileAfterReset()`
After any reconnect that followed a reset (not a resume):
1. The kernel sends one `kernel_info_request` on the shell channel and waits for its reply. jupyter_server answers it after replaying what it buffered for the session; the Linux parity job pins this ordering on the real server (§17.3).
2. Then one `GET /api/kernels/:id`. If `execution_state` is `idle` while executes are still pending, they are settled as lost: «Связь с машиной прервалась — результат ячейки потерян…». The cell ends `error`, and the queue moves on.

About 30 LOC. It closes the "cell running forever" hole that a lost `execute_reply` would open, because the watchdog only detects 404 (jupyter.ts:779-793). It helps the broker path too.

### 5.6 Help budgets
- `inspectIn`, `briefIn` (`BRIEF_WAIT_MS` 400, index.ts:5138), `completeIn` and `moduleFacts` add `min(1000, 2 × rtt p95)` for machine placements, so jedi help does not time out on distance alone.
- `liveKernel` (index.ts:4926) returns null while the placement is unreachable, and hovers say «машина не отвечает».

### 5.7 Terminal
- The re-resolve at terminal.ts:1472 runs for `kernelBackend() === 'broker' || term.endpoint.link`. A new identity gives the existing «ядро класса заменено».
- For machine rooms, quiet detection adds `min(600 ms, 2 × jitter p95)`, so a jittery link does not end a command early.

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
- **Who sets it.** Staff, in the class's «Ресурсы», among machines the owner opened to classes, while the owner's instance switch «Учителя отправляют занятия на машины» is on (D4, on by default).
- **Defaults.** Everything at home, so nothing changes for anyone who does nothing. The owner may pick another default for new classes; vsos uses D31's preset.
- **Presets:** «Всё здесь», «Консилиум и личные тетради — на машинах», «Всё на машинах», «Всё на машине с картой».
- **Fallback and failover.**
  - `fallback` («если машин нет — здесь», on): with no eligible machine, the slot starts at home through the existing Docker path and its admission (`reserveKernelMemory`, `gpuRefusal`), with a note.
  - `failover` / `failoverSec` (D13): «если машина пропала: перенести через 60 с / ждать машину».
- **Council-cell settings.** Two new `CouncilSettings` fields (notebook.ts:575) are rows in the console's «Регламент» sheet, which is the council's one place for settings:
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
2. the machine that hosted the class last, if its `stopped` row is at most 7 days old: a warm folder copy;
3. the lower RTT p95. Over 150 ms the class form says «далеко: +N мс на ячейку»;
4. the most free memory, then the name.

The council slot prefers the machine of the notebook's main kernel. A second machine is used only for a slot that fits nowhere else (D5).

### 6.4 One capacity ledger per machine
- Placements join the agent's `holding()` with their memory and CPUs. `freeCapacity` then reports one truth for submissions and classes, with no new arithmetic.
- Classes go first by ordering, never by preemption (D24): `takeForRunner` runs after the same reply's intents have taken their share. A running submission is never killed for a class, and «Места» limits submissions further.

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

### 6.8 Asynchronous ensure, over the sync
`MachineKernels.ensure(sessionId, environment, revision, cpus, memoryMb, role)` has `RuntimeClient.ensure`'s signature (runtime-client.ts:174):
1. Upsert the row: `gen + 1` if it is new, on another machine, or after `lost`.
2. `wakeRunner`.
3. Await `placementReady(key, gen)` within `CLASS_START_MS` = 180 s. Pulls are prefetched, so this is container start plus readiness, typically 5–15 s.
4. Check the echo with `checkRuntimeEndpoint` (environment, revision digest, gen).
5. Open the listener and return the endpoint.

While it waits, the slow-start notice (`SLOW_START_NOTICE_MS` 8 s) speaks with the machine's words: «Запускаем ядро на машине «vast-3»… образ ↓ 45 %». A start failure throws `RuntimeRequestError(words, 503, failure)` with a `RuntimeStartFailure`, and the existing advice takes it from there (index.ts:1633).

**Warm start.** The first participant opening the room ensures its machine slots, the folder copy, the `cells` session and the guard, so the first Run costs one round trip. The idle sweep stops them after `roomIdleMin` (D25).

### 6.9 Tokens, ids, fencing
- **The token.** `placementToken = HMAC-SHA256(SESSION_SECRET, "placement:<id>:<role>:<runner>:<gen>")`, cut to 40 characters, alongside `roomToken` (pool.ts:123). It is deterministic, so a home restart re-derives it with nothing stored. It changes with the gen and the machine. `SESSION_SECRET` never leaves home.
- **Fencing.** Every intent, report, OPEN, PUT and reading carries the gen.
  - The agent labels containers `colloq.placement=<id>:<role>:<gen>` and refuses an OPEN for a stale gen.
  - Home answers anything from an older gen with 409 `stale`.

### 6.10 Slot operations: early branches, not a refactor
pool.ts gains `if (machinePlaced(sessionId, role)) return machineKernels.X(…)` at the top of:
- `endpointForSession` (2120), `dropRoomKernel` (2301), `dropOwnKernel` (2341);
- `applyMemoryLimit` (1489), `applyOwnLimits` (1538), `applyCpuLimit` (1686), `reapplyInstanceDefaults` (1794);
- `listRoomKernels` (586), `runningKernelLimits` (1750), where machine rows hold 0 MB;
- `forgetSessionKernel` (2380).

Stops and resizes become durable intents:
- **Stop** sets the row `stopping`, and the reply omits the slot. The agent removes the container and reports it gone. An owner stop awaits that report, as `removeSlot` must confirm today (pool.ts:2271).
- **Resize** updates the row. The agent runs `docker update --memory --memory-swap --cpus` and answers `applied` or `absent`.

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

### 7.3 Adoption: kernels outlive the agent
- **At start.** The agent lists `docker ps -a --filter label=colloq.kind=class-kernel --filter label=<INSTANCE_LABEL>`, matches the containers to its records, reads their ports, and reports them in the first sync. Home keeps current gens and omits stale ones, which the agent then removes.
- **Sweeps never touch them.** The 0.23 `sweep` (sync.ts:512) filters by the run and check labels, so it never touches class containers; a test pins this.
- **Stopping.** SIGTERM leaves class containers running. The final draining sync carries `kernels.bye`:
  - `restart` when `colloq-host runner update` left `<state>/restart.marker`; home then holds the placements for 120 s (D23);
  - `stopping` otherwise;
  - `leaving` on leave.
- **Ends.** The 401 path (`unauthorized`, sync.ts:978) and leave remove class containers and their folders.
- **Versions.** A build mismatch («устарел») blocks only new placements. Adopted containers keep their argv until they next start.

### 7.4 Census and post-mortem
- **Census.** Every 10 s while placements live: one batched `docker stats --no-stream` plus `inspect`, the pair `containerCensus` uses. Per placement it reports usage, limit, CPUs, CPU %, start time, OOM kills and card memory.
- **Post-mortem.** When `onPhase` sees an unexpected restart or death of a machine kernel, `pm.explain` asks through `kernels.postmortem: [key]`. The agent returns a reading: `inspect` (OOMKilled), `exec CGROUP_SCRIPT` and `logs --tail 40`. Home explains it with `killedByMemory` and `describe`.

### 7.5 Networking and co-location
- **Host networking** (D19). The agent runs with `--network host`: `colloq-host run_runner` and the panel's plain join command (`runnerJoinCommands`, byte-equal to `colloq-host runner_code`) both gain the flag.
  - The agent reads its own `HostConfig.NetworkMode` through `COLLOQ_RUNNER_CONTAINER` into `facts.classes.hostNetwork`. Without it the machine is not eligible: «нужен --network host — перезапустите машину командой из панели».
  - That is how it reaches rooms on `127.0.0.1:<port>`: home's host form (pool.ts:1224), with the same perimeter. The IN chain refuses the rooms subnet to the host.
  - It grants nothing new: the agent already holds the Docker socket, opens no listening port, and keeps its control door on a Unix socket.
- **Co-location is refused** (D20). The agent sets `facts.classes.sameDaemon` when a home's containers are on its daemon, and `colloq-host runner up` refuses classes there. The distinct label is defence in depth.

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
- **Orphan rule.** A class container whose home has been silent (no sync reply, no tunnel frame) for `roomIdleMin`, and whose kernels are idle in the census, is stopped by the agent itself. This also covers a home rolled back to 0.24, which ignores the new tables.

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

### 8.3 Machine → home: scans, reports, pulls
New module `server/src/runner-agent/room-files.ts`.
- **When the agent scans.** On home's `scan` request, sent after every cell or attempt. And by itself: every 5 s while a stream of the class carried bytes in the last 60 s, else every 30 s. This closes today's gaps: nothing during a long cell, nothing after a terminal command.
- **How it scans.** A `TreeStamp`-style walk (workspace.ts:323-343). Changed files are hashed through `HashBook` only after 2 s without change (`CLASS_FILE_QUIET_MS`), so a checkpoint is not caught half-written. A scan home asks for after a cell skips the quiet rule, because the writer is done.
- **The report.** `changed {path, sha256, bytes, base, inline?}`, `removed {path, base}`, `skipped {path, bytes, why}`. Inline means up to 64 KiB each and 128 KiB per request.
- **Pulls.** For larger files, home answers `pulls`. The agent first copies the file to its own staging (so the bytes match the reported sha), then sends `PUT /api/runners/v1/rooms/:session/files?path&gen`: gzipped, paced, with `X-Colloq-Sha256` and `X-Colloq-Bytes`. Classes get 2 upload slots of their own (`REMOTE_CLASS_UPLOADS`), so they never starve submissions.
- **Home's apply.** Home validates (§8.6), writes through `workspaceFs` (temp file, then rename) and fires the unchanged `onWorkspaceChanged` hooks, debounced per class at 400 ms. Open editors follow through `watchDisk`.
- **The verdict.** Home answers per path, `{accepted, refused}`. An accepted path moves into the baseline. A refused one is overwritten by home's next push.

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
| A report from an older gen | 409 `stale` |

The base comes from the persisted baseline. After a home restart, home rebuilds its acked manifest from the agent's `full` report, so writes made while home was down are pulled. After an agent restart, the baseline file says what home last agreed.

### 8.5 Caps, filters, package trees, «Привезти» (D17)
- **Synced paths.** Only what `normalizePath` (shared/paths.ts) accepts: depth ≤ 8, segments ≤ 120 characters, path ≤ 400. Never hidden names, `__pycache__`, `TEMP_FILE` names, symlinks or special files. A file with several hard links travels as content.
- **The caps, new for kernel writes.** Kernel writes coming home were never capped before (routes/files.ts:283-290).
  - Per file: «Файл с машины — до» (`machineFileMb`), 200 MB, a live setting.
  - Per class: the room limit (`sessionLimitBytes`, 1024 MB).
  - Per walk: 5000 entries.
  - A file over a cap stays «на машине». The kernel log says once: «model.pt (2,1 ГБ) больше предела 200 МБ и остаётся на машине. Если машина пропадёт, файл пропадёт тоже».
- **Package trees.** When a `*.dist-info/RECORD` (or an `.egg-info/installed-files.txt`) appears, the agent marks every path it lists machine-only (`why: 'package'`). The tree shows one collapsed row, «пакеты (pip -t) — на машине, 2,1 ГБ». `pip install -t . torch` never touches the relay.
- **«Привезти».** Staff press it on a «на машине» row, and home pulls that one path. A file over the per-file cap is allowed this way, still within the room limit.

### 8.6 What a machine reports is participant data
- **Home re-checks** every path and type and never creates links. It writes through `createAnchoredFilesystem`.
- **Bytes.** Sha256 and byte counts are checked after decompression. Staging uses `TEMP_FILE` names, which `sweepAllStaleUploads` cleans after a crash.
- **Scope.** A machine's credential reaches only the classes placed on it, at their current gen. Each machine is limited to 10 reports a second and 1000 paths per report.
- **The agent** walks with the anchored filesystem too (already in its bundle), never follows links, and copies before it hashes: a kernel can plant `ln -s /var/lib/colloq-runner/runner.json x.csv`.

### 8.7 Pull barriers and lag
- `filesSettled(sessionId, timeoutMs)` asks every machine of the class for a scan and waits for the reports to apply. It runs:
  - before the class-end refresh (publish/class-end.ts:159-170, within its 2 min);
  - before a class page build (publish/materials.ts);
  - before the oracle's `movedFiles` (ai/agent.ts:1586);
  - before failover's final note;
  - before a download of a pending file, and before a move or copy of a path with pending changes.
- A new file a kernel just wrote is listed only once it has reached home. An existing file the kernel rewrote serves its previous version until its pull lands, seconds at most.
- «Работают сейчас» shows each placement's lag: «файлы: синхронно», «↑ 3 файла, 12 МБ» or «2 файла только на машине».

### 8.8 Failover and files
- **Lost.** Only the unsynced tail: at most one scan interval of writes, plus «на машине» files, which the failover note names.
- **Late reports** from the old gen get 409.
- **A returning machine** diffs its copy against its baseline and reports at most 50 changed paths (`late_changes`). Home names them in the room, refuses them, and the agent deletes the copy.

## 9. The council on machines (0.26.0)

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

### 11.2 Sequence
1. One transaction marks the row `lost` with its cause. From that moment the listener is closed and the upload doors answer 409.
2. For each runtime of the slot, `endFromOutside('lost', words)` (§5.2) ends the kernel. The room reads:
   > «Машина «vast-3» не отвечает с 14:32:05. Ядро поднято заново на этом сервере: переменные пропали, файлы — по 14:31:58. Запустите ячейки снова.»
3. The queue is dropped with «Очередь сброшена: ячейки рассчитывали на переменные, которых больше нет» (D14). The running cell gets «Эта ячейка выполнялась на машине «vast-3», когда та пропала. Неизвестно, успела ли она закончиться; на новом ядре её нет».
4. The next `ensureKernel` detaches the dead kernel. `endpointForSession` places again with `gen + 1`: on another eligible machine, else at home through the Docker path and its admission (`fallback`), else a refusal with words.
5. The terminal sees a new identity («ядро класса заменено»), and its pty is new.
6. A lost council slot re-places its pool or falls back to shared (§9.10).

### 11.3 A returning machine
Its first sync lists the old gen, and home's reply omits it. The agent reports the paths it changed after the fence (§8.8), then removes the container and the folder copy. Its late PUTs and readings get 409.

### 11.4 Restarts and updates
- **Home restart.** Placements are in SQLite, and agents keep their containers. The boot grace blocks failover while tunnels reconnect. `ensureKernel` re-attaches by session path, so the variables survive. File state is rebuilt from the agents' `full` reports.
- **Agent `kill -9`.** The containers are adopted, and the tunnel is back within seconds. Streams reset unless K3b resumes them; §5.5 settles at most the running cell.
- **`runner update`** (D23). `bye{restart}` holds failover for 120 s while the update pulls first, drains, then restarts the agent (colloq-host:1535-1600).

### 11.5 Owner actions
- `revokeRunner` and `untrustRunner` (release.ts:445/498) gain a sibling, `unclassRunner`.
  - Revoke and unclass fail every placement of the machine over **first**.
  - Then they cut its `room` and `epoch` blob streams (`cutBlobStreams`) and answer `placements: []` (unclass) or 401 (revoke).
  - The agent's 401 path removes class containers, folder copies, epochs, scratch folders and artifacts.
- `colloq-host runner leave` on a machine with classes asks first: «на машине 2 занятия: уход перенесёт их на сервер, переменные пропадут (--force)».

### 11.6 Class quarantine (D32)
Two silence failovers on one machine within 30 min set `classes_quarantined_at`. The machine takes no new placements, and the owner sees a banner with «Вернуть», which sets `classes_resumed_at`. Submissions are unaffected. The counter is separate from the 0.23 submission quarantine and counts events, not placements.

### 11.7 Failure table

| Failure | Detected by | Kernel | Queue | Files | Council | Words |
|---|---|---|---|---|---|---|
| Relay blip under 25 s | the tunnel closes or pings stop | untouched | waits at the gate | waits | workers untouched | chip amber; a note only after 10 s |
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
- The perimeter is home's, with home's mode as the floor (D21). Rootless Docker and nftables-only daemons (the helper exits 20 or 21) and `open` machines are refused, with words. It is re-checked every 60 s and fails closed.
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
5. **Z5 · Комната · ядро на машине** (1240).
   - The chip: staff see «Ядро · vast-3 · 52 мс», students «Ядро на машине»; then amber «Нет связи с машиной · 0:23», «Переносим на сервер…», «На сервере · переехало в 14:33».
   - The kernel-log notes of §13.2.
   - A waiting cell's «ждёт машину», and a cell's «файлы едут на машину: 12 из 150 МБ».
   - The staff banner with «Перенести сейчас» and «Ждать машину»; the restart refusal.
6. **Z6 · Файлы · что на машине** (1240, and on the phone).
   - «С машины едут 2 файла · 40 %».
   - «model.pt · на машине · 2,1 ГБ · Привезти».
   - A collapsed «пакеты (pip -t) — на машине, 2,1 ГБ».
   - A conflict copy, «data (с машины 14-32).csv», with its note.
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

### 13.2 Words
This table is the locale source. ru and en go into shared/locales: `server.ts` for notes the server writes, `room.ts` for the room and the console, `admin.ts` for the panel. Kernel notes follow the «Ядро …» style.

| Event | Text (ru) | Who |
|---|---|---|
| Unreachable for 10 s | «Нет связи с машиной «vast-3» · 0:12. Ядро и переменные на ней целы — ждём связь. Новые запуски подождут.» | room note, chip |
| Waiting (staff) | «Машина «vast-3» не отвечает с 14:32:05. Ждём до 14:33:05, потом поднимем ядро на этом сервере (переменные пропадут).» + «Перенести сейчас» / «Ждать машину» | staff |
| Back | «Связь с машиной «vast-3» вернулась через 37 с.» | room, only if the first note went out |
| A reply lost in a reset | «Связь с машиной прервалась — результат ячейки потерян. Ядро и переменные целы; запустите ячейку снова.» | the cell |
| Failover | «Машина «vast-3» не отвечает с 14:32:05. Ядро поднято заново на этом сервере: переменные пропали, файлы — по 14:31:58. Запустите ячейки снова.» | room, console, owner log |
| Running cell at failover | «Эта ячейка выполнялась на машине «vast-3», когда та пропала. Неизвестно, успела ли она закончиться; на новом ядре её нет.» | the cell |
| Queue dropped | «Очередь сброшена: ячейки рассчитывали на переменные, которых больше нет.» | room |
| Restart refused | «Нет связи с машиной «vast-3» — перезапуск сейчас не дойдёт. Нажмите, когда связь вернётся.» | the person who pressed |
| Restart, answer lost | «Перезапуск отправлен, но ответа нет: связь с машиной прервалась. Узнаем, когда она вернётся.» → «Перезапуск прошёл: переменные сброшены.» or «Перезапуск не дошёл — переменные на месте.» | room |
| Interrupt refused | «Нет связи с машиной — остановить ячейку сейчас нельзя. Предел времени сработает, когда связь вернётся.» | the person who pressed |
| Revoke / unclass / leave | «Владелец отключил машину «vast-3».» / «Машине «vast-3» больше не доверено вести занятия.» / «Машину «vast-3» отключают.» + «Ядро поднято на этом сервере, переменные пропали.» | room, owner |
| Perimeter fails closed | «Сеть на машине «vast-3» вышла из-под контроля: ядро остановлено ради безопасности и поднято на этом сервере.» | room, owner banner |
| No room at failover | «На сервере нет места для ядра этого занятия: занято 14 из 15 ГБ. Освободите память или подключите машину.» | room, teacher |
| Late writes | «Машина «vast-3» вернулась после переезда; её изменения в файлах после 14:32 не приняты: out.csv, model.pt.» | room, owner |
| Conflict | «data.csv изменили одновременно здесь и на машине. Оставлена версия сервера, версия с машины — «data (с машины 14-32).csv».» | files panel, staff |
| Delete wins | «old.csv удалён на сервере; изменения, сделанные в нём на машине, отброшены.» | files panel |
| Over a cap | «model.pt (2,1 ГБ) больше предела 200 МБ и остаётся на машине. Если машина пропадёт, файл пропадёт тоже.» · «Привезти» | files panel, kernel log once |
| Barrier | «Файлы едут на машину: 12 из 150 МБ…» / «Файлы не дошли до машины: 30 с без движения — ячейка не запущена.» | the cell |
| Slow start | «Запускаем ядро на машине «vast-3»… образ ↓ 45 %» | the cell |
| Quarantine | «Машина «vast-3» дважды пропадала за 30 минут — занятия на неё больше не отправляются. Вернуть можно в «Ресурсы → Машины».» | owner banner |
| Tunnel replaced | «Связь машины «vast-3» за 10 минут 4 раза перехватывали с разных адресов: 5.6.7.8, 9.10.11.12. Проверьте, не утёк ли её ключ.» | owner banner |
| Pool not ready | «Пул ещё поднимается — эта попытка посчитана в общем ядре.» | card |
| Left names | «Не переносится: conn (соединение с базой), batches (генератор).» | console |
| Rerouted | «Посчитано в общем ядре: использует conn — её нельзя перенести.» | card |
| Older epoch | «Состояние 14:05 — без ячеек 8–9.» | card |
| Adopt behind | «Ядро ушло вперёд на 3 ячейки после снимка — результат в тетради может отличаться.» | console |
| Lost mid-attempt | «Машина пропала посреди попытки — пересчитано в общем ядре. Пауза между запусками не засчитана.» | card |
| Hash seed | «Порядок множеств в попытках может отличаться от тетради: её ядро запущено до обновления.» | console, once |

## 14. Packaging and deploy
- **The same image and agent.** `colloq-host run_runner` (deploy/vast/colloq-host:1275) adds `--network host`. The `colloq.config` sum changes, so `runner up` or `runner update` replaces the agent container while class containers keep running. `runnerJoinCommands` and `colloq-host runner_code` (:1760) stay byte-equal, both with `--network host` and `--stop-timeout 90`.
- **Codes.** `colloq-host runner-code --classes` (ops/runner-code.ts) and the panel's «Принимать занятия» set `remote_runner_codes.classes`. A code with classes cannot also carry «доверенная» (D3). `make vast-runner CODE=…` needs nothing new, since the code carries the flag.
- **`runner up` with classes** checks first: rootful Docker with iptables, cgroup v2, no colloq instance on this daemon (refused, D20), and the disk floor (the 0.23 40/120 GB plus class folders).
- **`runner update`** writes `<state>/restart.marker` before it stops the agent, which makes the final sync say `bye: 'restart'`. It refuses before stopping anything when the new tunnel protocol differs from home's.
- **`runner leave`** asks before moving classes (§11.5). **`runner status`** gains `tunnel: up / down · RTT` and `classes: {room, own, council}`.
- **State.** `<state>/rooms/`, `<state>/placements/`, `<state>/council/` and `restart.marker` are new, all under the dedicated state dir and its system-root refusals (0.23 note 23).
- **Fleet.** `make runners-update` keeps classes alive (adoption). `make runners-down` fails classes over before destroying, through leave.
- **Docs.**
  - docs/pages/{ru,en}/runners.html gains «Занятия на машинах», which removes «They do not run room kernels» (runners.html:49).
  - council.html gains «Консилиум на машинах»; security.html the exposure list; server.html the vsos preset.
  - This file becomes docs/architecture/remote-classes.md.
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
  skipped: { path: string; bytes: number; why: 'size' | 'room' | 'count' | 'package' }[]
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

**Doors under `/api/runners/v1`:**
- `GET tunnel` (the upgrade);
- `PUT rooms/:sessionId/files?path=&gen=`: gzip, at most `machineFileMb`, or the room limit for «Привезти»;
- `PUT epochs/:sha256?session=&gen=`: raw, accepted only for an epoch home asked that placement for;
- `PUT council/:sessionId/runs/:runId/files/:name?gen=`: artifacts, 1 MiB each at most;
- `GET blobs/:sha256`, with the new sources `room` and `epoch`.

**Staff doors:**
- `PATCH /api/admin/runners/:id {classes}`, `POST /api/admin/runners/:id/classes/resume`, `POST /api/admin/runners/codes {classes}` (owner);
- the seminar PATCH gains `{placement}` (the class's staff);
- control-socket messages: `kernel:move {root?}` and `files:fetch {path}` (staff), `council:epoch {cellId}` (host). The two new `CouncilSettings` fields ride the existing settings frame.

**Constants** (in `shared/remote-tunnel.ts` and `shared/remote-kernels.ts` unless named):

| Area | Constants |
|---|---|
| Tunnel | `TUNNEL_PING_MS` 10 s · `TUNNEL_DEAD_MS` 25 s · `TUNNEL_FRAME_MAX` 16 KiB · `TUNNEL_WINDOW` 1 MiB interactive / 512 KiB council, 16 MiB per machine · `TUNNEL_SEND_LOWAT` 64 KiB · ACK every 50 ms or 64 KiB · `TUNNEL_STREAMS_MAX` 512 · 12 upgrades/min · `TUNNEL_RESUME_MS` 120 s and `TUNNEL_RETAIN_BYTES` 4 MiB (K3b) |
| Rates | `classBulkMBps` 4 (promoted pushes 8) · `machinePaceMBps` 6 with a 2 MiB burst · competition blobs during classes 2 |
| Liveness | `CLASS_UNREACHABLE_NOTE_MS` 10 s · `CLASS_SILENCE_MS` 60 s (class 30–300 s) · `CLASS_TUNNEL_STUCK_MS` 120 s · `CLASS_EVIDENCE_MS` 15 s · `CLASS_PROBE_MS` 5 s · `CLASS_BYE_GRACE_MS` 120 s · `CLASS_MOVE_NOW_MS` 10 s · quarantine 2 per 30 min · `PERIMETER_RECHECK_MS` 60 s, 3 failures |
| Start and files | `CLASS_START_MS` 180 s · `CLASS_BARRIER_MS` 120 s, 30 s without progress · `CLASS_SCAN_BUSY_MS` 5 s · `CLASS_SCAN_IDLE_MS` 30 s · `CLASS_FILE_QUIET_MS` 2 s · `CLASS_INLINE_BYTES` 64 KiB · `CLASS_SYNC_FILES_MAX` 5000 · `REMOTE_CLASS_UPLOADS` 2 · `machineFileMb` 200 (setting) |
| Help | pad min(1000 ms, 2 × RTT p95) |
| Council | `attemptMb` 1024 · workers 2..16 auto, 32 by hand · `COUNCIL_WORKER_REUSE` 20 · `COUNCIL_EPOCH_MB` 2048 · `COUNCIL_EPOCH_SHIP_MB` 256 · `COUNCIL_EPOCH_WAIT_MS` 5 s · `COUNCIL_POOL_READY_MS` 60 s · `COUNCIL_POOL_LINGER_MS` 15 min · artifacts 20 files, 1 MiB each, 5 MiB total · home epoch store 4 GB |

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

**Not in the waves.** After K9a, optionally: the census *vouches* for a kernel, saving `confirmAlive`'s round trip on the first cell after a pause (jupyter.ts:499). Pipelining Run All stays a measured follow-up.

**Total.** About 9.6k LOC (9.2k without K3b) plus about 6k LOC of tests. The release split is D29: 0.25.0 is K0–K6, K8, K9a, K10, K11a, K12 and K13; 0.26.0 is K7a–c, K9b, K11b and K12b. If one release is required, K7 ships with `council: 'shared'` as the default.

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
| kernel/jupyter.ts | kernel-link, kernel-channel-reconnect | No attempts counted while the link is down; `'lost'` → `dead` with `endedBy` and no `DELETE`; the identity override keeps the pty across a port change; `waitForSocket` extended; `reconcileAfterReset` settles a dropped reply only after the replay; `RestartUnknown` settled both ways by the guard question |
| kernel/terminal.ts | terminal-endpoint | Re-resolve for machine endpoints; the link wait; the quiet pad |
| kernel/remote/placement.ts | class-placement | Every eligibility filter; stickiness and the last-host preference; RTT and «далеко»; the whole GPU card; stale-capacity accounting; the gen fence on every input; a token per gen; the state machine with an explicit clock (evidence 15 s, probe 5 s, boot grace, tunnel-only 120 s, `bye` 120 s, `failoverSec`, «ждать машину», «Перенести сейчас»); class quarantine |
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

**A. Placement and cells.**
1. Warm start on join; Run → output in Yjs; completion, inspect and brief through the tunnel; interrupt, restart, `input()`, `file:run`, the terminal.
2. Two class notebooks in one room container; ten personal kernels on a machine with the room at home.
3. A home build differing from the agent's: classes keep running, a new placement goes home with the words, «устарел».

**B. Tunnel faults.**

4. A 20 s black hole mid-`STREAM`: no failover, no reconnect attempt counted, the chip amber after 10 s, the "back" note, all output delivered.
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

### 17.5 Vast rehearsal, with numbers
**Rig.**
- **H**: a lab home behind relay2 under a test name, 8 vCPU / 16 GB, standing in for vsos. Never vsos itself. The Mac's path to relay2 never runs through AmneziaVPN: exclude the relay from the VPN, or drive from a VM.
- **C**: a CPU machine, 32 vCPU / 64 GB. **G**: 1×4090, driver 580+. **U** (optional): a US VM, for the RTT comparison.
- **Load**: `scripts/class-load.mts` with 30 synthetic students (control and collab clients: cells, uploads, attempts), plus two headless Chrome tabs for RTT.
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
6. **The replay-ordering assumption** behind §5.5 (jupyter_server answers `kernel_info` after its replay). Pinned by the parity job on the real server; if it fails there, the fallback is 1 s of iopub silence after the reconnect.
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
