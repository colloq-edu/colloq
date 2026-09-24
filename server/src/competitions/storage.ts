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
 *     baseline/             the teacher's sample notebook
 *     s/<submissionId>/in/  the submitted notebook, one, and nothing else
 *     s/<submissionId>/out/ beacon, run.json, submission.csv, executed notebook
 *     s/<submissionId>/score/  a copy of the answer for the metric container
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
import { config } from '../config.js'
import { createAnchoredFilesystem, type HeldFile } from '../secure-files.js'

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
export function attemptDir(id: string, submissionId: string, attemptId: string, part: 'result' | 'score' | 'score-out' | 'score-config' | 'secret' = 'result'): string {
  return ensureDir(path.join(submissionDir(id, submissionId), 'attempts', checkId(attemptId), part))
}

export function dropAttempt(id: string, submissionId: string, attemptId: string): void {
  competitionsFs.rmSync(path.join(submissionDir(id, submissionId), 'attempts', checkId(attemptId)), { recursive: true, force: true })
}

/** Snapshot through anchored descriptors without buffering a whole dataset. */
export function copyCompetitionFile(from: string, to: string): void {
  const source = competitionsFs.openRead(from)
  let output: number | undefined
  try {
    output = competitionsFs.openSync(to, 'wx', 0o600)
    const chunk = Buffer.alloc(1024 * 1024)
    let size: number
    while ((size = fs.readSync(source.fd, chunk, 0, chunk.length, null)) > 0) {
      let offset = 0
      while (offset < size) offset += fs.writeSync(output, chunk, offset, size - offset)
    }
  } finally { source.close(); if (output !== undefined) fs.closeSync(output) }
}

export function promoteAttempt(id: string, submissionId: string, from: string, answer: Buffer): void {
  const out = ensureDir(resultDir(id, submissionId))
  // Atomic host rename: readers see the last complete successful answer.
  const temporary = path.join(out, '.answer-next')
  competitionsFs.writeFileSync(temporary, answer, { mode: 0o600 })
  competitionsFs.renameSync(temporary, path.join(out, SUBMISSION_FILE))
  publishAttemptArtifacts(id, submissionId, from)
}

/** A failed notebook still has useful current output; retain its execution
 * artifacts separately from the last successful CSV used by metric rescoring. */
export function publishAttemptArtifacts(id: string, submissionId: string, from: string): void {
  const out = ensureDir(resultDir(id, submissionId))
  for (const name of ['executed.ipynb', 'run.json']) {
    const body = readIfExists(path.join(from, name), 64 * 1024 * 1024)
    if (body) {
      const temporary = path.join(out, `.${name}-next`)
      competitionsFs.writeFileSync(temporary, body, { mode: 0o600 })
      competitionsFs.renameSync(temporary, path.join(out, name))
    } else competitionsFs.rmSync(path.join(out, name), { force: true })
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

/** Put an open data file. Returns how many bytes were written. */
export function putOpenFile(id: string, name: string, body: Uint8Array): number {
  const file = path.join(ensureDir(openDir(id)), checkName(name))
  competitionsFs.writeFileSync(file, Buffer.from(body), { mode: 0o600 })
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
  const file = path.join(ensureDir(secretDir(id)), checkName(name))
  competitionsFs.writeFileSync(file, Buffer.from(body), { mode: 0o600 })
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

/** The bytes of an open file — what the participant downloads. */
export function readOpenFile(id: string, name: string, limit = 512 * 1024 * 1024): Buffer | null {
  return readIfExists(path.join(openDir(id), checkName(name)), limit)
}

/** The bytes of the answers. They never go outside — only into the metric container. */
export function readSecretFile(id: string, name: string, limit = 512 * 1024 * 1024): Buffer | null {
  return readIfExists(path.join(secretDir(id), checkName(name)), limit)
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
 */
export function pruneSubmissions(id: string, keep: ReadonlySet<string>): number {
  let names: string[]
  try {
    names = competitionsFs.readdirSync(path.join(competitionDir(id), 's')) as string[]
  } catch {
    return 0
  }
  let dropped = 0
  for (const name of names) {
    if (keep.has(name)) continue
    if (removeSubmission(id, name)) dropped++
  }
  return dropped
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
