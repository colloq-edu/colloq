# Contests («Контесты»): design

**Status:** design for 0.30.0, written 30 Oct 2026 against the repo at 0.29.0 (`0d10f09`). Mockups: Paper file «colloq», page **19 · Контесты** (K1–K6 participant, A1–A4 panel).

**The ask.** Algorithmic contests as on Yandex.Contest: a teacher gives problems with tests, students send Python or C++, a judge answers with a verdict at once, and the class watches a convenient leaderboard.

**Words.** A *contest* holds *problems* A, B, C…; a problem holds *tests* (an input and an answer each; some are *examples*, shown under the statement). A *submission* is source code for one problem in one language. The *judge* compiles it and runs it on the tests in a disposable container. A *verdict* is OK, WA, TL, ML, RE, OL, CE (or SE, the judge's own failure).

## 0. The design in one screen

| Decision | Why |
|---|---|
| A new module beside competitions, not a kind of competition | A competition is one notebook against one metric; a contest is many small programs against many tests. They share the participant and the board's manners, nothing of the pipeline (`shared/contests.ts` header) |
| The participant is the instance-level **entrant** of competitions: same key, same cookie, same `/k` list | A student with a key from a competition is already signed in to every contest, and the `/k` list shows both |
| Pages at **`/a/<slug>`**, API at `/api/k/contests/…` (the entrant cookie's path), panel at `/admin/contests` and `/api/admin/contests/…` | `/k/<slug>` is a competition; a second kind under the same address needs a lookup before every page. Separate doors, one list |
| Rules **ICPC** (solved, penalty, freeze) and **IOI** (points per test or per group) per contest | ICPC is the timed class test, IOI the homework (Yandex.Contest offers both) |
| One container per submission, **all tests inside it**; the program runs as `nobody` under a root harness; **answers never touch the container's disk** — they arrive through the harness's stdin into a root-only tmpfs | One container start per submission instead of one per test (≈0.5 s each), stop at the first failure, and no answer readable by the program |
| Results come back as **JSON lines on the harness's stdout**; progress («тест 7 из 22») streams the same way | No export step, no writable host mount, live progress for free |
| Python 3 and C/C++ from the **environment's kernel image**; `g++` is added to the base kernel | One image family to build, publish and scan; the languages a contest offers are probed from its image |
| The reference solution must pass every test before **«Открыть контест»**; it can also **write the answers** | A contest whose problems even the author cannot solve has nothing to open (the competitions' baseline rule) |
| Places are **distinct**, ties broken by time | The owner's rule for every board («места на доске разные», 30.09.2026) |
| Docker backend in v1; the k8s broker answers «недоступно» | The broker cannot start a second pod per submission today (competition-broker.md) |

## 1. Data

All in SQLite, module `server/src/contests/` owns the tables (`CREATE TABLE IF NOT EXISTS` at import, no `DATA_SCHEMA_VERSION` bump — new tables only).

```
contests            (id PK, slug UNIQUE, title, blurb, description, state, rules, penalty_minutes,
                     freeze_minutes, unfrozen_at, attempts_per_problem, languages JSON, environment,
                     starts_at, ends_at, upsolving, board_visibility, course_id, created_by,
                     hidden_at, revision, created_at, updated_at)
contest_problems    (id PK, contest_id, position, title, statement, time_limit_ms, memory_mb,
                     checker, checker_epsilon, checker_code, points, reference_language,
                     reference_source, tests_revision, created_at, updated_at)
contest_tests       (problem_id, ordinal, sample, test_group, input_bytes, answer_bytes NULL,
                     answer_from, PK(problem_id, ordinal))
contest_groups      (problem_id, test_group, points, PK(problem_id, test_group))
contest_entrants    (contest_id, entrant_id, name_key, joined_at, PK(contest_id, entrant_id),
                     UNIQUE(contest_id, name_key))
contest_submissions (id PK, contest_id, problem_id, entrant_id NULL, kind, number, language, source,
                     source_bytes, submitted_at, late, state, verdict, failed_test, passed, total,
                     score, time_ms, memory_kb, progress, compile_log, report JSON, system_detail,
                     tests_revision, judged_at, attempt, boot, started_at)
contest_questions   (id PK, contest_id, problem_id NULL, entrant_id NULL, question, answer,
                     answered_by, public, asked_at, answered_at)
contest_seen        (contest_id, entrant_id, questions_seen_at, PK(contest_id, entrant_id))
```

`entrants` are the competitions' table (`competitions/store.ts`). The identity-removal query there (`selectAnywhere`) must also look at `contest_entrants` and `contest_submissions`, or deleting a person from a competition would delete the identity their contests still use; `server/src/contests/schema.ts` creates the contest tables and is imported by `competitions/store.ts` before it prepares that query.

**On disk** — under `DATA_DIR/contests/`, through an anchored filesystem (`secure-files.ts`), every mounted path a directory that did not exist before (the colima/virtiofs rule of `competitions/storage.ts`):

```
contests/.judge/<content hash>/judge.py               the harness, mounted :ro at /judge
contests/<cid>/problems/<pid>/r<rev>/in/<n>.in        inputs of tests revision <rev>, mounted :ro at /tests
contests/<cid>/problems/<pid>/r<rev>/ans/<n>.ans      answers — read by the host, never mounted
contests/<cid>/runs/<sid>-<attempt>/                  job.json + the source, mounted :ro at /job
```

A change of tests writes a whole new `r<rev+1>` (unchanged files hard-linked) and then switches `tests_revision`; an old revision is removed once nothing queued or running uses it. Backups: `data/contests` joins the allowlists in `scripts/backup-local.sh` and `scripts/restore.sh`.

## 2. The judge

**Where.** `server/src/contests/judge/`: `port.ts` (the contract below), `harness.ts` (the Python harness as a string, materialized like `competitions/harness.ts`), `docker-judge.ts`, `fake-judge.ts` (the `test` backend: never runs code; magic comments decide), `languages.ts` (the probe), `pump.ts` (the queue).

**The container** (one per submission, `docker run -i`, attached):

```
--pull=never --name colloq-contest-<sid>-<attempt> --network none --read-only
--user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL
--security-opt no-new-privileges --pids-limit 128
--memory <M>m --memory-swap <M>m --cpus 1
--tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777
--tmpfs /work:rw,nosuid,nodev,exec,size=<W>m,mode=1777       compiled binary, scratch
--tmpfs /secret:rw,nosuid,nodev,noexec,size=<S>m,mode=700    answers, outputs, checker
-v <judgeDir>:/judge:ro -v <jobDir>:/job:ro -v <testsDir>:/tests:ro
--label colloq.kind=contest-judge --label <instance label> --log-driver=local …
--entrypoint python3 colloq-kernel:<environment> -I /judge/judge.py
```

`M` = max(memoryMb, 1024) + 256 + answers MB (the compiler needs room too; the program's own limit is enforced by its measured peak, not by the cgroup). The host kills the container at the run's wall budget: 60 s for compiling plus `2 × TL + 1 s` per test, at most 20 min.

**The harness** (Python, as root in the container):
1. reads a framed stream from stdin: a JSON header (language, limits, tests with groups and example marks, checker kind and epsilon, mode `icpc` | `ioi` | `answers`), then every answer, then the custom checker's code — all into `/secret` (0700, root);
2. compiles: Python by `compile()` in the harness itself (a syntax error is CE, nothing runs); C++ `g++ -std=gnu++20 -O2 -pipe`, C `gcc -std=gnu17 -O2 -pipe … -lm` — as `nobody`, 60 s, log capped (16 KB);
3. runs each test as `nobody` (`setgroups([])`, `setgid`/`setuid` 65534) with stdin from the input, stdout and stderr to files in `/secret` opened by root; `RLIMIT_CPU` = TL + 1 s, `RLIMIT_FSIZE` = 64 MB (OL), `RLIMIT_STACK` = the memory limit, `RLIMIT_CORE` 0, `oom_score_adj` 1000; wall clock `2 × TL + 1 s`; time = the child's user + system from `wait4`, memory = its `ru_maxrss`; after every test every process of uid 65534 is killed (a double-forked helper cannot outlive its test);
4. verdicts: wall or CPU over the limit → TL; peak memory over the limit or killed without a reason → ML; SIGXFSZ → OL; a non-zero exit or another signal → RE; otherwise the checker: `tokens`, `lines`, `float` (in the harness) or `custom` (the teacher's `check(input, output, answer)` in a subprocess, 10 s);
5. ICPC stops at the first failure; IOI runs everything but skips the rest of a group after a failure; `answers` runs everything and streams the outputs back (base64 chunks) instead of checking;
6. writes JSON lines to stdout: `{"t":"compiled",…}`, `{"t":"test","n":7,…}`, `{"t":"done",…}`.

**Why it is safe enough.** The program runs as `nobody`, which can read neither `/secret` (0700 root) nor the harness's memory or file descriptors (another uid, no capabilities), and cannot signal the harness. Inputs of other tests are readable (`/tests`), and that leaks nothing the program does not already get on stdin. No network, a read-only root, bounded tmpfs, pids 128, one CPU. The teacher's custom checker runs as root inside the same container — the teacher is trusted, the container is not the host.

**The contract** (`port.ts`):

```ts
interface JudgeRequest {
  submissionId: string; container: string; image: string
  language: ContestLanguage; source: string
  timeLimitMs: number; memoryMb: number
  testsDir: string                         // host path: <n>.in files
  tests: { ordinal: number; sample: boolean; group: number; answer: Buffer | null }[]
  mode: 'icpc' | 'ioi' | 'answers'
  checker: { kind: CheckerKind; epsilon: number; code: string }
  signal?: AbortSignal
  onProgress?: (p: { phase: 'compile' | 'test'; test: number | null; done: number; total: number }) => void
}
interface JudgeTestResult { ordinal; verdict: TestVerdict; timeMs; memoryKb; note?; output?; stderr?; exit? }
interface JudgeOutcome {
  verdict: Verdict; compileLog: string; tests: JudgeTestResult[]
  failedTest: number | null; passed: number; total: number
  timeMs: number | null; memoryKb: number | null
  systemDetail: string | null              // SE only, staff words
  answers: Map<number, Buffer> | null      // mode 'answers'
  wallMs: number
}
interface ContestJudge {
  readonly backend: 'docker' | 'test'
  judge(request: JudgeRequest): Promise<JudgeOutcome>
  probe(image: string): Promise<{ python: string | null; gpp: string | null; gcc: string | null }>
  sweep(): Promise<number>                 // leftover containers of this instance, at startup
}
```

IOI points are counted by the host from the per-test verdicts (`pointGroups`, `pointsFor` in `shared/contests.ts`), not by the harness.

**The queue** is `contest_submissions` itself. The pump (1 s tick, and at once on a new submission) fills free slots: the teacher's runs (`reference`, `answers`) first, then entrants by `submitted_at`, at most one running per entrant. Each run reserves memory through `ops/work-budget.ts` (`kind: 'competition'`, so rooms see it). A row `running` under another process life (`boot`) is an orphan: requeued, and after three starts it fails as SE. Slots: the setting `contests.judgeSlots` (null — auto: half the CPUs, 1–8).

## 3. Doors

Participant (`server/src/routes/contests.ts`, entrant cookie; refusals `{error, reason: ContestRefusal}`):

| Door | Answer |
|---|---|
| `GET /api/k/contests` | `EntrantContestList` |
| `GET /api/k/contests/:slug` | `EntrantContestView` (problems empty before the start; staff may preview a draft) |
| `POST /api/k/contests/:slug/join` `{name}` | `EntrantMe` — the competitions' join rules (`nameForJoin`, namesakes, the newcomer gets a key) |
| `GET …/submissions` · `GET …/submissions/:id` | `EntrantContestSubmissions` · `EntrantSubmissionDetail` (own only) |
| `POST …/submissions` `SubmitBody` | 201 `SubmitAccepted`; refuses `not_joined`, `not_open`, `closed`, `language`, `attempts`, `in_flight` (two pending), `too_often` (one per 5 s), `too_big` |
| `GET …/standings[?audience=class]` | `EntrantStandings` (board visibility, freeze per viewer) |
| `GET/POST …/questions`, `POST …/questions/seen` | `EntrantQuestions` / `ContestQuestion` |
| `GET …/stream` | SSE `state`: `ContestStreamState`, pushed on change, keep-alive 20 s |

Panel (`server/src/routes/admin-contests.ts`, staff cookie, scope as competitions: owner, creator, or a teacher of the course):

| Door | Answer |
|---|---|
| `GET /api/admin/contests` · `POST` `NewContestBody` | `ContestList` · `ContestView` |
| `GET/PUT /api/admin/contests/settings` | `ContestSettings` |
| `POST /api/admin/contests/judge/pause` `{paused}` | `JudgeStatus` |
| `GET/PATCH/DELETE /api/admin/contests/:id` | `ContestView` |
| `POST …/:id/open` · `finish` · `reopen` · `unfreeze` · `hide` · `show` | `ContestView` (`open` refuses with the readiness list) |
| `POST …/:id/problems` · `PATCH/DELETE …/problems/:pid` · `PUT …/problems/order` `{ids}` · `POST …/problems/copy` `{fromProblemId}` · `POST …/problems/import` (zip) | `ProblemView` / `ContestView` |
| `POST …/problems/:pid/tests/archive` (zip, `?mode=replace|append`) | `ArchiveImport` |
| `POST …/problems/:pid/tests` `NewTestBody` · `PATCH/DELETE …/tests/:n` · `DELETE …/tests` · `GET …/tests/:n/input|answer` | `ProblemView` / the file |
| `PUT …/problems/:pid/groups` `{groups}` | `ProblemView` |
| `POST …/problems/:pid/reference/check` · `…/answers` · `…/rejudge` | `ProblemView` / `{queued}` |
| `GET …/:id/submissions?problem&verdict&entrant&q&limit&offset` · `GET …/submissions/:sid` · `POST …/submissions/:sid/rejudge` | `AdminSubmissions` · `AdminSubmissionDetail` · `AdminSubmissionRow` |
| `GET …/:id/standings[?audience=class]` · `GET …/:id/standings.csv` | `AdminStandings` · CSV |
| `GET …/:id/entrants` · `DELETE …/entrants/:eid` | `{entrants: ContestEntrantRow[]}` |
| `GET …/:id/questions` · `POST …/questions/:qid/answer` `AnswerBody` · `POST …/announcements` · `DELETE …/questions/:qid` | `AdminQuestions` / `AdminQuestion` |
| `GET …/:id/stream` | SSE `state`: `ContestLiveState` |

Audit actions: `contest.created`, `contest.updated`, `contest.opened`, `contest.finished`, `contest.deleted`, `contest.unfrozen`, `contest.hidden`, `contest.shown`, `contest.problem.tests`, `contest.rejudged`, `contest.entrant.removed`.

## 4. Pages

Participant (`web/src/screens/ContestScreen.svelte`, `web/src/components/contests/*`): `/a/<slug>` and `/a/<slug>/<letter>` — the problem with the rail of letters, the statement (markdown + KaTeX, examples with «копировать»), the editor (CodeMirror, Python and C++ grammars in a chunk of their own, the draft kept per problem and language in localStorage, ⌘↵ sends, a file can be dropped) and the problem's latest submissions with live progress; `/a/<slug>/submissions` — the table with the test strip, the example's diff, the compiler's log, the code; `/a/<slug>/leaderboard` (+ `/screen` for the projector) — ICPC cells `+2 / 0:44`, first solves filled, frozen «?», the totals row, «Рядом со мной»; IOI cells with points and a bar; `/a/<slug>/questions`. The `/k` list gets a «Контесты» section. A phone gets the letters as a row and one column.

Panel (`web/src/admin/screens/Contests.svelte`, `web/src/admin/screens/contests/*`): the «Контесты» tab (list by phase, the judge strip), the contest editor (A2), the problem editor (A3: statement, limits and checker, tests with upload/hand entry/answers from the reference, the reference with its check), and the console of a live contest (A4: the feed with a drawer of test-by-test results including hidden tests' output, the board unfrozen, questions with «Ответить лично» / «Ответить всем», participants, settings).

## 5. Not in v1

Interactive problems, testlib checkers, PyPy/Java/Go, plagiarism checks, a personal timer («виртуальное участие»), the k8s broker, remote machines judging contests, the animated reveal of a frozen board.
