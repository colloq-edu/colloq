/**
 * What the owner reads in the audit log's screen.
 *
 * The screen is a list, and the only thing that can go wrong in it quietly is
 * a word: an action with no label shows a raw key in one language and not the
 * other, a detail that says "true" where a person expects "yes". The words are
 * in web/src/admin/audit.ts, away from Svelte, so they are checked here
 * directly — in both languages, the way an owner in either will read them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ADMIN_AUDIT_ACTIONS, type AdminAuditEvent } from '../shared/admin.js'
import { hasTranslation, setLocaleResolver, translate } from '../shared/i18n.js'
import { auditActionLabel, auditActorless, auditDetail, auditTarget } from '../web/src/admin/audit.js'
import { adminApi } from '../web/src/lib/adminApi.js'

function event(partial: Partial<AdminAuditEvent>): AdminAuditEvent {
  return { id: 1, at: 0, actor: null, action: 'course.created', target: null, detail: null, ip: null, ...partial }
}

test('every kind of action has a label in both languages', () => {
  for (const action of ADMIN_AUDIT_ACTIONS) {
    const key = `admin.audit.action.${action}`
    assert.ok(hasTranslation(key), `no label for ${action}`)
    assert.notEqual(translate('ru', key), key)
    assert.notEqual(translate('en', key), key)
  }
})

test('an action this build does not know still shows, by its own name', () => {
  assert.equal(auditActionLabel('future.thing'), 'future.thing')
})

test('the details read as sentences where they are one, and as settings where they are settings', () => {
  setLocaleResolver(() => 'en')
  try {
    assert.equal(auditDetail(event({ action: 'staff.signed_in', detail: { via: 'setup_token' } })), 'with the setup token')
    assert.equal(auditDetail(event({ action: 'staff.signed_in', detail: { via: 'link' } })), 'with a personal link')
    assert.equal(auditDetail(event({ action: 'staff.role_changed', detail: { from: 'teacher', to: 'owner' } })), 'Teacher → Owner')
    assert.equal(
      auditDetail(event({ action: 'staff.identity_changed', detail: { name: 'Нина Сидорова', previousName: 'Нина Петрова' } })),
      'Нина Петрова → Нина Сидорова',
    )
    assert.equal(
      auditDetail(event({ action: 'environment.edited', detail: { added: ['duckdb'], removed: ['--extra-index-url https://***@x/simple'] } })),
      '+ duckdb\n− --extra-index-url https://***@x/simple',
    )
    assert.equal(
      auditDetail(event({ action: 'settings.oracle_changed', detail: { apiKey: 'set', model: 'm', sendNames: false } })),
      'apiKey: set · model: m · sendNames: no',
    )
    assert.equal(auditDetail(event({ action: 'settings.instance_changed', detail: { language: 'en', previousLanguage: 'ru' } })), 'Russian → English')
    assert.equal(auditDetail(event({ action: 'room.deleted' })), '')
    // Which of the hidden test's files left, and by which door.
    assert.equal(
      auditDetail(event({ action: 'competition.hidden_test_downloaded', detail: { files: ['extra.parquet', 'test.csv'], via: 'archive' } })),
      'extra.parquet, test.csv — in the materials archive',
    )
    assert.equal(auditDetail(event({ action: 'competition.hidden_test_downloaded', detail: { files: ['test.csv'], via: 'file' } })), "test.csv — by the file's own link")
  } finally {
    setLocaleResolver(() => 'ru')
  }
  assert.equal(
    auditDetail(event({ action: 'settings.oracle_changed', detail: { apiKey: 'cleared', sendNames: true } })),
    'apiKey: удалён · sendNames: да',
  )
  assert.equal(
    auditDetail(event({ action: 'competition.hidden_test_downloaded', detail: { files: ['extra.parquet', 'test.csv'], via: 'archive' } })),
    'extra.parquet, test.csv — в архиве материалов',
  )
  assert.equal(auditDetail(event({ action: 'competition.hidden_test_downloaded', detail: { files: ['test.csv'], via: 'file' } })), 'test.csv — по ссылке на файл')
  // A door this build does not know reads as written, never as one of the two.
  assert.equal(auditDetail(event({ action: 'competition.hidden_test_downloaded', detail: { files: ['test.csv'], via: 'mirror' } })), 'files: test.csv · via: mirror')
})

test('an event nobody signed in for names the server\'s console when it came from there, and a dash otherwise', () => {
  // A code minted with colloq-host runner-code (server/src/ops/runner-code.ts): no actor, its source in the detail.
  const minted = event({ action: 'runner.code_minted', detail: { machines: 3, hours: 12, trusted: true, approvedSlots: null, source: 'colloq-host' } })
  assert.equal(auditActorless(minted), 'Консоль сервера')
  // The server's own doing, a page republished when a class ends, has nobody to name.
  assert.equal(auditActorless(event({ action: 'publication.published', detail: { room: 'abc12345', trigger: 'finish' } })), '—')
  assert.equal(auditActorless(event({ action: 'runner.enrolled', detail: null })), '—')
  setLocaleResolver(() => 'en')
  try {
    assert.equal(auditActorless(minted), 'Server console')
  } finally {
    setLocaleResolver(() => 'ru')
  }
  // Said once: the What column reads as the panel's own code does, without the source the Who column spent.
  assert.equal(auditDetail(minted), 'machines: 3 · hours: 12 · trusted: да · approvedSlots: —')
  // A source the Who column did not spend still shows: one with a person to name, or one this build has no words for.
  const signed = { id: 't1', name: 'Нина Петрова', email: 'nina@example.org', role: 'owner' as const }
  assert.equal(auditDetail({ ...minted, actor: signed }), 'machines: 3 · hours: 12 · trusted: да · approvedSlots: — · source: colloq-host')
  assert.equal(auditDetail(event({ action: 'runner.code_minted', detail: { machines: 1, source: 'cron' } })), 'machines: 1 · source: cron')
  // The screen says it where a staff member's name would stand.
  const screen = fs
    .readFileSync(path.join(import.meta.dirname, '../web/src/admin/screens/AuditLog.svelte'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
  assert.match(screen, /\{:else\} <p class="text-ui text-muted">\{auditActorless\(event\)\}<\/p> \{\/if\}/)
})

test('the target is its name as it read then, or its id when it had none', () => {
  assert.equal(auditTarget(event({ target: { type: 'room', id: 'abc12345', label: 'Семинар 7' } })), 'Семинар 7')
  assert.equal(auditTarget(event({ target: { type: 'entrant', id: 'e_1', label: null } })), 'e_1')
  assert.equal(auditTarget(event({ target: null })), '')
})

test('the panel asks for a page by its cursor', async () => {
  const seen: string[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url))
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ events: [], next: null, retentionDays: 365 }),
      text: async () => JSON.stringify({ events: [], next: null, retentionDays: 365 }),
    } as unknown as Response
  }) as typeof fetch
  try {
    await adminApi.auditLog()
    await adminApi.auditLog(42, 50)
  } finally {
    globalThis.fetch = real
  }
  assert.deepEqual(seen, ['/api/admin/audit-log', '/api/admin/audit-log?before=42&limit=50'])
})
