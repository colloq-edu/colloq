/**
 * Room rules: what they promise and what survives an old record.
 *
 * Every field falls back to its own default separately from the others — that
 * is the migration, and it breaks silently: a seminar created before a field
 * existed has to open exactly as it was, not as a strict one.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allows,
  allowsRun,
  allowsAgent,
  allowsStructure,
  isLectureRoom,
  isOpenRoom,
  LECTURE_ROOM,
  mayEditCell,
  mayLeadCouncil,
  mayRunCell,
  mayRunCouncil,
  mayWriteCouncil,
  OPEN_ROOM,
  oracleLimitsIn,
  readRules,
  rulesAfterClass,
  runQueueCap,
  COUNCIL_ROOM,
  isCouncilRoom,
} from '../shared/rules.js'
import { LIMITS } from '../shared/admin.js'

test('a seminar stored before the new fields opens as it was', () => {
  // Exactly what the database holds for seminars created earlier.
  const stored = {
    run: 'room',
    edit: 'room',
    structure: 'room',
    terminal: 'room',
    files: 'room',
    oracle: 'inherit',
    model: null,
  }
  const read = readRules(stored)
  assert.equal(read.run, 'room')
  assert.equal(read.structure, 'room')
  // The three new ones were missing entirely: they read as defaults.
  assert.equal(read.wipe, 'host')
  assert.equal(read.restart, 'host')
  assert.equal(read.history, 'room')
  // And such a room still counts as "the product as it is".
  assert.equal(isOpenRoom(read), true, 'an old seminar stopped being an open room')
})

test('a strict value from an old record survives too', () => {
  const read = readRules({ run: 'host', structure: 'host', wipe: 'room' })
  assert.equal(read.run, 'host')
  assert.equal(read.structure, 'host')
  assert.equal(read.wipe, 'room')
})

test('an unknown value falls back to the permissive default, not the strict one', () => {
  // A rule that turns stricter because of a corrupted row locks the room in the
  // middle of a class, and there is nobody to explain it.
  const read = readRules({ run: 'sometimes', structure: 42, wipe: 'everyone' })
  assert.equal(read.run, OPEN_ROOM.run)
  assert.equal(read.structure, OPEN_ROOM.structure)
  assert.equal(read.wipe, OPEN_ROOM.wipe)
})

test('"one at a time" allows a cell and forbids the whole sheet', () => {
  assert.equal(allowsRun('single', 'participant', 'one'), true)
  assert.equal(allowsRun('single', 'participant', 'bulk'), false, 'Run All went through under "one at a time"')
  // The teacher gets both, at any value.
  assert.equal(allowsRun('single', 'host', 'bulk'), true)
  assert.equal(allowsRun('host', 'host', 'bulk'), true)
  assert.equal(allowsRun('host', 'participant', 'one'), false)
})

test('"one at a time" is a queue ceiling, not a ban', () => {
  assert.equal(runQueueCap('single', 'participant'), 1)
  assert.equal(runQueueCap('single', 'host'), Number.POSITIVE_INFINITY)
  assert.equal(runQueueCap('room', 'participant'), Number.POSITIVE_INFINITY)
})

test('"append only" allows exactly the first verb', () => {
  assert.equal(allowsStructure('add', 'participant', 'add'), true)
  assert.equal(allowsStructure('add', 'participant', 'remove'), false)
  assert.equal(
    allowsStructure('add', 'participant', 'move'),
    false,
    'moving into nowhere is a way around the ban on removing',
  )
  for (const verb of ['add', 'remove', 'move'] as const) {
    assert.equal(allowsStructure('add', 'host', verb), true)
    assert.equal(allowsStructure('host', 'participant', verb), false)
    assert.equal(allowsStructure('room', 'participant', verb), true)
  }
})

test('allows does not forget the teacher', () => {
  assert.equal(allows('host', 'host'), true)
  assert.equal(allows('host', 'participant'), false)
  assert.equal(allows('room', 'participant'), true)
})

test('the "Act" mode is teacher-only by default, and "nobody" closes it for everyone', () => {
  assert.equal(OPEN_ROOM.agent, 'host')
  assert.equal(allowsAgent('host', 'host'), true)
  assert.equal(allowsAgent('host', 'participant'), false)
  assert.equal(allowsAgent('room', 'participant'), true)
  /*
   * `off` is a property of the room, not anyone's right: "in this seminar the
   * oracle does not touch files" holds for the teacher too. The same argument
   * the shell had, back when there was one.
   */
  assert.equal(allowsAgent('off', 'host'), false)
})

test('an old rules row reads without the "Act" mode instead of breaking on it', () => {
  const old = readRules(JSON.stringify({ run: 'room', edit: 'room' }))
  assert.equal(old.agent, 'host', 'a seminar created before the mode would suddenly allow it to everyone')
})

/* ----------------------------------------------------------------- lecture */

test('a lecture closes everything done by hand and leaves alone what is used for watching', () => {
  for (const key of ['run', 'edit', 'structure', 'board', 'files', 'wipe', 'restart'] as const) {
    assert.equal(LECTURE_ROOM[key], 'host', `the ${key} rule is open in a lecture`)
  }
  assert.equal(LECTURE_ROOM.agent, 'host')
  // A lecture does not forbid reading the history or asking the oracle: it is
  // about who types and runs, not about who gets to watch.
  assert.equal(LECTURE_ROOM.history, OPEN_ROOM.history)
  assert.equal(LECTURE_ROOM.oracle, OPEN_ROOM.oracle)
  assert.equal(LECTURE_ROOM.model, OPEN_ROOM.model)
  // And a lecture stored in the database reads as a lecture, not as the defaults.
  assert.equal(isLectureRoom(readRules(JSON.stringify(LECTURE_ROOM))), true)
})

test('a lecture and an open room are not the same, and the end of a class reads as a lecture', () => {
  assert.equal(isLectureRoom(LECTURE_ROOM), true)
  assert.equal(isLectureRoom(OPEN_ROOM), false)
  assert.equal(isOpenRoom(LECTURE_ROOM), false)
  // One value off and it is no longer the preset: otherwise the panel would show
  // "lecture" for a room where the teacher has opened something up.
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, edit: 'room' }), false)
  /*
   * And this is worth knowing by sight: `rulesAfterClass` of any room gives
   * exactly the lecture values. In substance that is right — only the teacher
   * types and runs — but it must not be used to ask "is the class a lecture".
   */
  assert.equal(isLectureRoom(rulesAfterClass(OPEN_ROOM)), true)
})

test('an open cell grants typing and running where the rule closed them', () => {
  const closed = false
  const open = true
  // A lecture: the notebook is the teacher's, and the only door is an open cell.
  assert.equal(mayEditCell(LECTURE_ROOM, 'participant', closed, false), false)
  assert.equal(mayEditCell(LECTURE_ROOM, 'participant', open, false), true)
  assert.equal(mayRunCell(LECTURE_ROOM, 'participant', closed, false), false)
  assert.equal(mayRunCell(LECTURE_ROOM, 'participant', open, false), true)
  // The lock changes nothing for the teacher: the teacher writes and runs everywhere.
  assert.equal(mayEditCell(LECTURE_ROOM, 'host', closed, false), true)
  assert.equal(mayRunCell(LECTURE_ROOM, 'host', closed, false), true)
  // In an open room the lock changes nothing either — everything is allowed there anyway.
  assert.equal(mayEditCell(OPEN_ROOM, 'participant', closed, false), true)
  assert.equal(mayRunCell(OPEN_ROOM, 'participant', closed, false), true)
  // "One at a time" lets a press on a cell through even without a lock; the lock
  // does not tighten it.
  assert.equal(mayRunCell({ ...OPEN_ROOM, run: 'single' }, 'participant', closed, false), true)
})

test('the end of a class beats the lock', () => {
  /*
   * Otherwise "End class" would leave the room as many doors as the teacher had
   * opened during the class, and they would have to be closed one by one.
   */
  assert.equal(mayEditCell(LECTURE_ROOM, 'participant', true, true), false)
  assert.equal(mayRunCell(LECTURE_ROOM, 'participant', true, true), false)
  // Even in a room where the rules allow everything: the class has ended for the whole room.
  assert.equal(mayEditCell(OPEN_ROOM, 'participant', true, true), false)
  assert.equal(mayRunCell(OPEN_ROOM, 'participant', true, true), false)
  // But the teacher can still act after the class: the room stays alive.
  assert.equal(mayEditCell(LECTURE_ROOM, 'host', false, true), true)
  assert.equal(mayRunCell(LECTURE_ROOM, 'host', false, true), true)
})

/* ------------------------------------------------------ oracle ceilings */

test('oracle ceilings are read totally: garbage and absence both mean "as on the instance"', () => {
  // The room must not take any of these values for a number: a rule assembled
  // from garbage breaks spending most quietly of all.
  const junk = readRules({
    questionsPerHour: 'много',
    slowModeSeconds: {},
  })
  assert.equal(junk.questionsPerHour, null)
  assert.equal(junk.slowModeSeconds, null)
  assert.equal(readRules({ slowModeSeconds: Number.NaN }).slowModeSeconds, null)
  assert.equal(readRules({ questionsPerHour: Number.POSITIVE_INFINITY }).questionsPerHour, null)

  // An old row did not know these fields at all — and opens as it was.
  const old = readRules(JSON.stringify({ run: 'room', edit: 'room' }))
  assert.equal(old.questionsPerHour, null)
  assert.equal(old.slowModeSeconds, null)
  assert.equal(isOpenRoom(old), true, 'a room without ceilings stopped being open')
})

test('the number is clamped by the same ruler as the instance setting', () => {
  assert.equal(
    readRules({ questionsPerHour: 99_999 }).questionsPerHour,
    LIMITS.questionsPerHour.max,
  )
  assert.equal(readRules({ slowModeSeconds: 9_999 }).slowModeSeconds, LIMITS.slowModeSeconds.max)
  assert.equal(readRules({ slowModeSeconds: -5 }).slowModeSeconds, LIMITS.slowModeSeconds.min)
  assert.equal(readRules({ questionsPerHour: 4.6 }).questionsPerHour, 5)
  /*
   * The floor is one question, not zero: "no oracle today" is `oracle: 'off'`,
   * whose refusal says so in words, while zero here would turn the class away
   * with the phrase "all 0 questions used".
   */
  assert.equal(readRules({ questionsPerHour: 0 }).questionsPerHour, 1)
})

test('a room tightens the oracle ceilings and never loosens them', () => {
  const instance = { questionsPerHour: 20, slowModeSeconds: 10 }

  // If the room says nothing, the instance answers, and that is the default for any room.
  assert.deepEqual(oracleLimitsIn(OPEN_ROOM, instance), instance)

  // Stricter in different directions: fewer questions, a longer interval.
  assert.deepEqual(
    oracleLimitsIn({ ...OPEN_ROOM, questionsPerHour: 5, slowModeSeconds: 60 }, instance),
    { questionsPerHour: 5, slowModeSeconds: 60 },
  )

  // But it cannot be softer at either end: the instance pays for the model.
  assert.deepEqual(
    oracleLimitsIn({ ...OPEN_ROOM, questionsPerHour: 500, slowModeSeconds: 0 }, instance),
    instance,
  )

  // A switched-off oracle is not switched back on by a room number.
  assert.equal(
    oracleLimitsIn(
      { ...OPEN_ROOM, questionsPerHour: 50 },
      {
        questionsPerHour: 0,
        slowModeSeconds: 0,
      },
    ).questionsPerHour,
    0,
  )
})

test('the end of a class does not touch the oracle ceilings', () => {
  // They are about spending, not about a right: there is nothing in them for the bell to close.
  const after = rulesAfterClass({ ...OPEN_ROOM, questionsPerHour: 3, slowModeSeconds: 45 })
  assert.equal(after.questionsPerHour, 3)
  assert.equal(after.slowModeSeconds, 45)
})

test('council: anyone writes their own sheet while the class runs, whatever the rules', () => {
  /*
   * A council is opened precisely where `edit` is the teacher's: everyone writes
   * THEIR OWN sheet without touching the shared one. So the right has no "rules"
   * argument, and `mayEditCell` does not know about councils: to it the shared text is closed.
   */
  assert.equal(mayWriteCouncil('participant', false, false), true)
  assert.equal(mayWriteCouncil('participant', true, false), false, 'after the bell the work is handed in')
  assert.equal(mayWriteCouncil('participant', false, true), false, 'a closed council accepts writes')
  assert.equal(mayWriteCouncil('host', true, false), true)
  assert.equal(mayEditCell(LECTURE_ROOM, 'participant', false, false), false)
})

test('council: whoever leads runs it; a student only with the switch on', () => {
  assert.equal(mayRunCouncil('host', false, false), true)
  assert.equal(mayRunCouncil('participant', false, false), false, 'the switch is off, yet running is allowed')
  assert.equal(mayRunCouncil('participant', true, false), true)
  assert.equal(mayRunCouncil('participant', true, true), false, 'after the bell')
  assert.equal(mayRunCouncil('host', false, true), true)
  // The teacher leads, after the bell too: what was handed in stays open for review.
  assert.equal(mayLeadCouncil('host'), true)
  assert.equal(mayLeadCouncil('participant'), false)
})

/* --------------------------------------------------------------- council */

test('the council is a third door: a lecture by rights, but the lock opens a separate sheet for everyone', () => {
  // The same rights as a lecture: the teacher types, runs and opens.
  for (const key of ['run', 'edit', 'structure', 'files'] as const) {
    assert.equal(COUNCIL_ROOM[key], LECTURE_ROOM[key])
  }
  assert.equal(COUNCIL_ROOM.opens, 'council')
  assert.equal(LECTURE_ROOM.opens, 'shared')
  assert.equal(OPEN_ROOM.opens, 'shared')
  // A council is a lecture by rights and reads as a lecture: the "Lecture" bar
  // above the notebook is needed by five hundred people in a council just the same.
  assert.equal(isCouncilRoom(COUNCIL_ROOM), true)
  assert.equal(isLectureRoom(COUNCIL_ROOM), true, 'the council did not pass for a lecture')
  assert.equal(isCouncilRoom(LECTURE_ROOM), false, 'a lecture passed for a council')
  // Rights loosened: no longer a lecture, and so not a council.
  assert.equal(isCouncilRoom({ ...COUNCIL_ROOM, edit: 'room' }), false)
})

test('"how a cell opens" is not a right: the switch does not turn off the "Lecture" bar', () => {
  /*
   * In the rules table of a lecture room, "Open cell" was switched to "A sheet
   * for everyone" — not a single right changed, and the room has to read as a
   * lecture as before. Otherwise the only sign that explains the grey notebook
   * would disappear because of a row that is about the lock, not about rights.
   */
  assert.equal(isLectureRoom({ ...LECTURE_ROOM, opens: 'council' }), true)
  assert.equal(isLectureRoom({ ...COUNCIL_ROOM, opens: 'shared' }), true)
  // An open room does not become a council: everyone has the right to type.
  assert.equal(isLectureRoom({ ...OPEN_ROOM, opens: 'council' }), false)
  assert.equal(isCouncilRoom({ ...OPEN_ROOM, opens: 'council' }), false)
})

test('"how a cell opens" is read totally and survives the bell', () => {
  // A room stored before the field existed is ordinary: the lock opens for everyone.
  assert.equal(readRules({ run: 'host' }).opens, 'shared')
  assert.equal(readRules({ opens: 'мусор' }).opens, 'shared')
  assert.equal(readRules({ opens: 'council' }).opens, 'council')
  // After the bell cells are not opened, but the morning after the class has to remember the mode.
  assert.equal(rulesAfterClass(COUNCIL_ROOM).opens, 'council')
})
