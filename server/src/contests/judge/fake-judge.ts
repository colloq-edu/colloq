/**
 * The stand-in judge (backend `test`): the product on a machine without docker.
 *
 * It is not here for the suite's sake alone. The test stand and every unit test
 * run with `KERNEL_BACKEND=test`, and a contest with no judge is a page where
 * no button can be pressed — the queue stands still, the board is empty, the
 * choice of whose submission goes next can be checked against nothing. Real
 * docker cannot run in the suite (minutes per case, containers left on the
 * developer's machine), so the stand-in must give the SAME SHAPE of answer,
 * including verdicts only real docker produces.
 *
 * WHAT IT NEVER DOES: it does not compile or run a single line of the source.
 * It reads magic comments and nothing else — so "a judge without a sandbox"
 * cannot become a hole exactly where it is least expected, on the developer's
 * machine and in CI. A source with no comment of ours is `OK` on every test,
 * the conscientious submission.
 *
 * THE SHAPE IS GUARANTEED, not merely intended: the stand-in synthesises the
 * very JSON lines the real harness would write and feeds them through the same
 * OutcomeAssembler the docker judge uses (docker-judge.ts). The verdict, the
 * skipped tests, the counts and the `answers` map are therefore computed by one
 * body of code for both backends — the swap proves what it is meant to.
 *
 * The magic comments, in a `#` or `//` line:
 *   judge: OK            every test passes (the default; may be omitted)
 *   judge: WA 3          test 3 is wrong (likewise TL, ML, RE, OL + ordinal)
 *   judge: CE            a compilation error: nothing runs
 *   judge: SE            the judge itself fails
 *   judge: slow 300      wait 300 ms before each test, to watch progress stream
 * Several may appear; `WA 3` and `TL 5` in one source fail both named tests.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  registerContestJudge,
  type ContestJudge,
  type JudgeOutcome,
  type JudgeRequest,
  type LanguageProbe,
} from './port.js'
import { OutcomeAssembler, type HarnessLine } from './docker-judge.js'
import type { Verdict } from '@shared/contests'

/** `# judge: WA 3` / `// judge: slow 300` — the only thing the stand-in reads from a source. */
const DIRECTIVE = /(?:#|\/\/)[ \t]*judge:[ \t]*([^\n\r]*)/g

/** Per-test verdicts a magic comment can ask for (not CE/SE, which are the whole submission's). */
const PER_TEST = new Set<Verdict>(['OK', 'WA', 'TL', 'ML', 'RE', 'OL'])

interface Directives {
  /** ordinal → the verdict that test should get; absent means OK. */
  fails: Map<number, Verdict>
  ce: boolean
  se: boolean
  slowMs: number
}

/** Read every `judge:` comment from the source. Garbage is ignored, as a real unknown comment would be. */
export function parseDirectives(source: string): Directives {
  const result: Directives = { fails: new Map(), ce: false, se: false, slowMs: 0 }
  for (const match of source.matchAll(DIRECTIVE)) {
    const tokens = match[1].trim().split(/\s+/)
    const head = (tokens[0] ?? '').toUpperCase()
    if (head === 'CE') result.ce = true
    else if (head === 'SE') result.se = true
    else if (head === 'OK') continue
    else if (head === 'SLOW') {
      const ms = Number(tokens[1])
      if (Number.isFinite(ms) && ms >= 0) result.slowMs = Math.min(ms, 5000)
    } else if (PER_TEST.has(head as Verdict)) {
      const ordinal = Number(tokens[1] ?? 1)
      if (Number.isInteger(ordinal) && ordinal >= 1) result.fails.set(ordinal, head as Verdict)
    }
  }
  return result
}

/** A stable, meaningless pair of numbers for a test, so two runs of one source agree. */
function timing(ordinal: number): { ms: number; kb: number } {
  return { ms: 1 + (ordinal % 7), kb: 1024 + ordinal * 4 }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class FakeContestJudge implements ContestJudge {
  readonly backend = 'test' as const

  async judge(request: JudgeRequest): Promise<JudgeOutcome> {
    const started = Date.now()
    const directives = parseDirectives(request.source)
    const assembler = new OutcomeAssembler(request)
    assembler.line({ t: 'compile' })

    if (directives.ce) {
      assembler.line({ t: 'compiled', ok: false, log: 'fake judge: compilation error (judge: CE)\n' })
      assembler.line({ t: 'done' })
      return assembler.build(ended(Date.now() - started))
    }
    assembler.line({ t: 'compiled', ok: true, log: '' })
    if (directives.se) {
      assembler.line({ t: 'done', se: 'fake judge: judge error (judge: SE)' })
      return assembler.build(ended(Date.now() - started))
    }

    const failedGroups = new Set<number>()
    for (const test of request.tests) {
      // ICPC stops dead at the first failure; an IOI group skips the rest of
      // itself once one of its tests failed. The harness is silent on a skipped
      // test and the assembler fills it, so the stand-in is silent too.
      if (request.mode === 'ioi' && failedGroups.has(test.group)) continue
      if (directives.slowMs) await sleep(directives.slowMs)
      assembler.line({ t: 'start', n: test.ordinal })
      const verdict = directives.fails.get(test.ordinal) ?? 'OK'
      const { ms, kb } = timing(test.ordinal)
      if (request.mode === 'answers' && verdict === 'OK') {
        assembler.line({ t: 'answer', n: test.ordinal, b64: this.inputB64(request.testsDir, test.ordinal) })
        assembler.line({ t: 'test', n: test.ordinal, v: 'OK', ms, kb, bytes: 0 })
      } else {
        const line: HarnessLine = { t: 'test', n: test.ordinal, v: verdict, ms, kb }
        if (verdict === 'RE') line.exit = 'exit 1'
        if (verdict === 'WA') line.note = `${test.ordinal}: fake`
        assembler.line(line)
      }
      if (verdict !== 'OK') {
        if (request.mode === 'icpc') break
        failedGroups.add(test.group)
      }
    }
    assembler.line({ t: 'done' })
    return assembler.build(ended(Date.now() - started))
  }

  /** The answer the reference "writes" in mode `answers`: the test's own input, read as bytes. */
  private inputB64(testsDir: string, ordinal: number): string {
    try {
      return fs.readFileSync(path.join(testsDir, `${ordinal}.in`)).toString('base64')
    } catch {
      return ''
    }
  }

  /** The image can always run everything, at the versions the base kernel ships. */
  async probe(_image: string): Promise<LanguageProbe> {
    return { python: '3.11.0', gpp: '12.2.0', gcc: '12.2.0' }
  }

  /** Nothing of the stand-in is ever left on a daemon: it starts none. */
  async sweep(): Promise<number> {
    return 0
  }
}

function ended(wallMs: number): { oomKilled: boolean; killedReason: string | null; wallMs: number; stderrTail: string } {
  return { oomKilled: false, killedReason: null, wallMs, stderrTail: '' }
}

registerContestJudge('test', () => new FakeContestJudge())
