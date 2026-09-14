/**
 * Письма преподавателя по попытке: два письма — две строки, и старый сервер.
 *
 * У попытки два места под письмо, личное и групповое (server/src/council.ts ·
 * keeping), и на экране они обязаны читаться порознь. Пока обе поверхности
 * рисовали `reply` — склейку тех же писем через пустую строку, — переносы в
 * `<p class="flex flex-wrap">` схлопывались, и «Проверьте знак» с рассылкой
 * шли одной фразой: «Проверьте знак Всем: поправка». Дефект чисто разметочный,
 * сокета у него нет, откатывается одной строкой — поэтому читается прямо из
 * компонентов, как в `panels-craft` и `council-stack-craft`.
 *
 * Вторая половина — запасной путь: у сервера постарше поля `replies` нет
 * вовсе, и без падения на `reply` новый клиент не показал бы ответа вообще.
 * Правило одно на обе поверхности и живёт в shared, копий быть не должно.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { councilLetters, type CouncilReply } from '../shared/protocol.js'

const ROOT = resolve(import.meta.dirname, '..')
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8')
/** Разметка и код без комментариев: объяснение — не обещание. */
const code = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

const SHEET = 'web/src/components/notebook/CellView.svelte'
/*
 * Вторая поверхность — окно пульта: письма читает `PultWork` (той же общей
 * функцией), а рисует построчно `PultLetters`. Прежняя стопка под ячейкой,
 * которая стояла здесь, удалена вместе с консолью в тетради.
 */
const WORK = 'web/src/components/council/pult/PultWork.svelte'
const LETTERS = 'web/src/components/council/pult/PultLetters.svelte'

const letter = (text: string, to?: 'person' | 'group'): CouncilReply => ({
  text,
  at: 1,
  by: 'Анна Петровна',
  ...(to ? { to } : {}),
})

test('письма берутся из replies, а reply остаётся запасным путём', () => {
  const personal = letter('Проверьте знак', 'person')
  const group = letter('Всем: поправка', 'group')

  assert.deepEqual(councilLetters({ reply: group, replies: [personal, group] }), [personal, group])

  // Сервер постарше: поля `replies` нет, приезжает одна склейка — её и рисуем.
  const glued = letter('Проверьте знак\n\nВсем: поправка')
  assert.deepEqual(councilLetters({ reply: glued }), [glued])

  // «Писем нет» — пустой список, а не строка ни с чем.
  assert.deepEqual(councilLetters({ reply: null }), [])
  assert.deepEqual(councilLetters({ reply: glued, replies: [] }), [])
  assert.deepEqual(councilLetters(null), [])
  assert.deepEqual(councilLetters(undefined), [])
})

test('обе поверхности рисуют строку на письмо, а не абзац на попытку', () => {
  for (const [name, sources, mark] of [
    ['лист студента', [SHEET], /tr\('room\.ui\.70'\)/],
    // В пульте рассылка названа «Вы · всем N» (room.ui.1329): у преподавателя
    // это его собственное письмо, и адресат в нём — число людей.
    ['пульт преподавателя', [WORK, LETTERS], /tr\('room\.ui\.1329'/],
  ] as const) {
    const source = sources.map((rel) => code(read(rel))).join('\n')
    assert.match(source, /councilLetters\(/, `${name}: письма берутся мимо shared`)
    assert.match(
      source,
      /\{#each\s+(letters|councilLetters\([^)]*\))\s+as\s+letter/,
      `${name}: письма не развёрнуты в строки`,
    )
    assert.doesNotMatch(
      source,
      /\breply\??\.(text|by|at)\b/,
      `${name}: склейка «reply» снова попала на экран — два письма прочтутся одним`,
    )
    // Молчание на личном письме значит «это вам»; рассылку надо назвать вслух.
    assert.match(source, /letter\.to === 'group'/, `${name}: групповое письмо ничем не помечено`)
    assert.match(source, mark, `${name}: нет слова про рассылку`)
  }
})

test('правило запасного пути живёт в shared в одной копии', () => {
  const shared = code(read('shared/protocol.ts'))
  assert.match(shared, /export function councilLetters\(/, 'shared больше не объявляет правило')
  for (const rel of [SHEET, WORK, LETTERS]) {
    assert.doesNotMatch(
      code(read(rel)),
      /replies\s*\?\?/,
      `${rel}: своя копия падения на reply — она однажды отстанет от shared`,
    )
  }
})
