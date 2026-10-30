/**
 * What an archive the teacher uploads turns into: which of its files are
 * tests, in which order, and — for a whole problem — its statement, limits,
 * checker and reference solution.
 *
 * The layouts teachers actually bring, all of them taken without a setting:
 *
 *   tests/01, tests/01.a          Polygon, Yandex.Contest (the answer is `.a`)
 *   1.in, 1.out | 1.ans | 1.a     the classic pair
 *   01.in, 01.out                 the same with leading zeros
 *   input/input1.txt, output/output1.txt
 *                                 the folder pair some judges export
 *
 * A layout wrapped in one folder (`problem-a/tests/01`) is read as if the
 * folder were not there. Tests go in NUMERIC order of the number in their
 * names — `2` before `10`, whatever the archive's own order — and are given
 * dense ordinals 1..N: gaps in the names are not gaps in the problem. An
 * input without an answer is a test still (the reference will write its
 * answer); an answer without an input is nothing, and it is named among the
 * skipped files, as is everything else the archive held that no layout
 * explains.
 *
 * Nothing here touches the disk or the database: names in, a plan out. The
 * bytes are read from the archive (zip-reader.ts) only when the plan is
 * written (contests/storage.ts · writeRevision).
 */
import {
  CHECKER_KINDS,
  CONTEST_LIMITS,
  SOURCE_BYTES,
  type CheckerKind,
  type ContestLanguage,
  type PointsMode,
} from '@shared/contests'
import type { ZipArchive, ZipEntry } from './zip-reader.js'

export interface ArchiveTest {
  /** The number its name carries (`01` → 1): the sort key, not the ordinal. */
  number: number
  input: ZipEntry
  answer: ZipEntry | null
}

export interface TestsPlan {
  /** In numeric order; the ordinal of each is its index + 1. */
  tests: ArchiveTest[]
  /** Names the archive held that are not tests, as written in it. */
  skipped: string[]
}

type Role = 'input' | 'answer'

/**
 * The patterns, tried in this order on the path (folder-wrapping already
 * taken off), case-insensitively. The first that matches decides; a name no
 * pattern matches is skipped.
 */
const PATTERNS: ReadonlyArray<{ pattern: RegExp; role: Role }> = [
  // Polygon / Yandex: tests/01 and tests/01.a
  { pattern: /(?:^|\/)(\d{1,6})$/, role: 'input' },
  { pattern: /(?:^|\/)(\d{1,6})\.a$/, role: 'answer' },
  // 1.in / 1.out / 1.ans, 01.in / 01.out, test01.in
  { pattern: /(?:^|\/)(?:tests?[-_]?)?(\d{1,6})\.(?:in|inp|input)$/, role: 'input' },
  { pattern: /(?:^|\/)(?:tests?[-_]?)?(\d{1,6})\.(?:out|ans|answer|sol|res|output)$/, role: 'answer' },
  // input/input1.txt + output/output1.txt
  { pattern: /(?:^|\/)input[-_]?(\d{1,6})\.txt$/, role: 'input' },
  { pattern: /(?:^|\/)output[-_]?(\d{1,6})\.txt$/, role: 'answer' },
]

export function classifyTestName(name: string): { number: number; role: Role } | null {
  const lower = name.toLowerCase()
  for (const { pattern, role } of PATTERNS) {
    const match = pattern.exec(lower)
    if (match) return { number: Number.parseInt(match[1], 10), role }
  }
  return null
}

/**
 * The folder every name sits in, when they all sit in one: `problem-a/` of a
 * zip made by «Сжать» on a folder. Nothing when the names disagree, or when a
 * name sits at the top itself.
 */
export function commonFolder(names: readonly string[]): string {
  if (names.length === 0) return ''
  const first = names[0].split('/')
  if (first.length < 2) return ''
  const folder = `${first[0]}/`
  return names.every((name) => name.startsWith(folder) && name.length > folder.length) ? folder : ''
}

/** Turn an archive's files into tests (see the header). `folder` is taken off every name before it is matched. */
export function planTests(entries: readonly ZipEntry[], folder = commonFolder(entries.map((entry) => entry.name))): TestsPlan {
  const inputs = new Map<number, ZipEntry>()
  const answers = new Map<number, ZipEntry>()
  const skipped: string[] = []
  for (const entry of entries) {
    const local = entry.name.startsWith(folder) ? entry.name.slice(folder.length) : entry.name
    const found = classifyTestName(local)
    if (!found) {
      skipped.push(entry.name)
      continue
    }
    const into = found.role === 'input' ? inputs : answers
    // Two inputs for test 3 (`3.in` and `tests/03`): the first stays, the second is named.
    if (into.has(found.number)) skipped.push(entry.name)
    else into.set(found.number, entry)
  }
  for (const [number, entry] of answers) if (!inputs.has(number)) skipped.push(entry.name)
  const tests = [...inputs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, input]) => ({ number, input, answer: answers.get(number) ?? null }))
  return { tests, skipped }
}

/* ------------------------------------------------------- a whole problem */

/** What `problem.json` may say; every field optional, every value checked (readProblemArchive). */
export interface ProblemMeta {
  title?: string
  timeLimitMs?: number
  memoryMb?: number
  checker?: CheckerKind
  checkerEpsilon?: number
  points?: PointsMode
  /** The numbers (as in the test names) of the tests shown under the statement. */
  samples?: number[]
}

export interface ProblemArchive {
  meta: ProblemMeta
  statement: string | null
  /** `checker.py`: the custom checker; the problem's checker becomes `custom` unless problem.json says otherwise. */
  checkerCode: string | null
  reference: { language: ContestLanguage; source: string } | null
  tests: TestsPlan
}

/** A whole-problem archive the import refuses, with the field to name. */
export class ProblemArchiveRefused extends Error {
  constructor(readonly field: string, readonly why: 'json' | 'value' | 'range' | 'tooLong' | 'notText', readonly range?: { min: number; max: number }) {
    super(`Problem archive refused: ${field} ${why}`)
  }
}

const REFERENCE_FILES: ReadonlyArray<readonly [string, ContestLanguage]> = [
  ['solution.py', 'python3'],
  ['solution.cpp', 'cpp20'],
  ['solution.c', 'c17'],
]

/** A text file of the archive: UTF-8, its byte order mark taken off; null — it is not text. */
function textOf(bytes: Buffer): string | null {
  const text = bytes.toString('utf8')
  if (text.includes('�')) return null
  return text.replace(/^﻿/, '')
}

function whole(value: unknown, field: string, range: { min: number; max: number }): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ProblemArchiveRefused(field, 'value')
  if (value < range.min || value > range.max) throw new ProblemArchiveRefused(field, 'range', range)
  return value
}

/** problem.json, every field checked against the same bounds the editor keeps. */
export function parseProblemMeta(text: string): ProblemMeta {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ProblemArchiveRefused('problem.json', 'json')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProblemArchiveRefused('problem.json', 'json')
  const body = raw as Record<string, unknown>
  const meta: ProblemMeta = {}
  if (body.title !== undefined) {
    if (typeof body.title !== 'string') throw new ProblemArchiveRefused('title', 'value')
    const title = body.title.trim()
    if (title.length > CONTEST_LIMITS.problemTitle) throw new ProblemArchiveRefused('title', 'tooLong')
    if (title) meta.title = title
  }
  if (body.timeLimitMs !== undefined) meta.timeLimitMs = whole(body.timeLimitMs, 'timeLimitMs', CONTEST_LIMITS.timeLimitMs)
  if (body.memoryMb !== undefined) meta.memoryMb = whole(body.memoryMb, 'memoryMb', CONTEST_LIMITS.memoryMb)
  if (body.checker !== undefined) {
    if (!CHECKER_KINDS.includes(body.checker as CheckerKind)) throw new ProblemArchiveRefused('checker', 'value')
    meta.checker = body.checker as CheckerKind
  }
  if (body.checkerEpsilon !== undefined) {
    const value = body.checkerEpsilon
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new ProblemArchiveRefused('checkerEpsilon', 'value')
    if (value < CONTEST_LIMITS.epsilon.min || value > CONTEST_LIMITS.epsilon.max) {
      throw new ProblemArchiveRefused('checkerEpsilon', 'range', CONTEST_LIMITS.epsilon)
    }
    meta.checkerEpsilon = value
  }
  if (body.points !== undefined) {
    if (body.points !== 'tests' && body.points !== 'groups') throw new ProblemArchiveRefused('points', 'value')
    meta.points = body.points
  }
  if (body.samples !== undefined) {
    if (!Array.isArray(body.samples) || !body.samples.every((n) => Number.isInteger(n) && (n as number) >= 0)) {
      throw new ProblemArchiveRefused('samples', 'value')
    }
    meta.samples = body.samples as number[]
  }
  return meta
}

/**
 * Read a whole problem out of an archive: `problem.json`, `statement.md`,
 * `checker.py`, `solution.py|cpp|c` at the top (after the folder wrapping,
 * any case), and the tests as planTests reads them. The other files are
 * skipped by name. Throws ProblemArchiveRefused (a field it cannot take) or
 * the reader's ZipRefused (a broken entry).
 */
export function readProblemArchive(archive: ZipArchive): ProblemArchive {
  const folder = commonFolder(archive.entries.map((entry) => entry.name))
  const top = new Map<string, ZipEntry>()
  const rest: ZipEntry[] = []
  for (const entry of archive.entries) {
    const local = (entry.name.startsWith(folder) ? entry.name.slice(folder.length) : entry.name).toLowerCase()
    const known = local === 'problem.json' || local === 'statement.md' || local === 'checker.py' || REFERENCE_FILES.some(([file]) => file === local)
    if (known && !top.has(local)) top.set(local, entry)
    else rest.push(entry)
  }
  const text = (file: string, limit: number, field: string): string | null => {
    const entry = top.get(file)
    if (!entry) return null
    if (entry.size > limit * 4) throw new ProblemArchiveRefused(field, 'tooLong')
    const value = textOf(archive.read(entry))
    if (value === null) throw new ProblemArchiveRefused(field, 'notText')
    if (value.length > limit) throw new ProblemArchiveRefused(field, 'tooLong')
    return value
  }
  const metaText = text('problem.json', 64 * 1024, 'problem.json')
  const meta = metaText === null ? {} : parseProblemMeta(metaText)
  const statement = text('statement.md', CONTEST_LIMITS.statement, 'statement.md')
  const checkerCode = text('checker.py', CONTEST_LIMITS.checkerCode, 'checker.py')
  let reference: ProblemArchive['reference'] = null
  for (const [file, language] of REFERENCE_FILES) {
    const entry = top.get(file)
    if (!entry) continue
    // Several reference files: the first of python, C++, C is taken, the others are named as skipped.
    if (reference) {
      rest.push(entry)
      continue
    }
    if (entry.size > SOURCE_BYTES) throw new ProblemArchiveRefused(file, 'tooLong')
    const source = textOf(archive.read(entry))
    if (source === null) throw new ProblemArchiveRefused(file, 'notText')
    reference = { language, source }
  }
  return { meta, statement, checkerCode, reference, tests: planTests(rest, folder) }
}
