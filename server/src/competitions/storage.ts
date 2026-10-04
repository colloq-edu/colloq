/**
 * Where a competition's files live — and why exactly there.
 *
 * THE MAIN RULE, the reason this file exists separately at all: THE ANSWERS
 * ARE NEVER IN WORKSPACE_DIR. That folder is mounted into room containers,
 * and any student reads it from Python in three lines — SECURITY.md says so
 * outright. All of a competition's belongings live in DATA_DIR, next to the
 * database and the keys, where the class container does not look.
 *
 * The layout of one competition:
 *
 *   <DATA_DIR>/competitions/<id>/
 *     data/                 open files; mounted into a submission as /data:ro
 *     secret/               solution.csv and everything that never leaves the
 *                           server; mounted ONLY into the metric container
 *     sealed/               the hidden test: never mounted itself, never served;
 *                           linked into each run's own data folder
 *     baseline/             the teacher's sample notebook
 *     s/<submissionId>/in/  the submitted notebook, one, and nothing else
 *     s/<submissionId>/out/ run.json, submission.csv, executed.ipynb
 *     s/<submissionId>/score/  a copy of the answer for the metric container
 *     s/<submissionId>/attempts/<attemptId>/inputs/
 *                           with a hidden test: this run's data/, the open files
 *                           with the sealed ones swapped in; mounted as /data:ro
 *
 * Directories rather than files, and each under its own NEW name. This was
 * bought by experience, not taste: on colima (virtiofs) a path whose inode
 * has changed keeps being served to the container as the old one. A directory
 * removed and created again under the same name answers "Directory
 * nonexistent" from inside for a minute, and a single file mounted with
 * `-v file:/file` and rewritten gives "No such file or directory" and never
 * recovers. Meanwhile the submission silently sees neither the data nor its
 * notebook. Hence `in/`, `out/` and `score/` inside the submission folder,
 * whose name never repeats.
 *
 * Paths are handed outside through `hostPathOf`: under `make up` the server
 * itself sits in a container, and the path at which it sees a file is
 * unknown to the docker daemon — exactly the same trouble and the same cure
 * as for rooms (kernel/pool.ts · hostMount).
 */
import path from 'node:path'
import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { config } from '../config.js'
import { createAnchoredFilesystem, type HeldFile } from '../secure-files.js'
import { EXECUTED_NOTEBOOK_FILE } from '@shared/competitions'

/** The root of all competition belongings. */
export const competitionsDir = path.join(config.dataDir, 'competitions')

/**
 * No paths of our own are assembled by hand here: every operation goes
 * through a file system anchored to the root, which opens every segment with
 * O_NOFOLLOW. The file name comes from the teacher and the competition name
 * from the database; neither is a reason to trust the string.
 */
export const competitionsFs = createAnchoredFilesystem(competitionsDir)

/** Identifiers go into a path, so they are checked by their letters, not by trust. */
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/

/**
 * The data file name — what the participant will see in `data/` and write in
 * their notebook. No paths, no leading dot, no spaces at the edges: a file
 * `../../colloq.db` should not even be up for discussion.
 */
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/

function checkId(id: string): string {
  if (!ID_OK.test(id)) throw new Error('Competition storage: bad identifier')
  return id
}

function checkName(name: string): string {
  if (!NAME_OK.test(name) || name.includes('..')) {
    throw new Error('Competition storage: bad file name')
  }
  return name
}

/* ----------------------------------------------------------------- paths */

export function competitionDir(id: string): string {
  return path.join(competitionsDir, checkId(id))
}

/** Open files. Mounted into a submission `:ro`. */
export function openDir(id: string): string {
  return path.join(competitionDir(id), 'data')
}

/**
 * The answers and everything that gives them away.
 *
 * A separate directory next to the open files, not a subfolder inside them:
 * the open directory is mounted into the participant's container whole, and a
 * nested "secret" subdirectory would travel there along with it.
 */
export function secretDir(id: string): string {
  return path.join(competitionDir(id), 'secret')
}

/**
 * The hidden test (FileVisibility `sealed`).
 *
 * Next to `data/` and `secret/`, never inside either: `data/` travels into
 * every notebook container whole and is downloaded file by file, `secret/`
 * goes only to the metric. This one is seen by the notebook and nobody else,
 * and only through a run's own composed folder (composeRunInputs) — so it is
 * never mounted itself, and no door reads from it.
 */
export function sealedDir(id: string): string {
  return path.join(competitionDir(id), 'sealed')
}

export function baselineDir(id: string): string {
  return path.join(competitionDir(id), 'baseline')
}

export function submissionDir(id: string, submissionId: string): string {
  return path.join(competitionDir(id), 's', checkId(submissionId))
}

/** The notebook container's input: exactly one notebook, `:ro`. */
export function inputDir(id: string, submissionId: string): string {
  return path.join(submissionDir(id, submissionId), 'in')
}

/** Host-promoted artifacts; participant containers cannot write here. */
export function resultDir(id: string, submissionId: string): string {
  return path.join(submissionDir(id, submissionId), 'out')
}

/** Every execution owns its directories; previous results are never inputs to
 * a new notebook attempt. Only validated host exports are promoted to out/. */
export type AttemptPart = 'result' | 'score' | 'score-out' | 'score-config' | 'secret' | 'inputs'

export function attemptDir(id: string, submissionId: string, attemptId: string, part: AttemptPart = 'result'): string {
  return ensureDir(attemptPath(id, submissionId, attemptId, part))
}

/**
 * The same path, without creating it — for comparing a path someone handed
 * over against the one it must be (broker-runner.ts checks the run's data
 * folder this way). The part is named `inputs`, not `data`: an existing check
 * of the metric Pod refuses any mount ending in /data.
 */
export function attemptPath(id: string, submissionId: string, attemptId: string, part: AttemptPart): string {
  return path.join(submissionDir(id, submissionId), 'attempts', checkId(attemptId), part)
}

export function dropAttempt(id: string, submissionId: string, attemptId: string): void {
  competitionsFs.rmSync(path.join(submissionDir(id, submissionId), 'attempts', checkId(attemptId)), { recursive: true, force: true })
}

/**
 * Snapshot through anchored descriptors, streamed.
 *
 * Asynchronous on purpose: the answer key may weigh two hundred megabytes, and
 * a synchronous copy per submission stops the event loop that serves the
 * class — with eight slots, eight times per wave of submissions.
 */
export async function copyCompetitionFile(from: string, to: string): Promise<void> {
  const source = competitionsFs.createReadStream(from)
  let target: fs.WriteStream
  try {
    target = competitionsFs.createWriteStream(to, { flags: 'wx', mode: 0o600 })
  } catch (error) {
    source.destroy()
    throw error
  }
  await pipeline(source, target)
}

/**
 * The attempt's answer becomes the submission's answer — by rename, not by
 * copy.
 *
 * The attempt directory is dropped right after the run, so moving the file
 * costs one metadata operation instead of reading and writing up to 64 MB on
 * the event loop. The rename replaces `out/submission.csv` atomically:
 * readers see the last complete successful answer, never half of the next.
 */
export function promoteAttempt(id: string, submissionId: string, from: string): void {
  const out = ensureDir(resultDir(id, submissionId))
  competitionsFs.renameSync(path.join(from, SUBMISSION_FILE), path.join(out, SUBMISSION_FILE))
}

/**
 * A failed notebook still has useful current output; retain its execution
 * artifacts separately from the last successful CSV used by metric rescoring.
 *
 * Moved, not copied, for the same reason as the answer — and so called ONCE
 * per attempt: a second call finds nothing to move and removes what the first
 * one published.
 */
export function publishAttemptArtifacts(id: string, submissionId: string, from: string): void {
  const out = ensureDir(resultDir(id, submissionId))
  for (const name of [EXECUTED_FILE, 'run.json']) {
    const source = path.join(from, name)
    if (regularFileWithin(source, EXECUTED_BYTES)) competitionsFs.renameSync(source, path.join(out, name))
    else competitionsFs.rmSync(path.join(out, name), { force: true })
  }
}

/** A regular file no bigger than `limit`, looked at through O_NOFOLLOW: a link is not an artifact. */
function regularFileWithin(file: string, limit: number): boolean {
  try {
    const info = competitionsFs.statSync(file)
    return info.isFile() && info.size <= limit
  } catch {
    return false
  }
}

/**
 * The metric container's input: a copy of the answer and nothing more.
 *
 * Its own directory, because the metric container must see neither the
 * participant's executed notebook nor its output: the teacher's code runs
 * next to the answers, and anything that gets there may leak into the text of
 * an error.
 */
export function scoreDir(id: string, submissionId: string): string {
  return path.join(submissionDir(id, submissionId), 'score')
}

/**
 * Where the metric container writes — a NEIGHBOURING directory, not inside
 * `score/`.
 *
 * The same path mounted both read-only (`/submission`) and writable (`/out`)
 * looks like one folder from outside: the watchdog counting how much the
 * container wrote to disk would count the copy of the answer in and kill the
 * metric on the very first submission bigger than its cap.
 */
export function scoreOutDir(id: string, submissionId: string): string {
  return path.join(submissionDir(id, submissionId), 'score-out')
}

/** The name of the submitted notebook on disk — always the same. */
export const NOTEBOOK_FILE = 'notebook.ipynb'
/**
 * The name of the EXECUTED notebook in `out/` — the harness's name for it,
 * not the sent one's: asking `out/` for `notebook.ipynb` finds nothing.
 */
export const EXECUTED_FILE = EXECUTED_NOTEBOOK_FILE
/**
 * The executed notebook's ceiling, the same in every export table (harness.ts
 * · EXPORT_FILES, the broker's exporter). The harness keeps a notebook's
 * outputs to two megabytes, so only its own source comes near it.
 */
export const EXECUTED_BYTES = 64 * 1024 * 1024
/** The default answer name; a competition may name its own. */
export const SUBMISSION_FILE = 'submission.csv'
/** The teacher's answers. */
export const SOLUTION_FILE = 'solution.csv'

/**
 * The same path through the eyes of the docker daemon.
 *
 * Under `make run` the server is on the host and the paths match. Under
 * `make up` it is itself in a container, and `-v /data/competitions/...` would
 * give the submission an empty directory created by the daemon on the fly —
 * it would silently see neither the data nor the notebook. `DATA_HOST_DIR`
 * names the same folder the way the host sees it; empty means there is
 * nothing to translate.
 */
export function hostPathOf(inside: string): string {
  const root = (process.env.DATA_HOST_DIR ?? '').trim()
  if (!root) return inside
  return path.join(root, path.relative(config.dataDir, inside))
}

/* -------------------------------------------------------------- writing */

/**
 * No mode is set here on purpose: the anchored file system creates
 * directories itself, with its own mode, and the root lies inside DATA_DIR —
 * the very 0700 where the sign-in keys already live (config.ensureDataDir).
 */
function ensureDir(absolute: string): string {
  competitionsFs.mkdirSync(absolute, { recursive: true })
  return absolute
}

/** Create the competition's directories. Idempotent: called on creation and later too. */
export function ensureCompetition(id: string): void {
  ensureDir(openDir(id))
  ensureDir(secretDir(id))
  ensureDir(baselineDir(id))
}

/**
 * Write next to the file and rename over it, never truncate in place.
 *
 * A run in progress holds the old file — a copy of the answer key in its
 * snapshot, a hard link in its composed data folder (composeRunInputs) — and
 * the rename leaves it the old bytes whole instead of half of each. The
 * temporary name starts with a dot, which no file name may (NAME_OK), so it
 * can never be mistaken for, or collide with, a real one.
 */
function writeReplacing(directory: string, name: string, body: Uint8Array): void {
  const file = path.join(directory, checkName(name))
  const temporary = path.join(directory, `.${checkName(name)}-next`)
  competitionsFs.writeFileSync(temporary, Buffer.from(body), { mode: 0o600 })
  competitionsFs.renameSync(temporary, file)
}

/** Put an open data file. Returns how many bytes were written. */
export function putOpenFile(id: string, name: string, body: Uint8Array): number {
  writeReplacing(ensureDir(openDir(id)), name, body)
  return body.length
}

/**
 * Put a hidden-test file under the name the notebook will read it by in
 * `data/`. A door of its own, like the answers': a hidden test written into
 * `data/` by a wrong parameter would be downloadable by the whole class.
 */
export function putSealedFile(id: string, name: string, body: Uint8Array): number {
  writeReplacing(ensureDir(sealedDir(id)), name, body)
  return body.length
}

/**
 * Put the answers (or anything else the participant must not see).
 *
 * A separate door from `putOpenFile`, and not for convenience: mixing up the
 * directory means handing the answers to the class, and such a mistake must
 * look like a different function name, not a different parameter value.
 */
export function putSecretFile(id: string, name: string, body: Uint8Array): number {
  /*
   * A job that started a minute ago is still copying the old answer key into
   * its snapshot (runner.ts · snapshotSecrets): writeReplacing leaves it the
   * old bytes whole. This directory is never mounted itself, so the new inode
   * surprises no container.
   */
  writeReplacing(ensureDir(secretDir(id)), name, body)
  return body.length
}

export function putBaseline(id: string, body: Uint8Array): number {
  const file = path.join(ensureDir(baselineDir(id)), NOTEBOOK_FILE)
  competitionsFs.writeFileSync(file, Buffer.from(body), { mode: 0o600 })
  return body.length
}

/**
 * Lay the submitted notebook out for a submission.
 *
 * The directory must be new — see the file header about virtiofs. A repeated
 * attempt with the same identifier refuses out loud: quiet reuse would give a
 * submission that sees someone else's notebook or none at all.
 */
export function putSubmissionNotebook(
  id: string,
  submissionId: string,
  body: Uint8Array,
): { input: string; result: string } {
  const dir = submissionDir(id, submissionId)
  if (competitionsFs.existsSync(dir)) {
    throw new Error(`Competition storage: submission directory already exists (${submissionId})`)
  }
  const input = ensureDir(inputDir(id, submissionId))
  const result = ensureDir(resultDir(id, submissionId))
  competitionsFs.writeFileSync(path.join(input, NOTEBOOK_FILE), Buffer.from(body), { mode: 0o600 })
  return { input, result }
}

/**
 * The directory for the metric container — created anew for every run.
 *
 * Rescoring after a metric fix calls this a second time, and the old
 * directory is removed whole: a file in it cannot be overwritten for the same
 * reason single files are not mounted.
 */
export function freshScoreDir(id: string, submissionId: string, answer: Uint8Array): string {
  const dir = scoreDir(id, submissionId)
  competitionsFs.rmSync(dir, { recursive: true, force: true })
  ensureDir(dir)
  competitionsFs.writeFileSync(path.join(dir, SUBMISSION_FILE), Buffer.from(answer), {
    mode: 0o600,
  })
  return dir
}

/**
 * An empty directory for the metric's answer — also anew for every run.
 *
 * Mode 0777 here is not generosity: the directory is mounted into a container
 * that runs as uid 1000, and it is the container, not us, that puts the file
 * in it. The same trick as the submission's `/result`; nothing foreign lies
 * in it — only one json, read right after the container dies.
 */
export function freshScoreOutDir(id: string, submissionId: string): string {
  const dir = scoreOutDir(id, submissionId)
  competitionsFs.rmSync(dir, { recursive: true, force: true })
  ensureDir(dir)
  competitionsFs.chmodSync(dir, 0o777)
  return dir
}

/* -------------------------------------------------------------- reading */

function readIfExists(file: string, limit: number): Buffer | null {
  try {
    if (competitionsFs.statSync(file).size > limit) return null
    return competitionsFs.readFileSync(file) as Buffer
  } catch {
    return null
  }
}

/**
 * The first bytes of an open file — enough for its header line (the columns
 * a participant is shown for the example a hidden test replaces), without
 * reading a two-hundred-megabyte table for one line.
 */
export function readOpenHead(id: string, name: string, bytes = 64 * 1024): Buffer | null {
  let fd: number | null = null
  try {
    fd = competitionsFs.openSync(path.join(openDir(id), checkName(name)), 'r')
    const buffer = Buffer.alloc(bytes)
    const read = fs.readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read)
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/** The bytes of an open file — what the participant downloads. */
export function readOpenFile(id: string, name: string, limit = 512 * 1024 * 1024): Buffer | null {
  return readIfExists(path.join(openDir(id), checkName(name)), limit)
}

/** The bytes of the answers. They never go outside — only into the metric container. */
export function readSecretFile(id: string, name: string, limit = 512 * 1024 * 1024): Buffer | null {
  return readIfExists(path.join(secretDir(id), checkName(name)), limit)
}

/**
 * The bytes of a hidden-test file — for the teacher's header preview only
 * (its columns in the editor). Like the answers, it has no door that hands
 * them out, and no `hold` function to build one with.
 */
export function readSealedFile(id: string, name: string, limit = 512 * 1024 * 1024): Buffer | null {
  return readIfExists(path.join(sealedDir(id), checkName(name)), limit)
}

export function readBaseline(id: string, limit = 64 * 1024 * 1024): Buffer | null {
  return readIfExists(path.join(baselineDir(id), NOTEBOOK_FILE), limit)
}

/**
 * What a submission left behind: `progress.json`, `run.json`, the answer, the
 * executed notebook. The name is checked by the same rule — a request from
 * the browser comes here ("Download the notebook with its output").
 */
export function readResultFile(
  id: string,
  submissionId: string,
  name: string,
  limit = 64 * 1024 * 1024,
): Buffer | null {
  return readIfExists(path.join(resultDir(id, submissionId), checkName(name)), limit)
}

/**
 * A file descriptor to hand to the browser — WITHOUT reading it into memory.
 *
 * `train.csv` can be a hundred megabytes, and a class of thirty people
 * downloads it in the first two minutes of the class period. `readOpenFile`
 * on such a request would hold thirty buffers in the same process that is
 * running the class at that minute. `openRead` hands over an open inode, and
 * from there the file flows past us (`secure-files.ts` · downloadHeldFile) —
 * with byte ranges and resumption.
 *
 * There is NO such door for the hidden answers, and there cannot be:
 * `solution.csv` never goes outside at any address.
 */
export function holdOpenFile(id: string, name: string): HeldFile {
  return competitionsFs.openRead(path.join(openDir(id), checkName(name)))
}

/** The same for what a submission left behind: the executed notebook, the log. */
export function holdResultFile(id: string, submissionId: string, name: string): HeldFile {
  return competitionsFs.openRead(path.join(resultDir(id, submissionId), checkName(name)))
}

/** And for the submitted notebook — it is the answer too until the run is over. */
export function holdSubmittedNotebook(id: string, submissionId: string): HeldFile {
  return competitionsFs.openRead(path.join(inputDir(id, submissionId), NOTEBOOK_FILE))
}

/**
 * The executed notebook, held — or `null` when the run left none.
 *
 * Only a file that is not there is `null`. Anything else that keeps it from
 * opening is thrown: the caller falls back to the SENT notebook on `null`,
 * and handing that out in place of an executed copy that exists is exactly
 * the mistake that showed every participant their notebook without outputs.
 */
export function holdExecutedNotebook(id: string, submissionId: string): HeldFile | null {
  try {
    return holdResultFile(id, submissionId, EXECUTED_FILE)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Which notebook the author's download would hand out right now, by what is on
 * disk. `executed: false` for a blind run, whose download is the sent notebook
 * only (routes/competitions.ts).
 */
export function notebookOnDisk(id: string, submissionId: string, executed = true): 'executed' | 'sent' | null {
  if (executed && regularFileWithin(path.join(resultDir(id, submissionId), EXECUTED_FILE), EXECUTED_BYTES)) return 'executed'
  if (regularFileWithin(path.join(inputDir(id, submissionId), NOTEBOOK_FILE), Number.MAX_SAFE_INTEGER)) return 'sent'
  return null
}

export function listOpenFiles(id: string): { name: string; bytes: number }[] {
  return listDir(openDir(id))
}

export function listSecretFiles(id: string): { name: string; bytes: number }[] {
  return listDir(secretDir(id))
}

function listDir(absolute: string): { name: string; bytes: number }[] {
  let names: string[]
  try {
    names = competitionsFs.readdirSync(absolute) as string[]
  } catch {
    return []
  }
  const out: { name: string; bytes: number }[] = []
  for (const name of names) {
    try {
      out.push({ name, bytes: competitionsFs.statSync(path.join(absolute, name)).size })
    } catch {
      // The file vanished between readdir and stat — no trouble, it was not
      // in the answer either.
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1))
}

/** What the open files weigh — against the "up to 200 MB per competition" ceiling. */
export function openBytes(id: string): number {
  return listOpenFiles(id).reduce((sum, file) => sum + file.bytes, 0)
}

/* -------------------------------------------------------------- cleanup */

export function dropOpenFile(id: string, name: string): boolean {
  return remove(path.join(openDir(id), checkName(name)))
}

export function dropSecretFile(id: string, name: string): boolean {
  return remove(path.join(secretDir(id), checkName(name)))
}

/** A run already holding the file keeps its link; the next run composes without it. */
export function dropSealedFile(id: string, name: string): boolean {
  return remove(path.join(sealedDir(id), checkName(name)))
}

/* --------------------------------------------------------- a run's data */

/** Errors by which a hard link says "not here", and a copy has to do. */
const NO_LINK = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'ENOSYS'])

/** How a run's data folder gets its files — swapped out by a test to make links fail. */
export const inputLinks = {
  link: (from: string, to: string): void => competitionsFs.linkSync(from, to),
}

/**
 * Compose one run's `data/`: the open files, with the hidden test swapped in.
 *
 * A folder of the attempt's own (`attempts/<attemptId>/inputs`), mounted at
 * /data in place of the competition's open `data/`, so `data/test.csv` and
 * `/data/test.csv` both read the hidden test (the harness links the working
 * folder's `data` to /data) while the participant downloads the example. A
 * hidden file named like an open one replaces it; any other name is added.
 *
 * Hard links, not copies: the open data may be two hundred megabytes, and a
 * copy per run would be that much disk and time for every submission. Where
 * the volume refuses a link (another device, a CSI driver without them), the
 * file is copied instead. A link keeps the bytes the run started with even if
 * the teacher replaces the file mid-run: every write renames a new inode
 * over the name (writeReplacing).
 *
 * The set comes from the database rows, not from listing the folders. A
 * hidden row whose file is missing throws: running quietly on the example
 * would score a submission on the wrong rows. An open row without its file is
 * left out, which is what the container saw of it before.
 *
 * Removed with the attempt (dropAttempt), after the run or after a restart.
 */
export async function composeRunInputs(
  id: string,
  submissionId: string,
  attemptId: string,
  files: { open: readonly string[]; sealed: readonly string[] },
): Promise<string> {
  const dir = attemptDir(id, submissionId, attemptId, 'inputs')
  const sealed = new Set(files.sealed.map(checkName))
  const place = async (from: string, name: string): Promise<void> => {
    const to = path.join(dir, name)
    try {
      inputLinks.link(from, to)
    } catch (error) {
      if (!NO_LINK.has((error as NodeJS.ErrnoException).code ?? '')) throw error
      await copyCompetitionFile(from, to)
    }
  }
  for (const name of files.open.map(checkName)) {
    if (sealed.has(name)) continue
    const from = path.join(openDir(id), name)
    if (!regularFileWithin(from, Number.MAX_SAFE_INTEGER)) continue
    await place(from, name)
  }
  for (const name of sealed) {
    const from = path.join(sealedDir(id), name)
    if (!regularFileWithin(from, Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Competition storage: the hidden test file ${name} is missing on disk`)
    }
    await place(from, name)
  }
  return dir
}

function remove(absolute: string, recursive = false): boolean {
  try {
    if (!competitionsFs.existsSync(absolute)) return false
    competitionsFs.rmSync(absolute, { recursive, force: true })
    return true
  } catch {
    return false
  }
}

/** Remove everything one submission left behind: the notebook, the output, the answer. */
export function removeSubmission(id: string, submissionId: string): boolean {
  return remove(submissionDir(id, submissionId), true)
}

/**
 * Remove what lived exactly for the duration of metric scoring.
 *
 * The copy of the answer for the metric container and its json are a second
 * copy of the same file that already lies in `out/`. Keeping it between runs
 * means storing every answer twice: in a competition of three hundred
 * submissions that is gigabytes nobody reads. Rescoring creates the directory
 * anew — it has to be new anyway.
 */
export function dropScoreDirs(id: string, submissionId: string): boolean {
  const answer = remove(scoreDir(id, submissionId), true)
  const out = remove(scoreOutDir(id, submissionId), true)
  return answer || out
}

/**
 * A competition was deleted — its data, answers, sample notebook and all
 * submissions go with it. None of this outlives the database row: answers
 * left on disk from a deleted competition are answers nobody watches over any
 * more.
 */
export function removeCompetition(id: string): boolean {
  return remove(competitionDir(id), true)
}

/**
 * What is kept longer than the submission itself.
 *
 * The number (public and private) lives in the database forever — the
 * leaderboard must add up even a year later. The heavy stuff — the executed
 * notebook with output, the answer, the submitted file — is needed while the
 * participant is dealing with a failure, and may go once the competition is
 * long closed. Everything except what is listed in `keep` is removed here;
 * the store (store.ts) decides whom to keep, because that is a question for
 * the database, not the disk.
 *
 * A directory whose name is not a submission identifier is not ours to judge
 * and stays (the check would throw, and one stray `.DS_Store` stopped the
 * whole sweep). The bytes are counted before each removal, for the log line
 * that says what the sweep freed.
 */
export function pruneSubmissions(id: string, keep: ReadonlySet<string>): { removed: number; bytes: number } {
  let names: string[]
  try {
    names = competitionsFs.readdirSync(path.join(competitionDir(id), 's')) as string[]
  } catch {
    return { removed: 0, bytes: 0 }
  }
  let removed = 0
  let bytes = 0
  for (const name of names) {
    if (keep.has(name) || !ID_OK.test(name)) continue
    const size = treeBytes(submissionDir(id, name))
    if (!removeSubmission(id, name)) continue
    removed++
    bytes += size
  }
  return { removed, bytes }
}

/** What a directory holds, walked without following a link (the anchored file system refuses them anyway). */
export function treeBytes(absolute: string): number {
  let names: string[]
  try {
    names = competitionsFs.readdirSync(absolute) as string[]
  } catch {
    return 0
  }
  let total = 0
  for (const name of names) {
    const child = path.join(absolute, name)
    try {
      const info = competitionsFs.lstatSync(child)
      total += info.isDirectory() ? treeBytes(child) : info.size
    } catch {
      // Gone between the listing and the look: it weighs nothing now.
    }
  }
  return total
}

/**
 * Sweep up after deletion paths that do not know about this storage.
 *
 * A second line, exactly as for output images (blobs.ts · sweepOrphans): the
 * cost of a mistake is asymmetric — a forgotten folder means the answers of a
 * deleted competition lying on disk for an unlimited time. Live names come
 * from outside, so that this module does not know about the database.
 */
export function sweepOrphans(live: ReadonlySet<string>): number {
  let names: string[]
  try {
    names = competitionsFs.readdirSync(competitionsDir) as string[]
  } catch {
    return 0
  }
  let dropped = 0
  for (const name of names) {
    if (live.has(name) || !ID_OK.test(name)) continue
    if (removeCompetition(name)) dropped++
  }
  return dropped
}
