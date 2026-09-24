/**
 * README and its Russian translation: room rules, the language switch,
 * scenes, commands and links. Nobody builds or type-checks either of the two
 * files.
 *
 * About the room rules — right below. About the README.md ↔ README.ru.md
 * pair — in the header of the second half of the file, at the word
 * "Translation".
 *
 * The list of room rules. The README named twelve rules and listed eleven
 * real ones plus one foreign one: "whether the oracle answers here at all" is
 * not switched off in the room settings at all — the oracle mode is chosen
 * with cards when creating a seminar (NewSeminar.svelte), while "Open cell"
 * — the only row that distinguishes a lecture from a council — was not named
 * in the list at all. The price is a teacher who, in the middle of a class,
 * goes into the room settings to look for the oracle switch and does not
 * find it. So here: every rule from RULE_ROWS is named in the README
 * paragraph in its own words, and not a single extra one; there is one list
 * of rules (web/src/lib/rule-rows.ts), and the README must follow it.
 *
 * Words are checked instead of the deed on purpose: the deed is in the
 * neighbouring suites, and nobody builds or type-checks the README.
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
 * The README paragraph starting with these words: up to the first blank
 * line, as one line.
 *
 * Line breaks are collapsed on purpose: the paragraph wraps at eighty
 * characters, and the phrase "a document on the room's screen" breaks in the
 * middle wherever the boundary falls today. A check sensitive to it would
 * fail after a reformat.
 */
function paragraph(from: string, text: string = readme): string {
  const at = text.indexOf(from)
  assert.notEqual(at, -1, `the README has no paragraph "${from}…"`)
  return text.slice(at, text.indexOf('\n\n', at)).replace(/\s+/g, ' ')
}

/**
 * What the README calls each rule. The keys are the same as in RULE_ROWS.
 *
 * Not a retelling of the panel caption: the README is in English, while the
 * captions are the room's and in Russian (see the header of rule-rows.ts).
 * Completeness is checked, not the translation: a rule added to the panel
 * and forgotten in the README fails this test with the key's name — that
 * is, with exactly the word that has to be added.
 */
const NAMED_IN_README: Record<string, RegExp> = {
  opens: /opening a cell/i,
  edit: /edits a cell's text/i,
  run: /runs code/i,
  cellLimitSec: /a cell stops itself/i,
  danger: /dangerous commands run/i,
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

test('the README names all room rules and not a single extra one', () => {
  const inCode = RULE_ROWS.map((row) => row.key).sort()
  const inDocs = Object.keys(NAMED_IN_README).sort()
  assert.deepEqual(
    inDocs,
    inCode,
    'the rules list in the README diverged from RULE_ROWS: there is one list of rules, and it is in web/src/lib/rule-rows.ts',
  )

  const listing = paragraph('Whatever the card sets')
  for (const row of RULE_ROWS) {
    assert.match(
      listing,
      NAMED_IN_README[row.key],
      `the README does not name the rule "${row.title}" (${row.key}) among those the room edits itself`,
    )
  }
})

test('the README does not state the number of rules — it has diverged twice already', () => {
  // Exactly the reason there is no number in the header of rule-rows.ts
  // either: a rule gets added to the array, while the word "twelve" stays in
  // two other files.
  const listing = paragraph('Whatever the card sets')
  assert.ok(
    !/\b(ten|eleven|twelve|thirteen|fourteen|\d+)\s+rules\b/i.test(listing),
    'the README states the number of rules again — it will diverge from the array at the first edit',
  )
})

test('the README attributes the oracle mode to seminar creation, not to the room settings', () => {
  assert.ok(
    !RULE_ROWS.some((row) => row.key === ('oracle' as string)),
    'the oracle appeared in the room settings — then the README must stop sending people to creation for it',
  )
  const said = paragraph('Whether the oracle answers in this room')
  assert.match(said, /creation form/i, 'it is not said where the oracle mode is chosen')
  assert.match(said, /not one of those rows/i, 'it is not said that it is not among the room rules')
})

/**
 * Translation. README.ru.md is not a second document about the same thing
 * but the same document: for their first class a teacher comes from the
 * Russian documentation, and such pairs drift apart silently. The English
 * README gets edited, the Russian one stays last year's — and still has
 * "pip install colloq does not work yet" or a command with a flag that no
 * longer exists.
 *
 * So exactly what must match is checked, and nothing beyond that:
 *
 *   — the language switch is in both and stands ABOVE the other badges: it
 *     is the only road from one file to the other, GitHub will not show it
 *     by itself;
 *   — the scenes are the same and in the same order, and the Russian README
 *     takes Russian files by the name `<slug>-ru-<theme>.svg` (they are
 *     written by `make readme-art`);
 *   — commands in code blocks match CHARACTER FOR CHARACTER; only comments
 *     after `#` are translated — a command translated "for beauty" will not
 *     run;
 *   — every relative link leads to an existing file, and every anchor link
 *     to a heading of the same file. Anchors of Russian headings are
 *     Cyrillic, and `#quick-start` in the translation is a link to nowhere
 *     that the eye will not catch.
 *
 * What is not here: text comparison. A translation is a translation, not a
 * calque, and a test counting paragraphs would forbid the Russian README to
 * be written in Russian.
 */

/**
 * Heading → GitHub anchor: lowercase letters, punctuation out, spaces into
 * hyphens.
 *
 * The same set github-slugger throws out (space is not in it — its turn
 * comes after). Letters are not touched at all, so a Russian heading's
 * anchor is Cyrillic, not empty: "Быстрый старт" → `#быстрый-старт`.
 */
const ANCHOR_DROP =
  /[\u0021-\u002C\u002E-\u002F\u003A-\u0040\u005B-\u005E\u0060\u007B-\u007E\u00A0-\u00BF\u00D7\u00F7\u2000-\u206F\u2E00-\u2E7F]/g
function anchor(heading: string): string {
  return heading.trim().toLowerCase().replace(ANCHOR_DROP, '').replace(/ /g, '-')
}

/** The file's code blocks: the language from the fence and the body lines without trailing comments. */
function codeBlocks(text: string): { lang: string; commands: string[] }[] {
  return [...text.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map((m) => ({
    lang: m[1]!,
    commands: m[2]!
      .split('\n')
      .map((line) => line.replace(/\s+#.*$/, '').trim())
      .filter(Boolean),
  }))
}

/** The README scenes in order: `<slug>-<theme>.svg` from `<picture>`. */
function scenes(text: string): string[] {
  const seen: string[] = []
  for (const m of text.matchAll(/\.github\/assets\/readme\/([a-z-]+)-(?:light|dark)\.svg/g)) {
    if (!seen.includes(m[1]!)) seen.push(m[1]!)
  }
  return seen
}

/** Everything the file links to: markdown links and href/src in markup. */
function links(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) out.add(m[1]!)
  for (const m of text.matchAll(/(?:href|src|srcset)="([^"]+)"/g)) out.add(m[1]!)
  return [...out]
}

const SWITCH_ACTIVE = '0F2D69'
const SWITCH_QUIET = '6B7280'
/** The Russian-language label as written in the badge URL: a latin-1 address, Cyrillic percent-encoded. */
const RU_LABEL = encodeURIComponent('Русский')

test('both READMEs open with the language switch, and the current language is lit in it', () => {
  for (const [file, text, active] of [
    ['README.md', readme, 'English'],
    ['README.ru.md', readmeRu, RU_LABEL],
  ] as const) {
    assert.match(text, /href="README\.md"/, `${file}: no link to the English README`)
    assert.match(text, /href="README\.ru\.md"/, `${file}: no link to the Russian README`)

    const quiet = active === 'English' ? RU_LABEL : 'English'
    assert.ok(
      text.includes(`${active}-${SWITCH_ACTIVE}?style=for-the-badge`),
      `${file}: the file's own language is not highlighted with the brand ${SWITCH_ACTIVE}`,
    )
    assert.ok(
      text.includes(`${quiet}-${SWITCH_QUIET}?style=for-the-badge`),
      `${file}: the second language is not muted to ${SWITCH_QUIET}`,
    )

    // Above the other badges: the switch is looked for on the first screen,
    // not among CI, licence and version.
    assert.ok(
      text.indexOf('href="README.ru.md"') < text.indexOf('workflows/ci.yml'),
      `${file}: the language switch moved below the other badges`,
    )
  }
})

test('the scenes in the Russian README are the same and in the same order, but Russian', () => {
  const en = scenes(readme)
  assert.deepEqual(en, ['room', 'run', 'council', 'lecture', 'oracle'], 'the README scenes changed')
  assert.deepEqual(
    scenes(readmeRu),
    en.map((slug) => `${slug}-ru`),
    'the Russian README shows the wrong scenes: the Russian ones are named `<slug>-ru-<theme>.svg`',
  )
  for (const slug of [...en, ...en.map((s) => `${s}-ru`)]) {
    for (const theme of ['light', 'dark']) {
      const file = `.github/assets/readme/${slug}-${theme}.svg`
      assert.ok(existsSync(path.join(root, file)), `${file} is missing — it is written by \`make readme-art\``)
    }
  }
})

test('commands in the two READMEs match character for character; only comments are translated', () => {
  const en = codeBlocks(readme)
  const ru = codeBlocks(readmeRu)
  assert.equal(ru.length, en.length, 'the translation has a different number of code blocks')
  for (const [i, block] of en.entries()) {
    assert.equal(ru[i]!.lang, block.lang, `block ${i + 1}: a different fence language`)
    assert.deepEqual(
      ru[i]!.commands,
      block.commands,
      `block ${i + 1}: the commands diverged — only the comment after # may be translated in them`,
    )
  }
})

test('every link in both READMEs leads to an existing file or heading', () => {
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
          `${file}: link ${link} leads to no heading of this file`,
        )
        continue
      }
      const target = link.split('#')[0]!
      assert.ok(existsSync(path.join(root, target)), `${file}: link to a non-existent ${target}`)
    }
  }
})

/**
 * What the Russian README calls each rule. The keys are the same as in
 * RULE_ROWS.
 *
 * Here, unlike the English list, the words are taken from the room's own
 * captions (rule-rows.ts): the room is in Russian, and a teacher who read
 * "кто печатает в ячейках" will find the same line in the console —
 * "Печатать в ячейках". The English README has nothing to match like that,
 * so it retells.
 */
const NAMED_IN_README_RU: Record<string, RegExp> = {
  opens: /открытие ячейки/i,
  edit: /печатает в ячейках/i,
  run: /запускает код/i,
  cellLimitSec: /ячейка\s+останавливается сама/i,
  danger: /исполняются ли опасные команды/i,
  structure: /меняет состав\s+тетради/i,
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

test('the Russian README names the same room rules as the English one', () => {
  assert.deepEqual(
    Object.keys(NAMED_IN_README_RU).sort(),
    RULE_ROWS.map((row) => row.key).sort(),
    'the rules list in README.ru.md diverged from RULE_ROWS: there is one list of rules, and it is in web/src/lib/rule-rows.ts',
  )
  const listing = paragraph('Что бы ни задал формат', readmeRu)
  for (const row of RULE_ROWS) {
    assert.match(
      listing,
      NAMED_IN_README_RU[row.key]!,
      `README.ru.md does not name the rule "${row.title}" (${row.key})`,
    )
  }
  assert.ok(
    !/\b(десять|одиннадцать|двенадцать|тринадцать|\d+)\s+правил/i.test(listing),
    'the translation states the number of rules — it will diverge from the array at the first edit',
  )

  const said = paragraph('Отвечает ли оракул в этой комнате', readmeRu)
  assert.match(said, /форме создания/i, 'it is not said where the oracle mode is chosen')
  assert.match(said, /среди тех строк/i, 'it is not said that it is not among the room rules')
})
