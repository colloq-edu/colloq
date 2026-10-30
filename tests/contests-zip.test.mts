/**
 * The contests' ZIP reader (server/src/contests/zip-reader.ts) and the
 * mapping of an archive's names to tests (tests-import.ts).
 *
 * The reader is pointed at a stranger's file: a teacher's archive, made by
 * any tool on any system, or by someone who wants the server's memory. What
 * breaks here breaks quietly — a test silently missing, half of an answer, a
 * process gone under a «42 KB» archive that inflates to four gigabytes — so
 * every refusal the reader can give is driven by an archive that earns it.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { openZip, ZipRefused, type ZipLimits } from '../server/src/contests/zip-reader.js'
import {
  classifyTestName,
  commonFolder,
  parseProblemMeta,
  planTests,
  ProblemArchiveRefused,
  readProblemArchive,
} from '../server/src/contests/tests-import.js'
import { makeZip } from './_contests.mts'

const LIMITS: ZipLimits = { maxEntries: 50, maxFileBytes: 10_000, maxTotalBytes: 40_000 }

function refusal(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof ZipRefused) return error.why
    throw error
  }
  return 'none'
}

/* ------------------------------------------------------------- reading */

test('stored and deflated entries read back byte for byte, with their names', () => {
  const zip = makeZip([
    { name: 'tests/01', data: '1 2\n', method: 0 },
    { name: 'tests/01.a', data: '3\n' },
    { name: 'данные/ответ.txt', data: 'привет\n' },
  ])
  const archive = openZip(zip, LIMITS)
  assert.deepEqual(archive.entries.map((entry) => entry.name), ['tests/01', 'tests/01.a', 'данные/ответ.txt'])
  assert.equal(archive.read(archive.entries[0]).toString(), '1 2\n')
  assert.equal(archive.read(archive.entries[1]).toString(), '3\n')
  assert.equal(archive.read(archive.entries[2]).toString(), 'привет\n')
})

test('a zip64 archive is read through its zip64 records', () => {
  const zip = makeZip([
    { name: '1.in', data: 'abc' },
    { name: '1.out', data: 'def', method: 0 },
  ], { zip64: true })
  const archive = openZip(zip, LIMITS)
  assert.deepEqual(archive.entries.map((entry) => [entry.name, entry.size]), [['1.in', 3], ['1.out', 3]])
  assert.equal(archive.read(archive.entries[0]).toString(), 'abc')
  assert.equal(archive.read(archive.entries[1]).toString(), 'def')
})

test('directories, __MACOSX and dotfiles are not entries at all; a symlink is named, never read', () => {
  const zip = makeZip([
    { name: 'tests/', data: '' },
    { name: 'tests/01', data: 'x' },
    { name: '__MACOSX/tests/._01', data: 'resource fork' },
    { name: 'tests/.DS_Store', data: 'finder' },
    { name: '.hidden/02', data: 'y' },
    { name: 'tests/02', data: '/etc/passwd', unixMode: 0o120777 },
  ])
  const archive = openZip(zip, LIMITS)
  assert.deepEqual(archive.entries.map((entry) => entry.name), ['tests/01'])
  assert.deepEqual(archive.ignored, ['tests/02'])
})

test('a name is only a name: traversal and absolute paths are listed, never followed', () => {
  // The reader writes nothing anywhere; the names go to the matcher, and a «..» segment is a dotfile.
  const zip = makeZip([
    { name: '../../colloq.db', data: 'x' },
    { name: '/etc/cron.d/evil', data: 'y' },
    { name: 'tests/01', data: 'z' },
  ])
  const archive = openZip(zip, LIMITS)
  assert.deepEqual(archive.entries.map((entry) => entry.name), ['/etc/cron.d/evil', 'tests/01'])
  const plan = planTests(archive.entries)
  assert.equal(plan.tests.length, 1)
  assert.deepEqual(plan.skipped, ['/etc/cron.d/evil'])
})

/* ------------------------------------------------------------- refusals */

test('what is not a zip, or a cut one, is malformed', () => {
  assert.equal(refusal(() => openZip(Buffer.from('not a zip at all, just text'), LIMITS)), 'malformed')
  assert.equal(refusal(() => openZip(Buffer.alloc(10), LIMITS)), 'malformed')
  const whole = makeZip([{ name: 'tests/01', data: 'hello' }])
  // Cut before the end record: no record, nothing to read.
  assert.equal(refusal(() => openZip(whole.subarray(0, whole.length - 5), LIMITS)), 'malformed')
  // A directory that points past the file.
  const lying = Buffer.from(whole)
  lying.writeUInt32LE(lying.length + 100, lying.length - 6)
  assert.equal(refusal(() => openZip(lying, LIMITS)), 'malformed')
})

test('encrypted entries and unknown methods are refused by name', () => {
  assert.equal(refusal(() => openZip(makeZip([{ name: 'tests/01', data: 'x', flags: 0x1 }]), LIMITS)), 'encrypted')
  assert.equal(refusal(() => openZip(makeZip([{ name: 'tests/01', data: 'x', method: 99 }]), LIMITS)), 'encrypted')
  const deflate64 = makeZip([{ name: 'tests/01', data: 'x', method: 9 }])
  try {
    openZip(deflate64, LIMITS)
    assert.fail('deflate64 was taken')
  } catch (error) {
    assert.ok(error instanceof ZipRefused)
    assert.equal(error.why, 'method')
    assert.equal(error.entry, 'tests/01')
  }
})

test('the caps hold on what the directory claims: entries, a file, the sum', () => {
  const many = makeZip(Array.from({ length: 60 }, (_, index) => ({ name: `tests/${index}`, data: 'x' })))
  assert.equal(refusal(() => openZip(many, LIMITS)), 'tooManyEntries')
  assert.equal(refusal(() => openZip(makeZip([{ name: 'tests/01', data: Buffer.alloc(20_000) }]), LIMITS)), 'fileTooBig')
  const sum = makeZip(Array.from({ length: 5 }, (_, index) => ({ name: `tests/0${index}`, data: Buffer.alloc(9_000) })))
  assert.equal(refusal(() => openZip(sum, LIMITS)), 'totalTooBig')
})

test('a zip bomb that lies about its size stops at the claim, without the memory for the rest', () => {
  // Ten megabytes of zeros deflate to a few kilobytes; the directory says 100 bytes.
  const bomb = makeZip([{ name: 'tests/01', data: Buffer.alloc(10 * 1024 * 1024), declaredSize: 100 }])
  assert.ok(bomb.length < 64 * 1024, `the bomb is small: ${bomb.length}`)
  const archive = openZip(bomb, LIMITS)
  assert.equal(archive.entries[0].size, 100)
  assert.equal(refusal(() => archive.read(archive.entries[0])), 'malformed')
  // And a stream that yields less than it claims is not a test either.
  const short = makeZip([{ name: 'tests/01', data: 'abc', declaredSize: 50 }])
  const shortArchive = openZip(short, LIMITS)
  assert.equal(refusal(() => shortArchive.read(shortArchive.entries[0])), 'malformed')
})

test('two entries sharing their bytes are refused: the overlapping kind of bomb', () => {
  const zip = makeZip([{ name: 'tests/01', data: 'abc' }, { name: 'tests/02', data: 'def' }])
  // Point the second central record at the first local header.
  const second = zip.indexOf(Buffer.from('tests/02'), zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])))
  const record = second - 46
  zip.writeUInt32LE(0, record + 42)
  assert.equal(refusal(() => openZip(zip, LIMITS)), 'malformed')
})

test('a damaged entry is a checksum refusal, not a test', () => {
  const zip = makeZip([{ name: 'tests/01', data: 'hello world', method: 0, crc: 0x12345678 }])
  const archive = openZip(zip, LIMITS)
  assert.equal(refusal(() => archive.read(archive.entries[0])), 'checksum')
})

test('a deflate stream that is garbage reads as malformed', () => {
  const good = makeZip([{ name: 'tests/01', data: 'hello hello hello hello' }])
  const data = good.indexOf(zlib.deflateRawSync(Buffer.from('hello hello hello hello')))
  const broken = Buffer.from(good)
  broken.fill(0xff, data, data + 4)
  const archive = openZip(broken, LIMITS)
  assert.equal(refusal(() => archive.read(archive.entries[0])), 'malformed')
})

/* -------------------------------------------------------- names to tests */

test('every layout teachers bring maps to tests, in numeric order', () => {
  const names = (entries: string[]): string[] => entries
  const as = (list: string[]) => list.map((name) => ({ name, size: 1, compressedSize: 1, method: 8 as const, crc32: 0, localOffset: 0 }))
  // Polygon / Yandex: tests/01 + tests/01.a, and 10 after 2.
  let plan = planTests(as(names(['tests/10', 'tests/10.a', 'tests/02', 'tests/02.a', 'tests/1', 'tests/1.a'])))
  assert.deepEqual(plan.tests.map((t) => [t.number, t.input.name, t.answer?.name]), [
    [1, 'tests/1', 'tests/1.a'],
    [2, 'tests/02', 'tests/02.a'],
    [10, 'tests/10', 'tests/10.a'],
  ])
  // The classic pair, with every answer extension.
  plan = planTests(as(['1.in', '1.out', '2.in', '2.ans', '3.in', '3.a', '4.IN', '4.OUT']))
  assert.deepEqual(plan.tests.map((t) => [t.number, t.answer?.name]), [[1, '1.out'], [2, '2.ans'], [3, '3.a'], [4, '4.OUT']])
  // The folder pair.
  plan = planTests(as(['input/input1.txt', 'output/output1.txt', 'input/input2.txt', 'output/output2.txt']))
  assert.deepEqual(plan.tests.map((t) => [t.input.name, t.answer?.name]), [
    ['input/input1.txt', 'output/output1.txt'],
    ['input/input2.txt', 'output/output2.txt'],
  ])
  // Leading zeros.
  plan = planTests(as(['01.in', '01.out', '002.in', '002.out']))
  assert.deepEqual(plan.tests.map((t) => t.number), [1, 2])
})

test('an input without an answer is a test; an answer without an input, and the rest, are named as skipped', () => {
  const as = (list: string[]) => list.map((name) => ({ name, size: 1, compressedSize: 1, method: 8 as const, crc32: 0, localOffset: 0 }))
  const plan = planTests(as(['1.in', '1.out', '2.in', '3.out', 'statement.pdf', 'checker.cpp', 'tests/01', 'problem.xml']))
  assert.deepEqual(plan.tests.map((t) => [t.number, t.answer?.name ?? null]), [[1, '1.out'], [2, null]])
  // tests/01 is a second input for test 1: the first stays.
  assert.deepEqual(plan.skipped.sort(), ['3.out', 'checker.cpp', 'problem.xml', 'statement.pdf', 'tests/01'].sort())
})

test('an archive wrapped in one folder is read as if the folder were not there', () => {
  assert.equal(commonFolder(['problem-a/tests/01', 'problem-a/tests/01.a']), 'problem-a/')
  assert.equal(commonFolder(['problem-a/tests/01', 'other/x']), '')
  assert.equal(commonFolder(['01.in']), '')
  assert.deepEqual(classifyTestName('tests/007'), { number: 7, role: 'input' })
  assert.deepEqual(classifyTestName('TESTS/007.A'), { number: 7, role: 'answer' })
  assert.equal(classifyTestName('readme.md'), null)
})

/* ------------------------------------------------------- a whole problem */

test('a whole problem: its json, statement, checker, reference and tests', () => {
  const zip = makeZip([
    { name: 'sum/problem.json', data: JSON.stringify({ title: 'Сумма', timeLimitMs: 2000, memoryMb: 128, checker: 'tokens', points: 'groups', samples: [1] }) },
    { name: 'sum/statement.md', data: '# Сумма двух\n\nСложите $a$ и $b$.' },
    { name: 'sum/checker.py', data: 'def check(i, o, a):\n    return o.split() == a.split()\n' },
    { name: 'sum/solution.py', data: 'print(sum(map(int, input().split())))\n' },
    { name: 'sum/solution.cpp', data: 'int main(){}' },
    { name: 'sum/tests/01', data: '1 2\n' },
    { name: 'sum/tests/01.a', data: '3\n' },
    { name: 'sum/tests/02', data: '5 5\n' },
    { name: 'sum/notes.txt', data: 'for me' },
  ])
  const parsed = readProblemArchive(openZip(zip, LIMITS))
  assert.deepEqual(parsed.meta, { title: 'Сумма', timeLimitMs: 2000, memoryMb: 128, checker: 'tokens', points: 'groups', samples: [1] })
  assert.match(parsed.statement ?? '', /Сложите/)
  assert.match(parsed.checkerCode ?? '', /def check/)
  assert.deepEqual(parsed.reference, { language: 'python3', source: 'print(sum(map(int, input().split())))\n' })
  assert.deepEqual(parsed.tests.tests.map((t) => [t.number, t.answer?.name ?? null]), [[1, 'sum/tests/01.a'], [2, null]])
  // The second reference is not taken twice; the notes are not a test.
  assert.deepEqual(parsed.tests.skipped.sort(), ['sum/notes.txt', 'sum/solution.cpp'].sort())
})

test('problem.json is held to the editor\'s bounds, and says which field it broke', () => {
  const field = (text: string): string => {
    try {
      parseProblemMeta(text)
    } catch (error) {
      if (error instanceof ProblemArchiveRefused) return `${error.field}:${error.why}`
      throw error
    }
    return 'none'
  }
  assert.equal(field('not json'), 'problem.json:json')
  assert.equal(field('[1, 2]'), 'problem.json:json')
  assert.equal(field('{"timeLimitMs": 50}'), 'timeLimitMs:range')
  assert.equal(field('{"timeLimitMs": 1.5}'), 'timeLimitMs:value')
  assert.equal(field('{"memoryMb": 100000}'), 'memoryMb:range')
  assert.equal(field('{"checker": "testlib"}'), 'checker:value')
  assert.equal(field('{"checkerEpsilon": 2}'), 'checkerEpsilon:range')
  assert.equal(field('{"points": "all"}'), 'points:value')
  assert.equal(field(`{"title": "${'x'.repeat(200)}"}`), 'title:tooLong')
  assert.equal(field('{"title": "Ok", "unknown": 1}'), 'none')
})
