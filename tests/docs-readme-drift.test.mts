/**
 * Два места README, которые расходятся с деревом сами, без единой правки в них.
 *
 * Перечень правил комнаты. README называл двенадцать правил и перечислял
 * одиннадцать настоящих плюс одно чужое: «whether the oracle answers here at
 * all» из настроек комнаты не выключается вовсе — режим оракула выбирают
 * карточками при создании семинара (NewSeminar.svelte), а «Открытая ячейка» —
 * та единственная строка, которой лекция отличается от консилиума, — в
 * перечне не была названа вовсе. Цена — преподаватель, который посреди пары
 * идёт в настройки комнаты искать переключатель оракула и не находит его.
 * Поэтому здесь: каждое правило из RULE_ROWS названо в абзаце README своими
 * словами, и ни одного лишнего; список правил один (web/src/lib/rule-rows.ts),
 * и README обязан ходить за ним.
 *
 * Число тестов. Строка «about N tests» врала уже дважды и в обе стороны — 220,
 * когда их была тысяча, и 1,100, когда их стало 1,700, — потому что растёт она
 * от чужих правок, а живёт в файле, который при этом никто не открывает.
 * Здесь она сверяется с деревом: обещанное — не больше правды и не в разы
 * меньше неё.
 *
 * Слова проверяются вместо дела намеренно: дело — в соседних сюитах, а README
 * не собирает и не типизирует никто.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RULE_ROWS } from '../web/src/lib/rule-rows.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const readme = readFileSync(path.join(root, 'README.md'), 'utf8')

/**
 * Абзац README, начинающийся с этих слов: до первой пустой строки, одной строкой.
 *
 * Переносы схлопываются нарочно: абзац переносится по восьмидесяти знакам, и
 * фраза «a document on the room's screen» ломается посередине там, где сегодня
 * пришлась граница. Проверка, чувствительная к ней, падала бы от переформата.
 */
function paragraph(from: string): string {
  const at = readme.indexOf(from)
  assert.notEqual(at, -1, `в README нет абзаца «${from}…»`)
  return readme.slice(at, readme.indexOf('\n\n', at)).replace(/\s+/g, ' ')
}

/**
 * Чем README называет каждое правило. Ключи — те же, что в RULE_ROWS.
 *
 * Не пересказ подписи из панели: README английский, а подписи комнатные и
 * по-русски (об этом — шапка rule-rows.ts). Сверяется полнота, а не перевод:
 * правило, добавленное в панель и забытое в README, роняет этот тест с именем
 * ключа — то есть ровно тем словом, которое надо дописать.
 */
const NAMED_IN_README: Record<string, RegExp> = {
  opens: /opening a cell/i,
  edit: /edits a cell's text/i,
  run: /runs code/i,
  structure: /changes the structure/i,
  board: /document on the room's screen/i,
  files: /create and edit files/i,
  agent: /on the room's files/i,
  questionsPerHour: /questions per hour/i,
  slowModeSeconds: /seconds between questions/i,
  history: /read the history/i,
  restart: /restart the kernel/i,
  wipe: /wipe shared work/i,
}

test('README называет все правила комнаты и ни одного лишнего', () => {
  const inCode = RULE_ROWS.map((row) => row.key).sort()
  const inDocs = Object.keys(NAMED_IN_README).sort()
  assert.deepEqual(
    inDocs,
    inCode,
    'перечень правил в README разошёлся с RULE_ROWS: список правил один, и он в web/src/lib/rule-rows.ts',
  )

  const listing = paragraph('Whatever the card sets')
  for (const row of RULE_ROWS) {
    assert.match(
      listing,
      NAMED_IN_README[row.key],
      `README не называет правило «${row.title}» (${row.key}) среди тех, что комната правит у себя`,
    )
  }
})

test('README не называет число правил — оно уже дважды разошлось', () => {
  // Ровно та причина, по которой числа нет и в шапке rule-rows.ts: правило
  // добавляют в массив, а слово «двенадцать» остаётся в двух других файлах.
  const listing = paragraph('Whatever the card sets')
  assert.ok(
    !/\b(ten|eleven|twelve|thirteen|fourteen|\d+)\s+rules\b/i.test(listing),
    'в README снова записано число правил — оно разойдётся с массивом на первой же правке',
  )
})

test('режим оракула README относит к созданию семинара, а не к настройкам комнаты', () => {
  assert.ok(
    !RULE_ROWS.some((row) => row.key === ('oracle' as string)),
    'оракул появился в настройках комнаты — тогда README обязан перестать отсылать за ним к созданию',
  )
  const said = paragraph('Whether the oracle answers in this room')
  assert.match(said, /creation form/i, 'не сказано, где режим оракула выбирают')
  assert.match(said, /not one of those rows/i, 'не сказано, что среди правил комнаты его нет')
})

test('число тестов в README — не меньше правды и не в разы', () => {
  const dir = path.join(root, 'tests')
  let declared = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.test.mts')) continue
    const body = readFileSync(path.join(dir, name), 'utf8')
    declared += body.match(/^[ \t]*(?:test|it)\(/gm)?.length ?? 0
  }
  assert.ok(declared > 0, 'в tests/ не нашлось ни одного объявленного теста — сломан счёт, а не README')

  const said = readme.match(/over ([\d,]+) tests/i)
  assert.ok(said, 'в README нет строки «over N tests» — если её убрали, уберите и эту проверку')
  const promised = Number(said[1].replace(/,/g, ''))
  assert.ok(
    promised <= declared,
    `README обещает ${promised} тестов, а объявлено ${declared}: «over» перестало быть правдой`,
  )
  // Вдвое — та граница, за которой число перестаёт быть порядком величины и
  // становится неправдой: прошлые расхождения были впятеро и в полтора раза.
  assert.ok(
    declared < promised * 2,
    `тестов ${declared} против обещанных ${promised} — строка в README отстала больше чем вдвое`,
  )
})
