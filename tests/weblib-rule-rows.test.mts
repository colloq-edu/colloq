/**
 * The room rule labels: the only place where the teacher reads what each
 * switch means.
 *
 * `RULE_ROWS` is plain TypeScript without Svelte, and until now nobody tested
 * it. And it breaks exactly silently: a rule without a row simply disappears
 * from the panel (the value keeps working, and nobody will find out); a value
 * that `readRules` does not have is drawn as a button that quietly goes back
 * to the default after being pressed — that is, a switch that promises the
 * wrong thing.
 *
 * Hence three checks: every room rule is named somewhere (or it is stated
 * here that it lives outside this panel), every option survives `readRules`
 * untouched, and every row has words.
 *
 * And a fourth, about the language of these words: the list is drawn not only
 * by the panel but also by the rules console inside the room, so translating
 * "along with the panel" means two names for one setting (the decision is in
 * the header of web/src/components/RoomRulesRows.svelte).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RULE_ROWS } from '../web/src/lib/rule-rows.js'
import { OPEN_ROOM, readRules, type RoomRules } from '../shared/rules.js'
import { LIMITS } from '../shared/admin.js'

/**
 * Rules that have no row in this panel — and why.
 *
 * A list, not silence: a rule that fell out of the panel by oversight looks
 * exactly like a rule that was decided to be asked elsewhere, and the two can
 * only be told apart by words.
 */
const ELSEWHERE: Record<string, string> = {
  // The Oracle mode — cards on the seminar creation screen
  // (NewSeminar.svelte), because it is chosen together with the model and the
  // instance cap.
  oracle: 'the Oracle cards when creating a seminar',
  // The model — in the same place, right next to it: it is a name, not a
  // switch.
  model: 'the model choice when creating a seminar',
  // Access to a SINGLE notebook — the menu on its tab (reader/TabStrip.svelte):
  // it is not a room setting but a property of one notebook, and it is asked
  // where that notebook is looked at. In the panel the `ownBooks` row answers
  // for it — what a notebook that a student creates for themselves gets.
  books: 'the "Access" menu on the notebook tab',
  /*
   * How much hardware is given to personal notebooks — a block that unfolds
   * UNDER the `ownBooks` row when it is on (RoomRulesRows.svelte · own-res). It
   * has no row of its own on purpose: it is not a twelfth room right but a
   * detail of one rule, and it is asked there and then, when the person turns
   * that rule on.
   */
  ownMemoryMb: 'the "Resources for all personal notebooks" block under the "Students’ personal notebooks" row',
  ownCpus: 'in the same place, next to the memory',
}

test('every room rule has a row — or it is stated where it is asked', () => {
  const named = new Set(RULE_ROWS.map((row) => row.key as string))
  for (const key of Object.keys(OPEN_ROOM) as (keyof RoomRules)[]) {
    assert.ok(
      named.has(key) || key in ELSEWHERE,
      `rule ${key} is named nowhere: the panel is silent, yet the rule is in effect`,
    )
  }
  for (const key of Object.keys(ELSEWHERE)) {
    assert.equal(named.has(key), false, `${key} is named both here and in the exception list`)
  }
})

test('there is one row per rule: two would argue with each other', () => {
  const keys = RULE_ROWS.map((row) => row.key as string)
  assert.equal(new Set(keys).size, keys.length, 'a rule is named twice')
})

test('every switch option survives readRules untouched', () => {
  for (const row of RULE_ROWS) {
    if (row.kind !== 'choice') continue
    for (const option of row.options) {
      const read = readRules({ [row.key]: option.value }) as unknown as Record<string, unknown>
      assert.equal(
        read[row.key],
        option.value,
        `"${row.title}" offers ${option.value}, but the room reads ${String(read[row.key])}`,
      )
    }
  }
})

test('the room default is named among the options — otherwise the panel will not show what is set', () => {
  for (const row of RULE_ROWS) {
    if (row.kind !== 'choice') continue
    const now = (OPEN_ROOM as unknown as Record<string, unknown>)[row.key]
    assert.ok(
      row.options.some((option) => option.value === now),
      `"${row.title}" has no option for the default ${String(now)}`,
    )
  }
})

test('every row has a title, an explanation and labels for its options', () => {
  for (const row of RULE_ROWS) {
    assert.ok(row.title.trim().length > 0, `${row.key} has no title`)
    assert.ok(row.note.trim().length > 20, `${row.key}: the note explains nothing`)
    if (row.kind !== 'choice') continue
    assert.ok(row.options.length >= 2, `${row.key}: a switch with a single position`)
    for (const option of row.options) {
      assert.ok(option.label.trim().length > 0, `${row.key}: an option without a label`)
    }
  }
})

/*
 * Numeric rows come in two kinds, and this is not sloppiness.
 *
 * The Oracle caps have an INSTANCE setting behind them: an empty field means
 * "as on the server", and the note must name the server's number. The cell
 * limit (`cellLimitSec`) has no server number at all — an empty field means
 * "no limit" — and a made-up line "as on the server: —" would answer a
 * question nobody asked. So `atInstance` is optional, and the list of rows
 * without an instance is here, as a list, not silence: a row that lost its
 * hint by oversight looks the same as a row that is not supposed to have one.
 */
const NO_INSTANCE: Record<string, string> = {
  cellLimitSec: 'cell limit: the instance has no such number, empty means "no limit"',
}

test('numeric rows are measured with the same ruler as the instance setting', () => {
  for (const row of RULE_ROWS) {
    if (row.kind !== 'limit') continue
    assert.ok(row.unit.trim().length > 0, `${row.key}: the number was left bare`)
    if (NO_INSTANCE[row.key]) {
      assert.equal(row.atInstance, undefined, `${row.key}: ${NO_INSTANCE[row.key]}`)
      assert.ok(row.min >= 1, `${row.key}: zero seconds means "stop right away"`)
      assert.ok(row.max > row.min, `${row.key}: a ruler with no length`)
      continue
    }
    const ceiling = LIMITS[row.key as keyof typeof LIMITS]
    assert.ok(ceiling, `${row.key}: the room has a field, but the instance has no ruler`)
    assert.ok(row.min >= ceiling.min, `${row.key}: the room asks for less than the instance can do`)
    assert.equal(row.max, ceiling.max, `${row.key}: the room asks for more than the instance can do`)
    // Zero is not a number but a special state, and the note must say in
    // words which one: "0 per hour" next to an input field is a riddle, not a
    // hint.
    assert.doesNotMatch(row.atInstance!(0), /^0/, `${row.key}: zero is shown as a number`)
    assert.match(row.atInstance!(5), /5/, `${row.key}: the instance value is not named`)
  }
})

test('the edge of the ruler is accepted by the room, and beyond the edge it is clamped', () => {
  for (const row of RULE_ROWS) {
    if (row.kind !== 'limit') continue
    const read = readRules({ [row.key]: row.max }) as unknown as Record<string, unknown>
    assert.equal(read[row.key], row.max, `${row.key}: the panel offers the edge, but the room cuts it`)
    const over = readRules({ [row.key]: row.max + 1 }) as unknown as Record<string, unknown>
    /*
     * Beyond the edge it differs, and the difference is meaningful. The Oracle
     * cap is clamped: "less than asked for" is the safe side here. The cell
     * limit falls to `null`, that is, "no limit": its safe side is exactly the
     * opposite — cutting off someone's walkthrough because of garbage in a
     * field is worse than not cutting it off.
     */
    assert.equal(
      over[row.key],
      NO_INSTANCE[row.key] ? null : row.max,
      `${row.key}: the room accepted a number beyond the edge of the ruler`,
    )
  }
})

/*
 * The language of the labels is the room's language, and it changes only
 * together with it.
 *
 * A half-done translation does not fail and does not draw anything crooked:
 * it simply names the rule with one word in the panel and with another in the
 * room, and a teacher who closed the notebook from the panel looks in the room
 * for a switch that is not there. The check is crude on purpose — a Cyrillic
 * letter in every visible line: a fine one would catch style, but what must be
 * caught is exactly one case — "they translated the panel and forgot the
 * room". If the room's language is changed one day, these lines will move
 * together with it and in one piece, and then this test changes, not half of
 * the array.
 */
const ROOM_LANGUAGE = /[А-Яа-яЁё]/

test('the rule labels stay in the language of the room — the panel does not translate them separately', () => {
  for (const row of RULE_ROWS) {
    const twoNames = `"${row.title}" was translated separately from the room: rule ${row.key} now has two names`
    assert.match(row.title, ROOM_LANGUAGE, twoNames)
    assert.match(row.note, ROOM_LANGUAGE, twoNames)
    if (row.kind === 'choice') {
      for (const option of row.options) assert.match(option.label, ROOM_LANGUAGE, twoNames)
    } else {
      assert.match(row.unit, ROOM_LANGUAGE, twoNames)
      // Zero is named in words, and those words are read in the room too. A
      // row without an instance has nothing to name — see NO_INSTANCE.
      if (row.atInstance) assert.match(row.atInstance(0), ROOM_LANGUAGE, twoNames)
    }
  }
})
