# Audit remediation — 2026-11-11

Baseline: `1fa02c72472364cb2448a95c8ea5ceedd27082d4`. Scope: F01–F10, O01–O03 and production dependency advisories in [the audit](2026-11-11-bugs-and-performance.md). Work performed in an isolated worktree with temporary test state.

All audit findings and the additional scientific compatibility issue are fixed, independently reviewed and verified. Integrated into `main` as `43c52c5`; the local instance is updated and serving the verified artifacts.

## Fix coverage

| Finding | Change | Regression evidence |
|---|---|---|
| F01 | Complete room admission despite history storage errors; repair with a full keyframe after recovery | Readonly/full-storage failures for initial history and repair; broadcasts, title and replay checked |
| F02 | Use the same effective IOI grouping for execution and scoring | Real Python harness: `OK, WA, OK`, 50 points; grouped scoring unchanged |
| F03 | Revalidate mutable intake settings after probes; reject missing/foreign problems transactionally; settle legacy orphan rows | Held-probe deletion/language/environment races and healthy queue progress |
| F04 | Canonical handoff fields and signature-based single-use identity | Canonical/noncanonical input before and after consumption |
| F05 | Include errors and diagnostics in existing aggregate output budgets | Repeated errors/oversized figures, escaped tracebacks and final errors |
| F06 | Charge full inline cost when blob storage fails | Temporary failed-storage fixture stays within the original ceiling |
| F07 | Fence canceled starts and await cleanup before owner stop succeeds | Delayed create/readiness/admission, overlapping stops and failed removal |
| F08 | Bind reference checks and language probes to immutable image identity | Environment change, same-tag rebuild and mutation across async readiness |
| F09 | Detect exited/OOM startup after failed readiness probe; bounded sanitized details | Mock process state and large token-bearing logs, no real Docker |
| F10 | Guard stale history detail/list replies across selection, refresh, view switch and destruction | Real browser held-response races, including Activity/Versions switching |
| O01 | Scalar submission-version projection; no report/source reads | Identical wire version; 8.64 MB → 0 report bytes; median 7.680 → 0.074 ms |
| O02 | Reject discarded figures before decoding | 100 discarded frames: 100 → 0 base64 decodes; deferred clear still admits replacement |
| O03 | Load optional capabilities/dictionaries and Plotly trace modules on demand; preserve map styles, full editor and all trace types | Actual fetched room JS/CSS: RU 399.210 / EN 396.931 KiB; Plotly with CSS 420.009 KiB; unchanged budgets |

The competition streams also terminate when the entrant credential is revoked. The runtime targeted suite passed 376 tests with 12 platform/dependency skips; the contest targeted suite passed 150 with one Linux-only skip. Final integrated counts below supersede these scoped counts.

## Authentication and dependencies

F04: handoff validation now requires canonical base64url and base36 fields and valid UTF-8. Single-use accounting keys the verified signature and room rather than caller-supplied serialized text. Expiry, revocation and public protocol remain unchanged. The added regression failed before the fix and passed afterward; the initial authorization/handoff/socket suite passed 23/23.

Production dependencies were updated within compatible lines, with narrow overrides for `qs >=6.16.1` and Satori's `fflate >=0.7.5`. `npm audit --omit=dev` reports zero vulnerabilities. Vite 6.4.6, the compatible Svelte plugin 5.1.1 and esbuild 0.28.2 also remove supported build-tool advisories. Actual resolved versions and final audit evidence are recorded during final verification.

One upstream low-severity advisory remains in the development-only `deepmerge` used by the Svelte Vite plugin to merge trusted build configuration. It appears as three affected dependency-chain entries in full `npm audit`. The upstream advisory lists no patched release: [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4). It is not a production dependency or shipped application module. No downgrade or audit suppression was used to hide it.

## Data compatibility

No database migration or schema override is required. Old reference reports remain readable but need a fresh reference run to establish immutable environment identity. Existing IOI submissions whose reports contain incorrectly skipped tests require rejudging; recalculating scores alone cannot recreate missing executions. No historical scores or live contest rows have been modified by this remediation.

## Independent review

The competition/authentication/dependency reviewer found no material issues; independently ran 39 isolated tests successfully. The runtime reviewer found two additional defects, both corrected and re-reviewed:

- A hidden keyframe after the first recovered edit did not repair replay at that visible edit. The recovered edit now carries a full state update. All four failure-mode tests were observed failing before this correction, then the history suite passed 34/34.
- Native-host startup could fail at missing published port before reaching process diagnostics. That path now checks for exit/OOM too, with cancellation fences. A host-mode regression reproduced the generic error before correction.

The reviewer reran the three new runtime test files after both corrections: 24/24 passed, no skips or outstanding important findings.

The integrated class-load test then caught truncation notices removing the beginning of an overflowing stdout stream. Product notices now reclaim the newest text suffix, preserving the first lines, while exception reclamation keeps its existing behavior. Room and council regressions both failed before the correction. The related output suite passed 63/63; an independent re-review and 12/12 regression rerun passed. The full machine-class scenario then passed its isolated rerun (47.54 seconds).

Frontend review found and corrected stale history view transitions, positional Plotly type switches, old classic-bundle cache migration, development CORS, and locale-triggered lazy component remounts. The room reviewer verified identical actual/report resource graphs and locale-preserved component identity; 33/33 browser scenarios passed. A final artifact review also restored MapLibre CSS on its actual module import edge and retained the upstream Plotly MIT notice. That follow-up passed all six Plotly browser scenarios, including opaque-frame computed map styling.

Standard Chromium additionally demonstrated that a failed ESM module can remain cached even when a retry is pressed. Repeated failure now promotes explicit reload with an explanation. Two end-to-end recovery cases verify the same participant, exact notebook text including fresh edits made during failure, and a working History panel after reload. The final standard browser suite passed 35/35. These results were independently reviewed.

## Additional scientific compatibility fix

Enabling the previously skipped numerical tests exposed a pandas 3.1 export issue: its protocol-5 block reducer eagerly copied strided train/test slices before the array ownership logic could run. Ordinary numeric blocks now use the no-copy block recipe while array transport stays protocol 5. Original pandas reference-group identities are rebuilt too, preserving Copy-on-Write rather than only sharing bytes. The original three-buffer requirement remains unchanged; a new 2 MiB case verifies admission, mapped ownership and parent/slice mutation behavior. Independent equal-content reference groups remain separate.

Full council epoch/isolation checks passed with both pandas 3.1.1 (Python 3.14.7) and pandas 2.3.3 (Python 3.12.12): 71 tests, 68 passed and three expected Linux/CUDA skips each. Pandas 2 optional CoW enabled and disabled were both checked. The independent reviewer confirmed the corrected reconstruction semantics.

A Torch test compared float32 sums under different CPU thread counts; the bytes were unchanged while reduction order changed the sum by 7.6e-6. It now verifies the exact weight bytes with SHA-256. This tightens the assertion without altering production Torch behavior.

## Local data inspection

A read-only check of the local instance found zero programming contests and zero programming-contest submissions. There are no existing local IOI scores or reference reports to rejudge. This does not make a statement about other installations.

## Performance verification

Final connected perf run used an isolated fixture server with fake Jupyter, never the local live instance. All 18 checks passed; the script cleaned up all 21 rooms it created.

| Metric | Before audit | Final |
|---|---:|---:|
| Room RU / EN, gzip KiB | 630.93 / 623.76 | 399.210 / 396.931 |
| Largest app chunk, gzip KiB | 263.43 | 151.230 |
| Cold Plotly including styles, gzip KiB | 1532.72 | 420.009 |
| Entrant version report bytes read | 8,642,900 | 0 |
| Entrant version median, ms | 7.680 | 0.074 |
| Sync p50 / p95, ms | 0.396 / 0.698 | 0.365 / 0.550 |

All 105 expected synchronization updates arrived. API medians were 1.60–2.63 ms; worst of the fixture requests was 8.01 ms. These are local fixture measurements, not WAN or production latency promises. Room costs measure the existing JS/CSS budget for a normal editable code cell; notebook media/fonts/content are separate. Real browser typing, undo, deferred terminal and locale changes were verified. RU has approximately 0.79 KiB of remaining budget, enforced by the new regression.

## Final validation

- Optimized web/server/runtime build: passed. The built server was launched with temporary state; readiness, module CORS/cache behavior and retained Plotly license were verified.
- Typecheck: all four workspaces passed, zero errors; eight pre-existing Svelte warnings remain.
- Standard Playwright Chromium: 35/35 passed.
- Production dependency audit: zero vulnerabilities.
- Final full Node suite: **7,421 tests; 7,373 passed, 48 skipped, zero failures/cancellations**, 12m 37s. Node 22, two isolated test workers, Helm 3.19.0 and an isolated Python 3.14 environment with scientific/Jupyter packages. Remaining skips are explicit platform, GPU, Docker/cluster/integration opt-ins.
- Earlier integration failures were corrected before this clean full run: source assertions now follow real deferred capabilities; CLI fixtures include their imported helper; root tests declare their esbuild dependency rather than resolving a different parent-checkout version.
- Post-install verification on `main` after a clean `npm ci`: 79/79 targeted regressions passed; production dependency audit remained zero.

## Delivery

Code commit: `43c52c5` (`fix: resolve audit regressions and reduce initial payloads`), fast-forwarded into local `main` from the audited baseline. No manual release-version bump was made.

Before replacing the local instance, the staff resources endpoint confirmed no online participants, running classes, jobs or preparations. A consistent SQLite backup passed `quick_check`; prior modules and built artifacts were retained at `.colloq/audit-rollback-20261111T181414Z`. Only the verified application process was stopped; the Docker daemon was untouched.

A clean Node 22 dependency installation succeeded. Installed web/server/runtime files exactly matched all hashes from the tested artifacts. The new application process (PID 90492) answered readiness and full health successfully; its served entry `/assets/index-CtH1mO_-.js` matched the installed bytes (SHA-256 `a469b11839424d45ae08a2e0b247aa7f48578df3ed46784266fab2f259e3b286`). The user's untracked `kernel/environments/cv.txt` retained its original SHA-256.

The running instance currently advertises `http://127.0.0.1:3000`. An additional public check of `hse.colloq.ru` returned the relay's 404 “room not open” page; this update did not enable a public tunnel or deploy a remote host.

Verification JSON, full test/build/audit logs, per-track reports and screenshots are retained locally under `scratchpad/audit-fixes/`.
