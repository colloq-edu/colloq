/**
 * Панель преподавателя: четыре места, где она говорила неправду словами.
 *
 * Проверяется не разметка, а решения под ней — те, что вынесены в
 * `web/src/admin/panel.ts` именно затем, чтобы их можно было проверить без
 * браузера: что сказать человеку, которого сервер перестал пускать; какой режим
 * оракула комната получит на самом деле; какой файл не доедет; с каких часов
 * считается идущее занятие.
 *
 * Каждое из четырёх однажды уже соврало на живой паре, и каждое врало
 * молча — экран выглядел исправным.
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

/* ------------------------------------------------------------------ вход */

test('отвергнутое печенье и несохранившееся печенье — разные слова', () => {
  setLocaleResolver(() => 'en')
  const cookies = signedOutNotice('no-cookie')
  const revoked = signedOutNotice('revoked')
  const removed = signedOutNotice('removed-self')

  assert.notEqual(cookies, revoked)
  assert.notEqual(revoked, removed)

  // Отозванной ссылке настройки браузера не помогут: там нечего чинить.
  assert.doesNotMatch(revoked, /cookie/i)
  assert.match(revoked, /link|owner/i)

  // А несохранившемуся печенью — помогут, и об этом надо сказать прямо.
  assert.match(cookies, /cookies/i)

  // Свой же поступок не называют сбоем браузера.
  assert.doesNotMatch(removed, /cookie/i)
  assert.match(removed, /removed your own account/i)
})

/* ---------------------------------------------------------------- оракул */

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

test('потолок инстанса: три разных способа не дать оракула вовсе', () => {
  // Ключа нет ни в панели, ни в окружении, а провайдер — чужое облако, которое
  // без ключа не ответит никому. Локальный рантайм — другой случай, ниже.
  assert.equal(oracleCeiling(settings({ provider: 'custom', apiKeyMasked: null })).mode, 'off')
  // Ключ из окружения — это ключ.
  assert.equal(oracleCeiling(settings({ apiKeyMasked: null, keyFromEnvironment: true })).mode, 'full')
  assert.equal(oracleCeiling(settings({ defaultMode: 'off' })).mode, 'off')
  // Ноль вопросов в час — то же самое «выключено», только другими словами
  // (server/src/routes/ai.ts: enabled = aiReady() && mode !== 'off' && limit > 0).
  assert.equal(oracleCeiling(settings({ questionsPerHour: 0 })).mode, 'off')
})

test('у потолка всегда есть причина словами, а у свободного инстанса её нет', () => {
  assert.equal(oracleCeiling(settings()).why, null)
  for (const capped of [
    settings({ provider: 'custom', apiKeyMasked: null }),
    settings({ provider: 'ollama', baseUrl: '', apiKeyMasked: null }),
    settings({ defaultMode: 'off' }),
    settings({ questionsPerHour: 0 }),
    settings({ defaultMode: 'hints' }),
  ]) {
    const why = oracleCeiling(capped).why
    assert.ok(why && why.length > 0, 'потолок без причины — это молчаливый отказ')
  }
})

test('«Full answers» на инстансе в режиме hints — не выбор, а обещание', () => {
  const hints = oracleCeiling(settings({ defaultMode: 'hints' })).mode
  assert.equal(hints, 'hints')
  assert.equal(oracleOverCeiling('full', hints), true)
  assert.equal(oracleOverCeiling('hints', hints), false)
  // Строже потолка — можно всегда: комната ужесточает и никогда не ослабляет.
  assert.equal(oracleOverCeiling('off', hints), false)
  // «Как на инстансе» не бывает выше инстанса: это он и есть.
  assert.equal(oracleOverCeiling('inherit', hints), false)
  assert.equal(oracleOverCeiling('inherit', 'off'), false)
})

test('локальный рантайм без ключа — настроенный инстанс, а не выключенный', () => {
  /*
   * Сервер пускает вопрос по `aiReady()` → `providerReady()` (ai/provider.ts):
   * «ключ, ЛИБО рантайм, у которого понятия ключа нет» — ollama и vllm с
   * адресом. Панель считала здесь по одному ключу и на настроенной Ollama
   * гасила и «Full answers», и более строгий «Hints only», объявляя оракула
   * несуществующим, пока он отвечал.
   */
  const ollama = oracleCeiling(
    settings({
      provider: 'ollama',
      baseUrl: 'http://host.docker.internal:11434/v1',
      apiKeyMasked: null,
    }),
  )
  assert.equal(ollama.mode, 'full')
  assert.equal(ollama.why, null, 'настроенный инстанс не объясняется потолком, которого нет')
  assert.equal(oracleOverCeiling('full', ollama.mode), false)
  assert.equal(oracleOverCeiling('hints', ollama.mode), false)

  // Адреса нет — спрашивать по-прежнему некого, но чинится это не ключом, и
  // строка на экране обязана называть то, чего не хватает.
  const homeless = oracleCeiling(settings({ provider: 'ollama', baseUrl: '', apiKeyMasked: null }))
  assert.equal(homeless.mode, 'off')
  assert.match(homeless.why ?? '', /Ollama/)
  assert.doesNotMatch(homeless.why ?? '', /key/i)

  // Список бесключевых — один на сервер и панель (shared/admin.ts · KEYLESS_PROVIDERS).
  assert.deepEqual([...KEYLESS_PROVIDERS], ['ollama', 'vllm'])
})

test('«некому отвечать» панель берёт из shared, а не из своей копии', () => {
  // Фабрика выше — defaultMode 'full' и вопросы в час больше нуля, так что
  // единственная причина потолка здесь — настроен провайдер или нет.
  for (const provider of Object.keys(PROVIDER_PRESETS) as AiProviderId[]) {
    for (const baseUrl of ['', '/', 'http://localhost:11434/v1']) {
      for (const masked of [null, 'sk-…8fA2']) {
        const ready = providerConfigured({ provider, baseUrl, hasKey: masked !== null })
        assert.equal(
          oracleCeiling(settings({ provider, baseUrl, apiKeyMasked: masked })).mode,
          ready ? 'full' : 'off',
          `${provider} · ${baseUrl || '(без адреса)'} · ${masked ? 'с ключом' : 'без ключа'}`,
        )
      }
    }
  }
})

test('выключенный инстанс гасит и hints, и full', () => {
  assert.equal(oracleOverCeiling('hints', 'off'), true)
  assert.equal(oracleOverCeiling('full', 'off'), true)
  assert.equal(oracleOverCeiling('off', 'off'), false)
})

test('панель считает тем же правилом, что и сервер, а не своей копией', () => {
  const wants = ['inherit', 'off', 'hints', 'full'] as const
  const instances = ['off', 'hints', 'full'] as const
  for (const want of wants) {
    for (const instance of instances) {
      assert.equal(
        oracleUnder(want, instance),
        oracleModeIn({ ...OPEN_ROOM, oracle: want }, instance),
        `${want} под ${instance}`,
      )
    }
  }
})

/* ----------------------------------------------------------------- файлы */

test('файл больше предела отсекается до создания комнаты, остальные едут', () => {
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

test('предел неизвестен — берём всё: выдуманный отказ хуже отказа сервера', () => {
  // 0 здесь — это «сервер не сказал», а не «ничего нельзя».
  const files = [{ name: 'huge.bin', size: 900 * 1024 * 1024 }]
  assert.equal(splitBySize(files, 0).refused.length, 0)
  assert.equal(splitBySize(files, 0).taken.length, 1)
})

test('предел называют мегабайтами, теми же, что сервер в отказе', () => {
  assert.equal(uploadMb(50 * 1024 * 1024), 50)
  assert.equal(uploadMb(200 * 1024 * 1024), 200)
})

/* ---------------------------------------------------------- «идёт сейчас» */

test('«started» — только про часы занятия, а не про час создания комнаты', () => {
  setLocaleResolver(() => 'en')
  const now = Date.UTC(2026, 8, 7, 12, 0)
  const week = now - 6 * 24 * 60 * 60 * 1000
  const room = { liveCount: 3, createdAt: week, liveSince: now - 25 * 60_000 }

  assert.equal(runningLine(room, now), '3 people in the room · started 25 min ago')
  // Комнату завели за неделю — и это не длительность пары.
  assert.doesNotMatch(runningLine(room, now), /days ago/)
})

test('часов занятия нет — часы называются своим именем, а не чужим', () => {
  setLocaleResolver(() => 'en')
  const now = Date.UTC(2026, 8, 7, 12, 0)
  const week = now - 6 * 24 * 60 * 60 * 1000
  const line = runningLine({ liveCount: 1, createdAt: week }, now)

  // Это и был весь дефект: «Running now · started 6 days ago».
  assert.doesNotMatch(line, /started/)
  assert.equal(line, '1 person in the room · created 6 days ago')
})

test('разряды длительности: минуты, часы, вчера, дни', () => {
  setLocaleResolver(() => 'en')
  const at = (ms: number) => ago(0, ms)
  assert.equal(at(0), 'just now')
  assert.equal(at(25 * 60_000), '25 min ago')
  assert.equal(at(3 * 3_600_000), '3 h ago')
  assert.equal(at(26 * 3_600_000), 'yesterday')
  assert.equal(at(50 * 3_600_000), '2 days ago')
  // Отставшие часы браузера дают «just now», а не отрицательное число.
  assert.equal(ago(1_000_000, 0), 'just now')
})
