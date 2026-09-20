/**
 * README и его русский перевод: правила комнаты, переключатель языка, сцены,
 * команды и ссылки. Ни один из двух файлов не собирает и не типизирует никто.
 *
 * Про правила комнаты — сразу ниже. Про пару README.md ↔ README.ru.md — в шапке
 * второй половины файла, у слова «Перевод».
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
 * Слова проверяются вместо дела намеренно: дело — в соседних сюитах, а README
 * не собирает и не типизирует никто.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RULE_ROWS } from '../web/src/lib/rule-rows.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const readme = readFileSync(path.join(root, 'README.md'), 'utf8')
const readmeRu = readFileSync(path.join(root, 'README.ru.md'), 'utf8')

/**
 * Абзац README, начинающийся с этих слов: до первой пустой строки, одной строкой.
 *
 * Переносы схлопываются нарочно: абзац переносится по восьмидесяти знакам, и
 * фраза «a document on the room's screen» ломается посередине там, где сегодня
 * пришлась граница. Проверка, чувствительная к ней, падала бы от переформата.
 */
function paragraph(from: string, text: string = readme): string {
  const at = text.indexOf(from)
  assert.notEqual(at, -1, `в README нет абзаца «${from}…»`)
  return text.slice(at, text.indexOf('\n\n', at)).replace(/\s+/g, ' ')
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
  cellLimitSec: /a cell stops itself/i,
  structure: /changes the structure/i,
  board: /document on the room's screen/i,
  ownBooks: /start their own notebook/i,
  files: /create and edit files/i,
  agent: /on the room's files/i,
  agentSteps: /actions per request/i,
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

/**
 * Перевод. README.ru.md — не второй документ про то же, а тот же документ: за
 * первым занятием преподаватель приходит из русской документации, и расходятся
 * такие пары молча. Английский README правят, русский остаётся прошлогодним —
 * и в нём ещё живёт «pip install colloq пока не работает» или команда с флагом,
 * которого больше нет.
 *
 * Поэтому сверяется ровно то, что обязано совпадать, и ничего сверх:
 *
 *   — переключатель языка есть в обоих и стоит ВЫШЕ прочих значков: это
 *     единственная дорога из одного файла в другой, GitHub не покажет её сам;
 *   — сцены те же и в том же порядке, а русский README берёт русские файлы по
 *     имени `<slug>-ru-<тема>.svg` (их пишет `make readme-art`);
 *   — команды в блоках кода совпадают ЗНАК В ЗНАК; переводятся только
 *     комментарии после `#` — команда, переведённая «для красоты», не
 *     выполнится;
 *   — каждая относительная ссылка ведёт к существующему файлу, а каждая ссылка
 *     на якорь — к заголовку того же файла. Якоря русских заголовков
 *     кириллические, и `#quick-start` в переводе — ссылка в никуда, которую
 *     глазами не поймать.
 *
 * Чего здесь нет: сверки текста. Перевод — это перевод, а не калька, и тест,
 * считающий абзацы, запретил бы русскому README быть написанным по-русски.
 */

/**
 * Заголовок → якорь GitHub: строчные буквы, пунктуация вон, пробелы в дефисы.
 *
 * Тот же набор, что выбрасывает github-slugger (пробела в нём нет — его черёд
 * после). Буквы не трогаются вовсе, поэтому у русского заголовка якорь
 * кириллический, а не пустой: «Быстрый старт» → `#быстрый-старт`.
 */
const ANCHOR_DROP =
  /[\u0021-\u002C\u002E-\u002F\u003A-\u0040\u005B-\u005E\u0060\u007B-\u007E\u00A0-\u00BF\u00D7\u00F7\u2000-\u206F\u2E00-\u2E7F]/g
function anchor(heading: string): string {
  return heading.trim().toLowerCase().replace(ANCHOR_DROP, '').replace(/ /g, '-')
}

/** Блоки кода файла: язык из ограды и строки тела без хвостовых комментариев. */
function codeBlocks(text: string): { lang: string; commands: string[] }[] {
  return [...text.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map((m) => ({
    lang: m[1]!,
    commands: m[2]!
      .split('\n')
      .map((line) => line.replace(/\s+#.*$/, '').trim())
      .filter(Boolean),
  }))
}

/** Сцены README по порядку: `<slug>-<тема>.svg` из `<picture>`. */
function scenes(text: string): string[] {
  const seen: string[] = []
  for (const m of text.matchAll(/\.github\/assets\/readme\/([a-z-]+)-(?:light|dark)\.svg/g)) {
    if (!seen.includes(m[1]!)) seen.push(m[1]!)
  }
  return seen
}

/** Всё, на что файл ссылается: markdown-ссылки и href/src в разметке. */
function links(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) out.add(m[1]!)
  for (const m of text.matchAll(/(?:href|src|srcset)="([^"]+)"/g)) out.add(m[1]!)
  return [...out]
}

const SWITCH_ACTIVE = '0F2D69'
const SWITCH_QUIET = '6B7280'
/** «Русский», как его пишут в адресе значка: latin-1 адрес, кириллица в процентах. */
const RU_LABEL = encodeURIComponent('Русский')

test('оба README открываются переключателем языка, и текущий язык в нём горит', () => {
  for (const [file, text, active] of [
    ['README.md', readme, 'English'],
    ['README.ru.md', readmeRu, RU_LABEL],
  ] as const) {
    assert.match(text, /href="README\.md"/, `${file}: нет ссылки на английский README`)
    assert.match(text, /href="README\.ru\.md"/, `${file}: нет ссылки на русский README`)

    const quiet = active === 'English' ? RU_LABEL : 'English'
    assert.ok(
      text.includes(`${active}-${SWITCH_ACTIVE}?style=for-the-badge`),
      `${file}: язык самого файла не выделен фирменным ${SWITCH_ACTIVE}`,
    )
    assert.ok(
      text.includes(`${quiet}-${SWITCH_QUIET}?style=for-the-badge`),
      `${file}: второй язык не приглушён до ${SWITCH_QUIET}`,
    )

    // Выше прочих значков: переключатель ищут глазами в первом экране, а не
    // среди CI, лицензии и версии.
    assert.ok(
      text.indexOf('href="README.ru.md"') < text.indexOf('workflows/ci.yml'),
      `${file}: переключатель языка уехал ниже остальных значков`,
    )
  }
})

test('сцены в русском README — те же и в том же порядке, но русские', () => {
  const en = scenes(readme)
  assert.deepEqual(en, ['room', 'run', 'council', 'lecture', 'oracle'], 'сцены README поменялись')
  assert.deepEqual(
    scenes(readmeRu),
    en.map((slug) => `${slug}-ru`),
    'русский README показывает не те сцены: имена русских — `<slug>-ru-<тема>.svg`',
  )
  for (const slug of [...en, ...en.map((s) => `${s}-ru`)]) {
    for (const theme of ['light', 'dark']) {
      const file = `.github/assets/readme/${slug}-${theme}.svg`
      assert.ok(existsSync(path.join(root, file)), `нет ${file} — его пишет \`make readme-art\``)
    }
  }
})

test('команды в двух README совпадают знак в знак; переводятся только комментарии', () => {
  const en = codeBlocks(readme)
  const ru = codeBlocks(readmeRu)
  assert.equal(ru.length, en.length, 'в переводе другое число блоков кода')
  for (const [i, block] of en.entries()) {
    assert.equal(ru[i]!.lang, block.lang, `блок ${i + 1}: другой язык ограды`)
    assert.deepEqual(
      ru[i]!.commands,
      block.commands,
      `блок ${i + 1}: команды разошлись — переводить в них можно только комментарий после #`,
    )
  }
})

test('каждая ссылка обоих README ведёт к существующему файлу или заголовку', () => {
  for (const [file, text] of [
    ['README.md', readme],
    ['README.ru.md', readmeRu],
  ] as const) {
    const anchors = new Set([...text.matchAll(/^#{1,6} +(.+)$/gm)].map((m) => anchor(m[1]!)))
    for (const link of links(text)) {
      if (/^(?:https?:|mailto:)/.test(link)) continue
      if (link.startsWith('#')) {
        assert.ok(
          anchors.has(decodeURIComponent(link.slice(1))),
          `${file}: ссылка ${link} не ведёт ни к одному заголовку этого файла`,
        )
        continue
      }
      const target = link.split('#')[0]!
      assert.ok(existsSync(path.join(root, target)), `${file}: ссылка на несуществующий ${target}`)
    }
  }
})

/**
 * Чем русский README называет каждое правило. Ключи — те же, что в RULE_ROWS.
 *
 * Здесь, в отличие от английского перечня, слова взяты из подписей самой
 * комнаты (rule-rows.ts): комната по-русски, и преподаватель, прочитавший
 * «кто печатает в ячейках», найдёт в пульте ту же строку — «Печатать в
 * ячейках». Английскому README так совпасть не с чем, и он пересказывает.
 */
const NAMED_IN_README_RU: Record<string, RegExp> = {
  opens: /открытие ячейки/i,
  edit: /печатает в ячейках/i,
  run: /запускает код/i,
  cellLimitSec: /ячейка\s+останавливается сама/i,
  structure: /меняет состав тетради/i,
  board: /показывает документ комнате/i,
  ownBooks: /может ли студент завести\s+свою тетрадь/i,
  files: /создаёт и редактирует файлы/i,
  agent: /оракул файлы комнаты/i,
  agentSteps: /действий у одного запроса/i,
  questionsPerHour: /вопросов в час/i,
  slowModeSeconds: /промежуток между вопросами/i,
  history: /смотрит ленту версий/i,
  restart: /перезапускает ядро/i,
  wipe: /очищает общие результаты/i,
}

test('русский README называет те же правила комнаты, что и английский', () => {
  assert.deepEqual(
    Object.keys(NAMED_IN_README_RU).sort(),
    RULE_ROWS.map((row) => row.key).sort(),
    'перечень правил в README.ru.md разошёлся с RULE_ROWS: список правил один, и он в web/src/lib/rule-rows.ts',
  )
  const listing = paragraph('Что бы ни задал формат', readmeRu)
  for (const row of RULE_ROWS) {
    assert.match(
      listing,
      NAMED_IN_README_RU[row.key]!,
      `README.ru.md не называет правило «${row.title}» (${row.key})`,
    )
  }
  assert.ok(
    !/\b(десять|одиннадцать|двенадцать|тринадцать|\d+)\s+правил/i.test(listing),
    'в переводе записано число правил — оно разойдётся с массивом на первой же правке',
  )

  const said = paragraph('Отвечает ли оракул в этой комнате', readmeRu)
  assert.match(said, /форме создания/i, 'не сказано, где выбирают режим оракула')
  assert.match(said, /среди тех строк/i, 'не сказано, что среди правил комнаты его нет')
})
