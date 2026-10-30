/**
 * The one way a problem's tests change: a whole new revision on disk, then
 * the switch in the database, then the old revisions nobody reads any more
 * go (docs/architecture/contests.md §1).
 *
 * Every door that changes tests — an archive, a test typed in, a mark moved,
 * a test deleted, a problem copied or imported — and the judge writing the
 * reference's answers come through here, so none of them can write into the
 * revision a running judging reads, or switch to a revision that is not
 * whole. Synchronous from the read of the problem to the switch: no other
 * request of this process can change the tests in between, and the switch
 * itself only moves from the revision the change started from
 * (store.ts · switchTests), so a second process could not either.
 */
import type { ContestProblem, ContestTest } from '@shared/contests'
import { listTests, revisionsInUse, switchTests } from './store.js'
import {
  dropRevision,
  nextRevision,
  pruneRevisions,
  writeRevision,
  type TestSource,
} from './storage.js'

/** One test of the revision to be. */
export interface NextTest {
  sample: boolean
  group: number
  input: TestSource
  answer: TestSource | null
  answerFrom: 'upload' | 'reference'
}

/** The tests changed under the caller between its read and its switch: nothing was changed. */
export class TestsMoved extends Error {
  constructor() {
    super('The tests changed meanwhile')
  }
}

/** A test of the problem's current revision, as the source of the same file in the next one (a hard link). */
export function sameFile(problem: ContestProblem, ordinal: number): TestSource {
  return { link: { contestId: problem.contestId, problemId: problem.id, revision: problem.testsRevision, ordinal } }
}

/** Keep every current test exactly as it is — the start of most changes. */
export function keepAll(problem: ContestProblem, tests: readonly ContestTest[] = listTests(problem.id)): NextTest[] {
  return tests.map((test) => ({
    sample: test.sample,
    group: test.group,
    input: sameFile(problem, test.ordinal),
    answer: test.answerBytes === null ? null : sameFile(problem, test.ordinal),
    answerFrom: test.answerFrom,
  }))
}

/**
 * Make `next` the problem's tests, numbered 1..N in the order given. Throws
 * storage's TestsRefused for a cap (nothing written stays), or TestsMoved.
 * Returns the tests as they now are.
 */
export function changeTests(problem: ContestProblem, next: readonly NextTest[]): ContestTest[] {
  const from = problem.testsRevision
  const to = nextRevision(problem.contestId, problem.id, from)
  const written = writeRevision(
    problem.contestId,
    problem.id,
    to,
    next.map((test, index) => ({ ordinal: index + 1, input: test.input, answer: test.answer })),
  )
  const rows = next.map((test, index) => ({
    ordinal: index + 1,
    sample: test.sample,
    group: test.group,
    inputBytes: written[index].inputBytes,
    answerBytes: written[index].answerBytes,
    answerFrom: test.answer === null ? ('upload' as const) : test.answerFrom,
  }))
  if (!switchTests(problem.id, from, to, rows)) {
    dropRevision(problem.contestId, problem.id, to)
    throw new TestsMoved()
  }
  tidyRevisions(problem.contestId, problem.id)
  return listTests(problem.id)
}

/** Remove the revisions of a problem nothing reads any more: neither the current one nor a pinned judging's. */
export function tidyRevisions(contestId: string, problemId: string): void {
  pruneRevisions(contestId, problemId, revisionsInUse(problemId))
}
