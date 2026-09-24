/**
 * The teacher panel: four places where it told untruths in words.
 *
 * What is checked is not the markup but the decisions under it, the ones
 * moved into `web/src/admin/panel.ts` precisely so that they can be checked
 * without a browser: what to tell a person the server stopped letting in;
 * which oracle mode a room actually gets; which file will not make it; from
 * which clock a running class is counted.
 *
 * Each of the four has already lied once at a live class, and each lied
 * silently: the screen looked fine.
 */
import { afterEach, test } from 'node:test'
import { setLocaleResolver } from '../shared/i18n.js'
afterEach(() => setLocaleResolver(() => 'ru'))
import assert from 'node:assert/strict'
import {
  KEYLESS_PROVIDERS,
  PROVIDER_PRESETS,
  providerConfigured,
  type AiProviderId,
  type OracleSettings,
} from '../shared/admin.js'
import { OPEN_ROOM, oracleModeIn } from '../shared/rules.js'
import {
  ago,
  oracleCeiling,
  oracleOverCeiling,
  oracleUnder,
  runningLine,
  signedOutNotice,
  splitBySize,
  uploadMb,
} from '../web/src/admin/panel.js'

/* --------------------------------------------------------------- sign-in */

test('a rejected cookie and a cookie that did not stick get different words', () => {
  setLocaleResolver(() => 'en')
  const cookies = signedOutNotice('no-cookie')
  const revoked = signedOutNotice('revoked')
  const removed = signedOutNotice('removed-self')

  assert.notEqual(cookies, revoked)
  assert.notEqual(revoked, removed)

  // Browser settings will not help a revoked link: there is nothing to fix there.
  assert.doesNotMatch(revoked, /cookie/i)
  assert.match(revoked, /link|owner/i)

  // But they will help a cookie that did not stick, and that must be said plainly.
  assert.match(cookies, /cookies/i)

  // One's own action is not called a browser failure.
  assert.doesNotMatch(removed, /cookie/i)
  assert.match(removed, /removed your own account/i)
})

/* ---------------------------------------------------------------- oracle */

const settings = (over: Partial<OracleSettings> = {}): OracleSettings => ({
  provider: 'custom',
  baseUrl: 'https://api.example.test/v1',
  model: 'test-model',
  apiKeyMasked: 'sk-…8fA2',
  defaultMode: 'full',
  houseRules: '',
  questionsPerHour: 30,
  slowModeSeconds: 0,
  contextChars: 20_000,
  keyFromEnvironment: false,
  ...over,
})

test('the instance ceiling: three different ways to give no oracle at all', () => {
  // There is no key either in the panel or in the environment, and the
  // provider is a third-party cloud that will answer nobody without a key. A
  // local runtime is another case, below.
  assert.equal(oracleCeiling(settings({ provider: 'custom', apiKeyMasked: null })).mode, 'off')
  // A key from the environment is a key.
  assert.equal(oracleCeiling(settings({ apiKeyMasked: null, keyFromEnvironment: true })).mode, 'full')
  assert.equal(oracleCeiling(settings({ defaultMode: 'off' })).mode, 'off')
  // Zero questions per hour is the same "off", only in other words
  // (server/src/routes/ai.ts: enabled = aiReady() && mode !== 'off' && limit > 0).
  assert.equal(oracleCeiling(settings({ questionsPerHour: 0 })).mode, 'off')
})

test('a ceiling always has a reason in words, and an unrestricted instance has none', () => {
  assert.equal(oracleCeiling(settings()).why, null)
  for (const capped of [
    settings({ provider: 'custom', apiKeyMasked: null }),
    settings({ provider: 'ollama', baseUrl: '', apiKeyMasked: null }),
    settings({ defaultMode: 'off' }),
    settings({ questionsPerHour: 0 }),
    settings({ defaultMode: 'hints' }),
  ]) {
    const why = oracleCeiling(capped).why
    assert.ok(why && why.length > 0, 'a ceiling without a reason is a silent refusal')
  }
})

test('"Full answers" on an instance in hints mode is not a choice but a promise', () => {
  const hints = oracleCeiling(settings({ defaultMode: 'hints' })).mode
  assert.equal(hints, 'hints')
  assert.equal(oracleOverCeiling('full', hints), true)
  assert.equal(oracleOverCeiling('hints', hints), false)
  // Stricter than the ceiling is always allowed: a room tightens and never loosens.
  assert.equal(oracleOverCeiling('off', hints), false)
  // "As on the instance" is never above the instance: it is the instance.
  assert.equal(oracleOverCeiling('inherit', hints), false)
  assert.equal(oracleOverCeiling('inherit', 'off'), false)
})

test('a local runtime without a key is a configured instance, not a disabled one', () => {
  /*
   * The server lets a question through by `aiReady()` → `providerReady()`
   * (ai/provider.ts): "a key, OR a runtime that has no notion of a key",
   * ollama and vllm with an address. The panel counted here by the key alone
   * and on a configured Ollama turned off both "Full answers" and the
   * stricter "Hints only", declaring the oracle nonexistent while it was
   * answering.
   */
  const ollama = oracleCeiling(
    settings({
      provider: 'ollama',
      baseUrl: 'http://host.docker.internal:11434/v1',
      apiKeyMasked: null,
    }),
  )
  assert.equal(ollama.mode, 'full')
  assert.equal(ollama.why, null, 'a configured instance is not explained by a ceiling that does not exist')
  assert.equal(oracleOverCeiling('full', ollama.mode), false)
  assert.equal(oracleOverCeiling('hints', ollama.mode), false)

  // No address: there is still nobody to ask, but this is not fixed with a
  // key, and the line on screen must name what is missing.
  const homeless = oracleCeiling(settings({ provider: 'ollama', baseUrl: '', apiKeyMasked: null }))
  assert.equal(homeless.mode, 'off')
  assert.match(homeless.why ?? '', /Ollama/)
  assert.doesNotMatch(homeless.why ?? '', /key/i)

  // The list of keyless providers is one for the server and the panel (shared/admin.ts · KEYLESS_PROVIDERS).
  assert.deepEqual([...KEYLESS_PROVIDERS], ['ollama', 'vllm'])
})

test('the panel takes "nobody to answer" from shared, not from its own copy', () => {
  // The factory above has defaultMode 'full' and more than zero questions per
  // hour, so the only reason for a ceiling here is whether the provider is
  // configured.
  for (const provider of Object.keys(PROVIDER_PRESETS) as AiProviderId[]) {
    for (const baseUrl of ['', '/', 'http://localhost:11434/v1']) {
      for (const masked of [null, 'sk-…8fA2']) {
        const ready = providerConfigured({ provider, baseUrl, hasKey: masked !== null })
        assert.equal(
          oracleCeiling(settings({ provider, baseUrl, apiKeyMasked: masked })).mode,
          ready ? 'full' : 'off',
          `${provider} · ${baseUrl || '(no address)'} · ${masked ? 'with key' : 'without key'}`,
        )
      }
    }
  }
})

test('a disabled instance turns off both hints and full', () => {
  assert.equal(oracleOverCeiling('hints', 'off'), true)
  assert.equal(oracleOverCeiling('full', 'off'), true)
  assert.equal(oracleOverCeiling('off', 'off'), false)
})

test('the panel computes with the same rule as the server, not with its own copy', () => {
  const wants = ['inherit', 'off', 'hints', 'full'] as const
  const instances = ['off', 'hints', 'full'] as const
  for (const want of wants) {
    for (const instance of instances) {
      assert.equal(
        oracleUnder(want, instance),
        oracleModeIn({ ...OPEN_ROOM, oracle: want }, instance),
        `${want} under ${instance}`,
      )
    }
  }
})

/* ----------------------------------------------------------------- files */

test('a file over the limit is cut off before the room is created, the rest go through', () => {
  const files = [
    { name: 'train.csv', size: 30 * 1024 * 1024 },
    { name: 'notes.ipynb', size: 12_000 },
    { name: 'video.mp4', size: 400 * 1024 * 1024 },
  ]
  const { taken, refused } = splitBySize(files, 20 * 1024 * 1024)
  assert.deepEqual(
    taken.map((f) => f.name),
    ['notes.ipynb'],
  )
  assert.deepEqual(
    refused.map((f) => f.name),
    ['train.csv', 'video.mp4'],
  )
})

test('the limit is unknown, so take everything: an invented refusal is worse than a server refusal', () => {
  // 0 here means "the server did not say", not "nothing is allowed".
  const files = [{ name: 'huge.bin', size: 900 * 1024 * 1024 }]
  assert.equal(splitBySize(files, 0).refused.length, 0)
  assert.equal(splitBySize(files, 0).taken.length, 1)
})

test('the limit is named in megabytes, the same ones the server uses in its refusal', () => {
  assert.equal(uploadMb(50 * 1024 * 1024), 50)
  assert.equal(uploadMb(200 * 1024 * 1024), 200)
})

/* ---------------------------------------------------------- "running now" */

test('"started" is only about the class clock, not about when the room was created', () => {
  setLocaleResolver(() => 'en')
  const now = Date.UTC(2026, 8, 7, 12, 0)
  const week = now - 6 * 24 * 60 * 60 * 1000
  const room = { liveCount: 3, createdAt: week, liveSince: now - 25 * 60_000 }

  assert.equal(runningLine(room, now), '3 people in the room · started 25 min ago')
  // The room was set up a week ago, and that is not the duration of the class.
  assert.doesNotMatch(runningLine(room, now), /days ago/)
})

test('with no class clock the time is called by its own name, not by another', () => {
  setLocaleResolver(() => 'en')
  const now = Date.UTC(2026, 8, 7, 12, 0)
  const week = now - 6 * 24 * 60 * 60 * 1000
  const line = runningLine({ liveCount: 1, createdAt: week }, now)

  // This was the whole defect: "Running now · started 6 days ago".
  assert.doesNotMatch(line, /started/)
  assert.equal(line, '1 person in the room · created 6 days ago')
})

test('duration ranks: minutes, hours, yesterday, days', () => {
  setLocaleResolver(() => 'en')
  const at = (ms: number) => ago(0, ms)
  assert.equal(at(0), 'just now')
  assert.equal(at(25 * 60_000), '25 min ago')
  assert.equal(at(3 * 3_600_000), '3 h ago')
  assert.equal(at(26 * 3_600_000), 'yesterday')
  assert.equal(at(50 * 3_600_000), '2 days ago')
  // A lagging browser clock gives "just now", not a negative number.
  assert.equal(ago(1_000_000, 0), 'just now')
})
