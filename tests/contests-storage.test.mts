/**
 * Where a contest's tests live on disk (server/src/contests/storage.ts) and
 * the one way they change (revisions.ts).
 *
 * Each rule here was paid for elsewhere first. A container that cannot read
 * its inputs (the judge's root has no DAC capabilities, so only the world's
 * bits count) fails every test of every submission with a verdict nobody
 * can explain. A revision rewritten in place under a running judging gives
 * it half of the old tests and half of the new. A directory made again under
 * an old name is the one thing colima serves stale for a minute. And answers
 * a backup does not carry are a contest that restores without its tests.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTEST_LIMITS, SNIPPET_BYTES } from '../shared/contests.js'
import {
  contestsDir,
  dropRevision,
  inputsDir,
  nextRevision,
  pruneRevisions,
  readTestFile,
  revisionDir,
  revisionExists,
  revisionsOnDisk,
  testFile,
  testSnippet,
  TestsRefused,
  utf8Snippet,
  writeRevision,
} from '../server/src/contests/storage.js'
import { addProblem, createContest, getProblem, listTests, startJudging, submitSolution } from '../server/src/contests/store.js'
import { changeTests, keepAll, sameFile, TestsMoved } from '../server/src/contests/revisions.js'
import { createEntrant } from '../server/src/competitions/store.js'

let made = 0
function problemFixture() {
  made++
  const contest = createContest({ slug: `storage-${made}`, title: 'Storage' })!
  const problem = addProblem(contest.id, { title: 'A' })
  assert.ok(problem !== 'full')
  return { contest, problem }
}

const mode = (file: string): number => fs.statSync(file).mode & 0o7777

test('a revision is written whole: inputs the world can read, answers only the host', () => {
  const { contest, problem } = problemFixture()
  const written = writeRevision(contest.id, problem.id, 1, [
    { ordinal: 1, input: { bytes: Buffer.from('1 2\n') }, answer: { bytes: Buffer.from('3\n') } },
    { ordinal: 2, input: { bytes: () => Buffer.from('4 5\n') }, answer: null },
  ])
  assert.deepEqual(written, [
    { ordinal: 1, inputBytes: 4, answerBytes: 2 },
    { ordinal: 2, inputBytes: 4, answerBytes: null },
  ])
  assert.equal(readTestFile(contest.id, problem.id, 1, 1, 'in').toString(), '1 2\n')
  assert.equal(readTestFile(contest.id, problem.id, 1, 1, 'ans').toString(), '3\n')
  // The judge's root reads with the world's bits only (--cap-drop ALL).
  assert.equal(mode(inputsDir(contest.id, problem.id, 1)), 0o755)
  assert.equal(mode(revisionDir(contest.id, problem.id, 1)), 0o755)
  assert.equal(mode(testFile(contest.id, problem.id, 1, 1, 'in')), 0o644)
  // The answers are never mounted: the host's alone.
  assert.equal(mode(path.dirname(testFile(contest.id, problem.id, 1, 1, 'ans'))), 0o700)
  assert.equal(mode(testFile(contest.id, problem.id, 1, 1, 'ans')), 0o600)
  assert.equal(fs.existsSync(testFile(contest.id, problem.id, 1, 2, 'ans')), false)
  // Everything lives under DATA_DIR/contests, nowhere near the class's workspace.
  assert.ok(revisionDir(contest.id, problem.id, 1).startsWith(contestsDir + path.sep))
  assert.ok(!contestsDir.startsWith(process.env.WORKSPACE_DIR!))
})

test('a cap broken halfway leaves nothing behind, and says which cap', () => {
  const { contest, problem } = problemFixture()
  const tooMany = Array.from({ length: CONTEST_LIMITS.tests + 1 }, (_, index) => ({
    ordinal: index + 1,
    input: { bytes: Buffer.from('x') },
    answer: null,
  }))
  assert.throws(() => writeRevision(contest.id, problem.id, 1, tooMany), (error: unknown) => error instanceof TestsRefused && error.why === 'tooMany')
  assert.equal(revisionExists(contest.id, problem.id, 1), false)

  // A lazy source that turns out too big: the files before it go too.
  const big = { bytes: () => Buffer.alloc(CONTEST_LIMITS.testBytes + 1) }
  assert.throws(
    () => writeRevision(contest.id, problem.id, 2, [
      { ordinal: 1, input: { bytes: Buffer.from('ok') }, answer: null },
      { ordinal: 2, input: big, answer: null },
    ]),
    (error: unknown) => error instanceof TestsRefused && error.why === 'fileTooBig' && error.ordinal === 2,
  )
  assert.equal(fs.existsSync(revisionDir(contest.id, problem.id, 2)), false)

  // Any other failure (here a source that throws) removes the half-written revision as well.
  assert.throws(() => writeRevision(contest.id, problem.id, 3, [
    { ordinal: 1, input: { bytes: Buffer.from('ok') }, answer: null },
    { ordinal: 2, input: { bytes: () => { throw new Error('the archive broke') } }, answer: null },
  ]), /the archive broke/)
  assert.equal(fs.existsSync(revisionDir(contest.id, problem.id, 3)), false)
})

test('a change writes a new revision, links what did not change, and only then switches', () => {
  const { problem } = problemFixture()
  changeTests(problem, [
    { sample: true, group: 0, input: { bytes: Buffer.from('1 2\n') }, answer: { bytes: Buffer.from('3\n') }, answerFrom: 'upload' },
    { sample: false, group: 1, input: { bytes: Buffer.from('10 20\n') }, answer: { bytes: Buffer.from('30\n') }, answerFrom: 'upload' },
  ])
  const first = getProblem(problem.id)!
  assert.equal(first.testsRevision, 1)
  assert.deepEqual(listTests(problem.id).map((t) => [t.ordinal, t.sample, t.group, t.inputBytes, t.answerBytes]), [
    [1, true, 0, 4, 2],
    [2, false, 1, 6, 3],
  ])
  // Delete test 1: test 2 becomes test 1 of revision 2, as a hard link of the old file.
  const before = fs.statSync(testFile(problem.contestId, problem.id, 1, 2, 'in'))
  const next = keepAll(first)
  next.splice(0, 1)
  changeTests(first, next)
  const second = getProblem(problem.id)!
  assert.equal(second.testsRevision, 2)
  const after = fs.statSync(testFile(problem.contestId, problem.id, 2, 1, 'in'))
  assert.equal(after.ino, before.ino, 'the moved test is the same inode under its new number')
  assert.equal(readTestFile(problem.contestId, problem.id, 2, 1, 'in').toString(), '10 20\n')
  assert.deepEqual(listTests(problem.id).map((t) => [t.ordinal, t.group]), [[1, 1]])
  // Revision 1 is gone: nothing pins it.
  assert.equal(revisionExists(problem.contestId, problem.id, 1), false)
})

test('unchanged files are hard links: a new revision costs no disk', () => {
  const { problem } = problemFixture()
  changeTests(problem, [{ sample: false, group: 0, input: { bytes: Buffer.alloc(1000, 65) }, answer: { bytes: Buffer.from('A') }, answerFrom: 'upload' }])
  const one = getProblem(problem.id)!
  // A metadata change still makes a new revision (every change does), linking the bytes.
  const next = keepAll(one)
  next[0].sample = true
  // Pin revision 1 with a running judging, so it stays to be compared.
  const entrant = createEntrant('@linker_one').entrant
  const sent = submitSolution({ contestId: one.contestId, problemId: one.id, entrantId: entrant.id, language: 'python3', source: 'ok', late: false, attemptsPerProblem: 0 })
  assert.ok('submission' in sent)
  assert.ok(startJudging(sent.submission.id))
  changeTests(one, next)
  const old = fs.statSync(testFile(one.contestId, one.id, 1, 1, 'in'))
  const fresh = fs.statSync(testFile(one.contestId, one.id, 2, 1, 'in'))
  assert.equal(old.ino, fresh.ino, 'the input was linked, not copied')
  assert.equal(fresh.nlink, 2)
  assert.equal(listTests(one.id)[0].sample, true)
  // The running judging's revision is kept until it ends.
  assert.equal(revisionExists(one.contestId, one.id, 1), true)
})

test('a crash between the write and the switch: the stale directory is skipped, never made again', () => {
  const { contest, problem } = problemFixture()
  // A revision 1 written but never switched to, as a crash would leave it.
  writeRevision(contest.id, problem.id, 1, [{ ordinal: 1, input: { bytes: Buffer.from('stale') }, answer: null }])
  assert.deepEqual(revisionsOnDisk(contest.id, problem.id), [1])
  assert.equal(nextRevision(contest.id, problem.id, 0), 2)
  changeTests(problem, [{ sample: false, group: 0, input: { bytes: Buffer.from('fresh') }, answer: null, answerFrom: 'upload' }])
  const now = getProblem(problem.id)!
  assert.equal(now.testsRevision, 2)
  assert.equal(readTestFile(contest.id, problem.id, 2, 1, 'in').toString(), 'fresh')
  // The garbage goes with the next pruning: nothing pins it.
  assert.equal(revisionExists(contest.id, problem.id, 1), false)
})

test('a switch from a revision someone else moved past refuses, and its directory goes', () => {
  const { problem } = problemFixture()
  changeTests(problem, [{ sample: false, group: 0, input: { bytes: Buffer.from('a') }, answer: null, answerFrom: 'upload' }])
  // `problem` is the stale read (revision 0); the tests are at 1 now.
  assert.throws(
    () => changeTests(problem, [{ sample: false, group: 0, input: { bytes: Buffer.from('b') }, answer: null, answerFrom: 'upload' }]),
    (error: unknown) => error instanceof TestsMoved,
  )
  assert.equal(getProblem(problem.id)!.testsRevision, 1)
  assert.deepEqual(revisionsOnDisk(problem.contestId, problem.id), [1])
})

test('pruning keeps exactly what is named', () => {
  const { contest, problem } = problemFixture()
  for (const revision of [1, 2, 3]) {
    writeRevision(contest.id, problem.id, revision, [{ ordinal: 1, input: { bytes: Buffer.from(String(revision)) }, answer: null }])
  }
  assert.equal(pruneRevisions(contest.id, problem.id, new Set([1, 3])), 1)
  assert.deepEqual(revisionsOnDisk(contest.id, problem.id).sort(), [1, 3])
  dropRevision(contest.id, problem.id, 3)
  assert.deepEqual(revisionsOnDisk(contest.id, problem.id), [1])
})

test('a snippet is cut at the cap and never inside a letter', () => {
  assert.deepEqual(utf8Snippet(Buffer.from('short')), { text: 'short', truncated: false })
  // «я» is two bytes: a cut at an odd byte steps back before it.
  const cyrillic = Buffer.from('я'.repeat(10))
  assert.deepEqual(utf8Snippet(cyrillic, 5), { text: 'яя', truncated: true })
  assert.doesNotMatch(utf8Snippet(Buffer.from('ab€cd'), 4).text, /�/)
  const { contest, problem } = problemFixture()
  writeRevision(contest.id, problem.id, 1, [
    { ordinal: 1, input: { bytes: Buffer.from('ё'.repeat(SNIPPET_BYTES)) }, answer: { bytes: Buffer.from('42\n') } },
  ])
  const big = testSnippet(contest.id, problem.id, 1, 1, 'in')!
  assert.equal(big.truncated, true)
  assert.ok(Buffer.byteLength(big.text) <= SNIPPET_BYTES)
  assert.doesNotMatch(big.text, /�/)
  assert.deepEqual(testSnippet(contest.id, problem.id, 1, 1, 'ans'), { text: '42\n', truncated: false })
  assert.equal(testSnippet(contest.id, problem.id, 9, 1, 'in'), null)
})

test('a link source names a file of another problem too: a copied problem shares the bytes', () => {
  const one = problemFixture()
  changeTests(one.problem, [{ sample: false, group: 0, input: { bytes: Buffer.from('shared') }, answer: { bytes: Buffer.from('S') }, answerFrom: 'upload' }])
  const source = getProblem(one.problem.id)!
  const other = problemFixture()
  changeTests(other.problem, [{ sample: false, group: 0, input: sameFile(source, 1), answer: sameFile(source, 1), answerFrom: 'upload' }])
  const a = fs.statSync(testFile(source.contestId, source.id, source.testsRevision, 1, 'in'))
  const b = fs.statSync(testFile(other.contest.id, other.problem.id, 1, 1, 'in'))
  assert.equal(a.ino, b.ino)
})

test('backups carry the contests\' files, and a restore takes them back', () => {
  const root = path.join(import.meta.dirname, '..', 'scripts')
  const backup = fs.readFileSync(path.join(root, 'backup-local.sh'), 'utf8')
  const list = /for p in ([^;]+); do/.exec(backup)?.[1] ?? ''
  assert.match(list, /\bdata\/contests\b/)
  const restore = fs.readFileSync(path.join(root, 'restore.sh'), 'utf8')
  const allowed = /name ~ \/\^data\\\/\(([^)]+)\)/.exec(restore)?.[1] ?? ''
  assert.ok(allowed.split('|').includes('contests'), allowed)
})
