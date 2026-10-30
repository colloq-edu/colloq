/**
 * The common harness of the contests-*.test.mts files: a ZIP writer (the
 * reader's tests need archives no tool would make — lying sizes, zip64,
 * encryption flags), a judge that never runs a line of code and decides by
 * the submission's first line, and a cookie for an entrant. Not a test file
 * itself (the runner only picks up *.test.mts).
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { Response as ExpressResponse } from 'express'
import type {
  ContestJudge,
  JudgeOutcome,
  JudgeRequest,
  JudgeTestResult,
  LanguageProbe,
} from '../server/src/contests/judge/port.js'
import type { TestVerdict, Verdict } from '../shared/contests.js'
import type { Entrant } from '../shared/competitions.js'
import { issueEntrantCookie } from '../server/src/competitions/identity.js'

/* ------------------------------------------------------------------- zips */

export interface ZipFile {
  name: string
  data: Buffer | string
  /** 0 stored, 8 deflate (the default), anything else to test the refusal. */
  method?: number
  flags?: number
  /** Overrides of what the directory claims, to make a lying archive. */
  declaredSize?: number
  crc?: number
  /** The Unix mode in the upper half of the external attributes (a symlink: 0o120777). */
  unixMode?: number
}

function crc32(data: Buffer): number {
  return (zlib as unknown as { crc32(data: Uint8Array): number }).crc32(data) >>> 0
}

/** A ZIP of these files; `zip64` writes the zip64 records and puts every size and offset in them. */
export function makeZip(files: readonly ZipFile[], options: { zip64?: boolean } = {}): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8')
    const method = file.method ?? 8
    const body = method === 8 ? zlib.deflateRawSync(data) : data
    const name = Buffer.from(file.name, 'utf8')
    const size = file.declaredSize ?? data.length
    const crc = file.crc ?? crc32(data)
    const flags = (file.flags ?? 0) | 0x800
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(options.zip64 ? 45 : 20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(options.zip64 ? 0xffffffff : body.length, 18)
    local.writeUInt32LE(options.zip64 ? 0xffffffff : size, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)

    const extra = options.zip64 ? Buffer.alloc(4 + 24) : Buffer.alloc(0)
    if (options.zip64) {
      extra.writeUInt16LE(0x0001, 0)
      extra.writeUInt16LE(24, 2)
      extra.writeBigUInt64LE(BigInt(size), 4)
      extra.writeBigUInt64LE(BigInt(body.length), 12)
      extra.writeBigUInt64LE(BigInt(offset), 20)
    }
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(options.zip64 ? 45 : 20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(options.zip64 ? 0xffffffff : body.length, 20)
    central.writeUInt32LE(options.zip64 ? 0xffffffff : size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(extra.length, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt32LE(((file.unixMode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 42)
    centrals.push(central, name, extra)
    offset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const parts = [...locals, directory]
  const directoryOffset = offset
  if (options.zip64) {
    const record = Buffer.alloc(56)
    record.writeUInt32LE(0x06064b50, 0)
    record.writeBigUInt64LE(BigInt(44), 4)
    record.writeUInt16LE(45, 12)
    record.writeUInt16LE(45, 14)
    record.writeBigUInt64LE(BigInt(files.length), 24)
    record.writeBigUInt64LE(BigInt(files.length), 32)
    record.writeBigUInt64LE(BigInt(directory.length), 40)
    record.writeBigUInt64LE(BigInt(directoryOffset), 48)
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0)
    locator.writeBigUInt64LE(BigInt(directoryOffset + directory.length), 8)
    locator.writeUInt32LE(1, 16)
    parts.push(record, locator)
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(options.zip64 ? 0xffff : files.length, 8)
  end.writeUInt16LE(options.zip64 ? 0xffff : files.length, 10)
  end.writeUInt32LE(options.zip64 ? 0xffffffff : directory.length, 12)
  end.writeUInt32LE(options.zip64 ? 0xffffffff : directoryOffset, 16)
  parts.push(end)
  return Buffer.concat(parts)
}

/* ------------------------------------------------------------------ judge */

export interface StubJudge extends ContestJudge {
  requests: JudgeRequest[]
  probed: string[]
  sweeps: number
  /** What the next probes answer; an Error makes them fail. */
  probeAnswer: LanguageProbe | Error
  /** While set, every judging waits for release() before answering (a run «in a container»). */
  holding: boolean
  release(): void
  /** How many judgings are waiting for release() now. */
  held(): number
}

/**
 * A judge that runs nothing: the first line of the source decides.
 *   `ok`        every test passes
 *   `wa N`      a wrong answer on test N (ICPC stops there; IOI goes on)
 *   `tl N`      the time limit on test N
 *   `ce`        a compilation error
 *   `se`        the judge itself throws
 * Mode `answers` reads each input from testsDir and answers it upper-cased,
 * so the test also proves the inputs are where the request says.
 */
export function stubJudge(): StubJudge {
  const waiting: Array<() => void> = []
  const judge: StubJudge = {
    backend: 'test',
    requests: [],
    probed: [],
    sweeps: 0,
    probeAnswer: { python: '3.11.9', gpp: '12.2.0', gcc: null },
    holding: false,
    release() {
      for (const go of waiting.splice(0)) go()
    },
    held() {
      return waiting.length
    },
    async probe(image) {
      judge.probed.push(image)
      if (judge.probeAnswer instanceof Error) throw judge.probeAnswer
      return judge.probeAnswer
    },
    async sweep() {
      judge.sweeps++
      return 0
    },
    async judge(request) {
      judge.requests.push(request)
      if (judge.holding && !request.signal?.aborted) {
        await new Promise<void>((resolve) => {
          waiting.push(resolve)
          request.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      // As the docker judge does: an abort kills the run and RESOLVES as the judge's failure, never throws.
      if (request.signal?.aborted) {
        const stopped = outcome(request, 'SE', [], null, '')
        stopped.systemDetail = 'judge stopped: aborted'
        return stopped
      }
      const head = request.source.split('\n')[0].trim().toLowerCase()
      if (head === 'se') throw new Error('docker said no')
      const total = request.tests.length
      if (head === 'ce') {
        return outcome(request, 'CE', [], null, 'solution.cpp:1:1: error: expected unqualified-id')
      }
      const [word, at] = head.split(/\s+/)
      const failAt = word === 'wa' || word === 'tl' ? Number(at) : null
      const failVerdict: TestVerdict = word === 'tl' ? 'TL' : 'WA'
      const results: JudgeTestResult[] = []
      const answers = new Map<number, Buffer>()
      let first: number | null = null
      for (const test of request.tests) {
        request.onProgress?.({ phase: 'test', test: test.ordinal, done: results.length, total })
        if (request.mode === 'answers') {
          const input = fs.readFileSync(path.join(request.testsDir, `${test.ordinal}.in`), 'utf8')
          answers.set(test.ordinal, Buffer.from(input.toUpperCase(), 'utf8'))
          results.push({ ordinal: test.ordinal, verdict: 'OK', timeMs: 5, memoryKb: 1000 })
          continue
        }
        const failed = failAt !== null && test.ordinal === failAt
        results.push({
          ordinal: test.ordinal,
          verdict: failed ? failVerdict : 'OK',
          timeMs: 10 + test.ordinal,
          memoryKb: 2000 + test.ordinal,
          output: failed ? 'wrong' : 'right',
          stderr: 'some stderr',
          exit: 'exit 0',
          ...(failed ? { note: 'token 1: expected 5, got 4' } : {}),
        })
        if (failed && first === null) first = test.ordinal
        if (failed && request.mode === 'icpc') break
      }
      request.onProgress?.({ phase: 'test', test: null, done: results.length, total })
      const verdict: Verdict = first === null ? 'OK' : failVerdict
      const done = outcome(request, verdict, results, first, '')
      if (request.mode === 'answers') done.answers = answers
      return done
    },
  }
  return judge
}

function outcome(request: JudgeRequest, verdict: Verdict, tests: JudgeTestResult[], failedTest: number | null, compileLog: string): JudgeOutcome {
  return {
    verdict,
    compileLog,
    tests,
    failedTest,
    passed: tests.filter((test) => test.verdict === 'OK').length,
    total: request.tests.length,
    timeMs: tests.length ? Math.max(...tests.map((test) => test.timeMs ?? 0)) : null,
    memoryKb: tests.length ? Math.max(...tests.map((test) => test.memoryKb ?? 0)) : null,
    systemDetail: null,
    answers: null,
    wallMs: 5,
  }
}

/* -------------------------------------------------------------- entrants */

/** The `colloq_k` cookie of an entrant, as the join door would set it. */
export function entrantCookie(entrant: Entrant): string {
  let cookie = ''
  issueEntrantCookie({ cookie: (name: string, value: string) => (cookie = `${name}=${value}`) } as unknown as ExpressResponse, entrant)
  return cookie
}

/** The cookie a response set, as a request header. */
export function setCookieOf(response: globalThis.Response, name = 'colloq_k'): string {
  const line = response.headers.getSetCookie().find((one) => one.startsWith(`${name}=`))
  return line ? line.split(';')[0] : ''
}

/** Wait for the contests' events of this turn to be delivered (events.ts flushes on setImmediate). */
export function settleEvents(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)))
}
