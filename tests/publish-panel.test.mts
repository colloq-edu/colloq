/**
 * The publish screen: two places where the panel kept quiet about what it
 * already knew.
 *
 * The first is a moment that did not become a step. The teacher marked seven,
 * got a page with six and counted the rail by eye: an empty or unreadable
 * version dropped out without a word. Now the server names the dropped ones
 * one by one (shared/publish.ts · SkippedStep), and this checks that the panel
 * can name them to a person — with the same copy of the reasons as the server.
 *
 * The second is the refusal "address already taken" when what stands behind
 * it is not somebody else's live page but the memory of a link handed out.
 * The owner can release such a name themselves, but only if the refusal said
 * who holds it. What is checked is the parsing of that answer — including the
 * case where the server says nothing about the holder: then the panel has to
 * behave as before and offer nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SKIP_REASON_TEXT, type SkipReason } from '../shared/publish.js'
import { skippedStepLine } from '../web/src/admin/panel.js'
import { AdminApiError, addressHolderOf, adminApi } from '../web/src/lib/adminApi.js'

/* ------------------------------------------ a moment that became nothing */

test('every reason has its own word, and the word is shared with the server', () => {
  const reasons: SkipReason[] = ['empty', 'broken', 'unnamed', 'duplicate']
  const said = new Set<string>()
  for (const reason of reasons) {
    const line = skippedStepLine({ seq: 4, label: 'перед упражнением', reason })
    // The reason comes from shared rather than being rewritten here as a second copy.
    assert.ok(
      line.includes(SKIP_REASON_TEXT[reason]),
      `${reason}: the line does not name the reason in the server's words`,
    )
    said.add(line)
  }
  assert.equal(said.size, reasons.length, 'two different reasons are worded the same')
})

test('the moment is named the way the teacher named it', () => {
  const line = skippedStepLine({ seq: 12, label: 'версия, которая ломалась', reason: 'empty' })
  assert.ok(line.includes('версия, которая ломалась'))
  // The version number is not the moment's name: nobody sees it in the student's feed.
  assert.doesNotMatch(line, /12/)
})

test('an unnamed moment is called by its time rather than passed over in silence', () => {
  const line = skippedStepLine({ seq: 12, label: '   ', reason: 'unnamed' }, '14:05, 3 сентября')
  assert.ok(line.includes('14:05, 3 сентября'))
  assert.ok(line.includes(SKIP_REASON_TEXT.unnamed))
})

test('with nothing at all to name it by: the version number, but the line is there', () => {
  // The candidate is no longer in the list (the history was trimmed), and there
  // is nowhere to take the time from.
  const line = skippedStepLine({ seq: 41, label: '', reason: 'broken' })
  assert.ok(line.includes('41'), 'without the number the line shows nothing at all')
  assert.ok(line.includes(SKIP_REASON_TEXT.broken))
})

/* -------------------------------------------- who holds the address name */

const refusal = (body: unknown): AdminApiError =>
  new AdminApiError('Адрес «ml-2025» уже занят.', 409, 'invalid', body)

test('the holder of a former name reaches the panel in full', () => {
  const holder = addressHolderOf(
    refusal({
      error: 'Адрес «ml-2025» уже занят.',
      reason: 'invalid',
      holder: { kind: 'course', id: 'c0000001', name: 'ML 2025', former: true },
    }),
  )
  assert.deepEqual(holder, { kind: 'course', id: 'c0000001', name: 'ML 2025', former: true })
})

test('a live address of another page is told apart from a former one: former travels as is', () => {
  const holder = addressHolderOf(
    refusal({ holder: { kind: 'publication', id: 'p0000009', name: 'Неделя 1', former: false } }),
  )
  // There is nothing to release here, and the panel has to see that from the answer, not guess.
  assert.equal(holder?.former, false)
})

test('server silence about the holder does not invent a holder', () => {
  // While the server names only the fact ("already taken"), the screen behaves
  // as before: it shows the refusal phrase and offers nothing to release.
  assert.equal(addressHolderOf(refusal({ error: 'Адрес «ml-2025» уже занят.' })), null)
  assert.equal(addressHolderOf(refusal(null)), null)
})

test('garbage in the answer does not become a button', () => {
  for (const holder of [
    { kind: 'seminar', id: 'x', name: 'x', former: true },
    { kind: 'course', name: 'без идентификатора', former: true },
    { kind: 'course', id: '', name: 'пустой', former: true },
    'ml-2025',
    42,
  ]) {
    assert.equal(addressHolderOf(refusal({ holder })), null, JSON.stringify(holder))
  }
})

test('a refusal about something else is not about the address: a 404 names no holder', () => {
  const notFound = new AdminApiError('not found', 404, 'invalid', {
    holder: { kind: 'course', id: 'c0000001', name: 'ML 2025', former: true },
  })
  assert.equal(addressHolderOf(notFound), null)
  assert.equal(addressHolderOf(new Error('network')), null)
})

/* -------------------------------------------- releasing a former name */

test('a former name is released at its holder, not at whoever needs it', async () => {
  const seen: { url: string; init?: RequestInit }[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), init })
    return {
      ok: true,
      status: 204,
      headers: new Headers({ 'content-length': '0' }),
      json: async () => ({}),
    } as unknown as Response
  }) as typeof fetch
  try {
    await adminApi.releaseFormerSlug('course', 'c0000001', 'ml-2025')
  } finally {
    globalThis.fetch = real
  }

  assert.equal(seen.length, 1)
  // The id in the address is the holder's: the server releases a name only to its
  // owner (server/src/publish/store.ts · releaseFormerSlug).
  assert.equal(seen[0].url, '/api/admin/slug/course/c0000001/former/ml-2025')
  assert.equal(seen[0].init?.method, 'DELETE')
})
