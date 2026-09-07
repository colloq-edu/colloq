/**
 * Окно правил семинара говорит одним языком — русским, как комната.
 *
 * Подписи правил живут в языке КОМНАТЫ: тот же список рисует пульт внутри неё
 * (web/src/lib/rule-rows.ts, tests/weblib-rule-rows.test.mts), и рамка вокруг
 * них другой быть не может. А причину отказа в подвале приносил общий
 * `explain()` панели, английской, — и на живой паре получалось «Правило не
 * сохранилось — The server did not respond»: половина фразы на языке, которого
 * в окне больше нигде нет (admin-17).
 *
 * Ломается это молча и одной строкой: `ruleRefusal(...)` меняют обратно на
 * `explain(cause)`, и ни один тест разметки этого не заметит — текст приезжает
 * по сети и только в отказе. Соседний `admin-address.test.mts` стережёт язык
 * самой разметки окна («русское, и сказано почему»), здесь — язык того, что в
 * окне появляется от сервера. Отсюда две проверки: слова русские при любой
 * причине, и в самом окне зовут именно их.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AdminErrorReason } from '../shared/admin.js'
import { ruleRefusal } from '../web/src/admin/panel.js'

/** Латиница в видимой строке — след английской панели, просочившийся в окно. */
const PANEL_LANGUAGE = /[A-Za-z]/
const ROOM_LANGUAGE = /[А-Яа-яЁё]/

/**
 * Все причины, какие вообще умеет назвать сервер, — списком, а не выборкой.
 *
 * Новая причина в `AdminErrorReason` без строки здесь просто провалится в
 * умолчание — это и есть задуманное поведение, но проверить надо, что она при
 * этом остаётся русской, а не приносит английский хвост.
 */
const REASONS: AdminErrorReason[] = [
  'unauthenticated',
  'forbidden',
  'unclaimed',
  'invalid',
  'not_found',
  'too_long',
  'in_use',
  'protected',
  'exists',
  'no_docker',
  'building',
  'failed',
  'network',
]

test('причина отказа в окне правил — по-русски при любом отказе', () => {
  const lines = [
    ruleRefusal(null),
    ...REASONS.map((reason) =>
      ruleRefusal({ reason, status: 400, body: { error: 'nope', reason } }),
    ),
    // И тот же набор без разобранного тела: так приходит отказ через прокси.
    ...REASONS.map((reason) => ruleRefusal({ reason, status: 502 })),
  ]
  for (const line of lines) {
    assert.match(line, ROOM_LANGUAGE, `«${line}» — не на языке окна`)
    assert.doesNotMatch(line, PANEL_LANGUAGE, `«${line}» — хвост английской панели в русском окне`)
    // Фраза целая: половинчатую («Правило не сохранилось — ») читать не о чем.
    assert.match(line, /^Правило не сохранилось[ ,—].+[.]$/u, `«${line}» — обрывок фразы`)
  }
})

test('сеть, отвергнутый вход и права названы каждый своим, а не одним словом', () => {
  const network = ruleRefusal({ reason: 'network', status: 0, body: null })
  const dead = ruleRefusal({ reason: 'unauthenticated', status: 401, body: { error: 'x' } })
  const forbidden = ruleRefusal({ reason: 'forbidden', status: 403, body: { error: 'x' } })
  const unknown = ruleRefusal(null)

  assert.match(network, /сервер не ответил/)
  assert.match(dead, /вход/)
  assert.match(forbidden, /прав/)
  assert.equal(new Set([network, dead, forbidden, unknown]).size, 4)
})

/*
 * «Семинара больше нет» — это факт, и говорится он только с ответа маршрута.
 *
 * 404 с той же цифрой отдаст и прокси перед сервером, и туннель, забывший про
 * /api; по этой фразе преподаватель пойдёт заводить второй семинар вместо того,
 * чтобы починить адрес.
 */
test('404 без тела не хоронит семинар', () => {
  const ours = ruleRefusal({
    reason: 'invalid',
    status: 404,
    body: { error: 'that seminar no longer exists', reason: 'invalid' },
  })
  const stranger = ruleRefusal({ reason: 'invalid', status: 404, body: null })

  assert.match(ours, /семинара больше нет/)
  assert.doesNotMatch(stranger, /семинара больше нет/)
  assert.match(stranger, /попробуйте ещё раз/)
})

/* --------------------------------------------------------------- окно */

const SEMINARS = 'web/src/admin/screens/Seminars.svelte'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Разметка без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

test('окно правил берёт причину у себя, а не у английского explain()', () => {
  const seminars = code(read(SEMINARS))
  const assignments = seminars.match(/rulesError = [^\n]+/g) ?? []

  assert.ok(assignments.length > 0, 'подвал окна правил больше ничего не показывает')
  for (const line of assignments) {
    assert.doesNotMatch(line, /explain\(/, `${line.trim()} — английская причина в русском окне`)
  }
  assert.match(seminars, /rulesError = ruleRefusal\(/, 'причина берётся из panel.ts')
  // Отвергнутое печенье по-прежнему уводит на экран входа: перевод причины не
  // должен был отменить смену экрана (admin-1).
  assert.match(seminars, /noteDeadCookie\(cause\)[\s\S]{0,200}rulesError = ruleRefusal\(/)
})
