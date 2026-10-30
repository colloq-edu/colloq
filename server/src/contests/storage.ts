/**
 * Where a contest's files live — the tests, revision by revision, and the
 * judge's run directories (docs/architecture/contests.md §1).
 *
 *   <DATA_DIR>/contests/
 *     .judge/…                                the harness (judge/*: not this module's)
 *     <cid>/problems/<pid>/r<rev>/in/<n>.in   inputs of revision <rev>, mounted :ro at /tests
 *     <cid>/problems/<pid>/r<rev>/ans/<n>.ans answers: read by the host, never mounted
 *     <cid>/runs/<sid>-<attempt>/             one judging's job (the judge lays it out)
 *
 * In DATA_DIR, never in WORKSPACE_DIR: the class's folders are mounted into
 * room containers, and a test's answer there is a contest solved in three
 * lines of Python (SECURITY.md).
 *
 * A REVISION IS WRITTEN WHOLE AND NEVER CHANGED. Any change of a problem's
 * tests — an archive, a test typed in, a mark moved, an answer written by the
 * reference — writes a new `r<rev>` beside the current one (the files that
 * did not change hard-linked, so it costs no disk), and only then does the
 * store move the problem's tests_revision to it. A judging that started on the
 * old revision keeps reading the old one to its end; the old one goes once
 * nothing queued or running names it (pruneRevisions). Two lessons are in
 * this: a run must never see half of an upload, and on colima (virtiofs) a
 * path whose inode changed keeps being served to a container as the old one
 * (competitions/storage.ts's header has the story) — so every directory a
 * container mounts is one that did not exist before, and no name is ever
 * used twice. That is why a new revision takes the next number free on disk,
 * not merely the next after the current one: a crash between the write and
 * the switch leaves a directory nobody ever mounted, and its name is skipped
 * rather than removed and made again.
 *
 * WHO MAY READ WHAT. The judge's container runs its harness as root with no
 * DAC capabilities (--cap-drop ALL), so root there reads only what the world
 * may read: the inputs are 0644 in 0755 directories, whoever owns them on the
 * host. The answers are never mounted — the host reads them and hands them to
 * the harness through its stdin — so they stay 0600 in a 0700 directory.
 *
 * Every operation goes through a file system anchored to the root, which
 * opens every segment with O_NOFOLLOW (secure-files.ts). The paths here are
 * this server's own; the judge turns the ones it mounts into the daemon's
 * through hostPathOf (judge/docker-judge.ts) — under `make up` the server sits
 * in a container itself, and the daemon knows the host's path, not ours.
 */
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { dataDir } from '../data-dir.js'
import { createAnchoredFilesystem, type HeldFile } from '../secure-files.js'
import { CONTEST_LIMITS, SNIPPET_BYTES } from '@shared/contests'

/** The root of everything contests keep on disk. */
export const contestsDir = path.join(dataDir, 'contests')

export const contestsFs = createAnchoredFilesystem(contestsDir)

/** Identifiers go into a path, so they are checked by their letters, not by trust. */
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/

function checkId(id: string): string {
  if (!ID_OK.test(String(id ?? ''))) throw new Error('Contest storage: bad identifier')
  return id
}

function checkNumber(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Contest storage: bad ${what}`)
  return value
}

/** The modes (see the header): what a container reads, and what only the host does. */
const OPEN_DIR = 0o755
const OPEN_FILE = 0o644
const SECRET_DIR = 0o700
const SECRET_FILE = 0o600

/* ----------------------------------------------------------------- paths */

export function contestDir(contestId: string): string {
  return path.join(contestsDir, checkId(contestId))
}

export function problemDir(contestId: string, problemId: string): string {
  return path.join(contestDir(contestId), 'problems', checkId(problemId))
}

export function revisionDir(contestId: string, problemId: string, revision: number): string {
  return path.join(problemDir(contestId, problemId), `r${checkNumber(revision, 'revision')}`)
}

/** The inputs of one revision: what the judge mounts as /tests. */
export function inputsDir(contestId: string, problemId: string, revision: number): string {
  return path.join(revisionDir(contestId, problemId, revision), 'in')
}

function answersDir(contestId: string, problemId: string, revision: number): string {
  return path.join(revisionDir(contestId, problemId, revision), 'ans')
}

export type TestPart = 'in' | 'ans'

export function testFile(contestId: string, problemId: string, revision: number, ordinal: number, part: TestPart): string {
  checkNumber(ordinal, 'test number')
  return part === 'in'
    ? path.join(inputsDir(contestId, problemId, revision), `${ordinal}.in`)
    : path.join(answersDir(contestId, problemId, revision), `${ordinal}.ans`)
}

export function runsDir(contestId: string): string {
  return path.join(contestDir(contestId), 'runs')
}

/** One judging's directory, `runs/<sid>-<attempt>`: the attempt number never repeats, so neither does the name. */
export function jobDir(contestId: string, submissionId: string, attempt: number): string {
  return path.join(runsDir(contestId), `${checkId(submissionId)}-${checkNumber(attempt, 'attempt')}`)
}

/* ------------------------------------------------------------ revisions */

/** Where one file of a new revision comes from: bytes in hand (or made on demand), or a file already on disk. */
export type TestSource =
  | { bytes: Buffer | (() => Buffer) }
  | { link: { contestId: string; problemId: string; revision: number; ordinal: number } }

export interface PlannedTest {
  /** 1-based, dense: the test's number in the new revision. */
  ordinal: number
  input: TestSource
  /** null: a test without an answer yet. */
  answer: TestSource | null
}

export interface WrittenTest {
  ordinal: number
  inputBytes: number
  answerBytes: number | null
}

export type TestsRefusalWhy = 'tooMany' | 'fileTooBig' | 'totalTooBig'

/** A revision that would break a cap: nothing of it stays on disk. */
export class TestsRefused extends Error {
  constructor(readonly why: TestsRefusalWhy, readonly ordinal: number | null = null) {
    super(`Contest tests refused: ${why}`)
  }
}

const REVISION = /^r(\d+)$/

/** The revisions present on disk, by number. */
export function revisionsOnDisk(contestId: string, problemId: string): number[] {
  const dir = problemDir(contestId, problemId)
  let names: string[]
  try {
    names = contestsFs.readdirSync(dir) as unknown as string[]
  } catch {
    return []
  }
  return names.flatMap((name) => {
    const match = REVISION.exec(name)
    return match ? [Number(match[1])] : []
  })
}

/**
 * The number a new revision takes: past the current one AND past every name
 * on disk, so a directory a crash left half-written is skipped, never made
 * again under its old name (see the header).
 */
export function nextRevision(contestId: string, problemId: string, current: number): number {
  return Math.max(current, ...revisionsOnDisk(contestId, problemId)) + 1
}

export function revisionExists(contestId: string, problemId: string, revision: number): boolean {
  return contestsFs.existsSync(inputsDir(contestId, problemId, revision))
}

function makeDir(dir: string, mode: number): void {
  contestsFs.mkdirSync(dir, { recursive: true })
  // The anchored mkdir makes 2775 under the umask; the judge needs exactly this.
  contestsFs.chmodSync(dir, mode)
}

/**
 * One file of the new revision: a hard link to the same file of an older
 * revision when it did not change (no disk spent), a copy where the volume
 * refuses links, or the bytes given. Returns its size.
 */
function placeFile(source: TestSource, target: string, part: TestPart, mode: number): number {
  if ('link' in source) {
    const from = testFile(source.link.contestId, source.link.problemId, source.link.revision, source.link.ordinal, part)
    try {
      contestsFs.linkSync(from, target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EMLINK' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw error
      contestsFs.writeFileSync(target, contestsFs.readFileSync(from), { flag: 'wx', mode })
      contestsFs.chmodSync(target, mode)
    }
    return contestsFs.statSync(target).size
  }
  const bytes = typeof source.bytes === 'function' ? source.bytes() : source.bytes
  contestsFs.writeFileSync(target, bytes, { flag: 'wx', mode })
  // The mode given to open() goes through the umask; the judge needs exactly this one.
  contestsFs.chmodSync(target, mode)
  return bytes.length
}

/**
 * Write revision `revision` of a problem's tests, whole, under the caps of
 * CONTEST_LIMITS: at most `tests` tests, each file at most `testBytes`, all of
 * them together at most `problemTestBytes`. A cap broken halfway removes what
 * was written and throws TestsRefused; so does any other failure (a full
 * disk), with its own error. The store moves the problem to the revision only
 * after this returns.
 */
export function writeRevision(contestId: string, problemId: string, revision: number, plan: readonly PlannedTest[]): WrittenTest[] {
  if (plan.length > CONTEST_LIMITS.tests) throw new TestsRefused('tooMany')
  const dir = revisionDir(contestId, problemId, revision)
  if (contestsFs.existsSync(dir)) throw new Error(`Contest storage: revision ${revision} already exists`)
  const written: WrittenTest[] = []
  try {
    makeDir(path.join(contestDir(contestId), 'problems'), OPEN_DIR)
    makeDir(problemDir(contestId, problemId), OPEN_DIR)
    makeDir(dir, OPEN_DIR)
    makeDir(inputsDir(contestId, problemId, revision), OPEN_DIR)
    makeDir(answersDir(contestId, problemId, revision), SECRET_DIR)
    let total = 0
    for (const test of plan) {
      const inputBytes = placeFile(test.input, testFile(contestId, problemId, revision, test.ordinal, 'in'), 'in', OPEN_FILE)
      if (inputBytes > CONTEST_LIMITS.testBytes) throw new TestsRefused('fileTooBig', test.ordinal)
      total += inputBytes
      let answerBytes: number | null = null
      if (test.answer) {
        answerBytes = placeFile(test.answer, testFile(contestId, problemId, revision, test.ordinal, 'ans'), 'ans', SECRET_FILE)
        if (answerBytes > CONTEST_LIMITS.testBytes) throw new TestsRefused('fileTooBig', test.ordinal)
        total += answerBytes
      }
      if (total > CONTEST_LIMITS.problemTestBytes) throw new TestsRefused('totalTooBig', test.ordinal)
      written.push({ ordinal: test.ordinal, inputBytes, answerBytes })
    }
  } catch (error) {
    removeQuietly(dir)
    throw error
  }
  return written
}

/** Remove a revision that never became current (a refused switch): nobody can have mounted it. */
export function dropRevision(contestId: string, problemId: string, revision: number): void {
  removeQuietly(revisionDir(contestId, problemId, revision))
}

/**
 * Remove every revision of a problem but those in `keep` (the current one and
 * the ones queued or running judgings name). Returns how many went. A
 * directory that refuses to go is said out loud and left for the next call.
 */
export function pruneRevisions(contestId: string, problemId: string, keep: ReadonlySet<number>): number {
  let removed = 0
  for (const revision of revisionsOnDisk(contestId, problemId)) {
    if (keep.has(revision)) continue
    if (remove(revisionDir(contestId, problemId, revision))) removed++
    else console.warn(`[contests] an old tests revision would not go: ${contestId}/${problemId}/r${revision}`)
  }
  return removed
}

/* ------------------------------------------------------------- reading */

/** A test's input or answer, whole: for the judge's request and the teacher's download. */
export function readTestFile(contestId: string, problemId: string, revision: number, ordinal: number, part: TestPart): Buffer {
  return contestsFs.readFileSync(testFile(contestId, problemId, revision, ordinal, part)) as Buffer
}

const readFd = promisify(fs.readFile) as (fd: number) => Promise<Buffer>

/**
 * The same, without holding the event loop: the answers of a problem may weigh
 * hundreds of megabytes, and the pump reads them for every judging. Opened
 * through the anchored file system (no symlink on the way), read by the
 * descriptor.
 */
export async function readTestFileAsync(contestId: string, problemId: string, revision: number, ordinal: number, part: TestPart): Promise<Buffer> {
  const fd = contestsFs.openSync(testFile(contestId, problemId, revision, ordinal, part), 'r')
  try {
    return await readFd(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** A held file for a download (secure-files.ts · HeldFile): the inode opened, not the path. */
export function holdTestFile(contestId: string, problemId: string, revision: number, ordinal: number, part: TestPart): HeldFile {
  return contestsFs.openRead(testFile(contestId, problemId, revision, ordinal, part))
}

/**
 * The first `cap` bytes as text, never a character cut in half: a cut that
 * fell inside a multi-byte letter steps back to before it, so a Cyrillic
 * answer does not end in a replacement mark the participant would copy.
 */
export function utf8Snippet(bytes: Buffer, cap = SNIPPET_BYTES): { text: string; truncated: boolean } {
  if (bytes.length <= cap) return { text: bytes.toString('utf8'), truncated: false }
  let end = cap
  let back = 0
  while (end > 0 && back < 3 && (bytes[end] & 0xc0) === 0x80) {
    end--
    back++
  }
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

/**
 * A snippet of a test's file, reading no more than the cap from the disk; null
 * — the file is not there (an answer not written yet, a revision pruned).
 */
export function testSnippet(
  contestId: string,
  problemId: string,
  revision: number,
  ordinal: number,
  part: TestPart,
  cap = SNIPPET_BYTES,
): { text: string; truncated: boolean } | null {
  let fd: number
  try {
    fd = contestsFs.openSync(testFile(contestId, problemId, revision, ordinal, part), 'r')
  } catch {
    return null
  }
  try {
    const size = fs.fstatSync(fd).size
    // One byte past the cap, so a cut letter can be stepped back from.
    const want = Math.min(size, cap + 3)
    const buffer = Buffer.alloc(want)
    let got = 0
    while (got < want) {
      const n = fs.readSync(fd, buffer, got, want - got, got)
      if (n === 0) break
      got += n
    }
    const snippet = utf8Snippet(buffer.subarray(0, got), cap)
    return { text: snippet.text, truncated: snippet.truncated || size > got }
  } finally {
    fs.closeSync(fd)
  }
}

/* --------------------------------------------------------------- runs */

/**
 * The parent of the runs' directories, made on demand (0755: the judge lays
 * the job out beneath it, and the container reads it as the world). The
 * run's own directory is the judge's to create, fresh — it must not exist
 * yet, and a leftover of a crash under the same name cannot be there, since
 * the attempt number in the name never repeats.
 */
export function prepareRunsDir(contestId: string): string {
  makeDir(contestDir(contestId), OPEN_DIR)
  const dir = runsDir(contestId)
  makeDir(dir, OPEN_DIR)
  return dir
}

/** After the run: its directory goes, whatever the judge left in it. */
export function removeJobDir(contestId: string, submissionId: string, attempt: number): void {
  removeQuietly(jobDir(contestId, submissionId, attempt))
}

/* ------------------------------------------------------------- removal */

function remove(absolute: string): boolean {
  try {
    if (!contestsFs.existsSync(absolute)) return true
    contestsFs.rmSync(absolute, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function removeQuietly(absolute: string): void {
  remove(absolute)
}

/**
 * A deleted problem's files, every revision. Out loud when it fails: answers
 * left on disk for a problem that no longer exists are answers nobody will
 * ever think of again.
 */
export function removeProblemFiles(contestId: string, problemId: string): boolean {
  const done = remove(problemDir(contestId, problemId))
  if (!done) console.warn(`[contests] a deleted problem's files would not go: ${contestId}/${problemId}`)
  return done
}

/** A deleted contest's whole directory, out loud on failure for the same reason. */
export function removeContestFiles(contestId: string): boolean {
  const done = remove(contestDir(contestId))
  if (!done) console.warn(`[contests] a deleted contest's files would not go: ${contestId}`)
  return done
}

/** Contests with a directory on disk — for a sweep of what a deleted contest left. */
export function contestDirsOnDisk(): string[] {
  try {
    return (contestsFs.readdirSync(contestsDir) as unknown as string[]).filter((name) => ID_OK.test(name))
  } catch {
    return []
  }
}
