import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express, { type Response } from 'express'
import http from 'node:http'
import { instanceSettingsRoutes } from '../server/src/routes/instance-settings.js'
import { getInstanceLanguage } from '../server/src/admin/settings.js'
import { db } from '../server/src/db.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { onInstanceLanguage } from '../server/src/instance-language.js'
import { getLocale } from '../shared/i18n.js'
function cookie(role: 'owner' | 'teacher') {
  const teacher = createTeacher({ name: role, email: `language-${role}@test.local`, role })!
  rotateLinkKey(teacher.id)
  let result = ''
  issueStaffCookie(
    {
      cookie: (key: string, value: string) => {
        result = `${key}=${value}`
      },
    } as unknown as Response,
    teacher,
  )
  return result
}
test('one persisted instance language is public to read and owner-only to change', async () => {
  const owner = cookie('owner'),
    teacher = cookie('teacher'),
    events: string[] = []
  const stop = onInstanceLanguage((locale) => events.push(locale))
  const app = express()
  app.use(express.json())
  app.use(instanceSettingsRoutes())
  const server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const patch = (cookie: string, body: unknown) =>
    fetch(base + '/api/admin/instance/settings', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  try {
    assert.deepEqual(await (await fetch(base + '/api/instance')).json(), { language: 'ru' })
    assert.equal((await patch('', { language: 'en' })).status, 401)
    assert.equal((await patch(teacher, { language: 'en' })).status, 403)
    assert.equal(getInstanceLanguage(), 'ru')
    const updated = await patch(owner, { language: 'en' })
    assert.equal(updated.status, 200)
    assert.deepEqual(await updated.json(), { language: 'en' })
    assert.equal(getLocale(), 'en')
    assert.equal(
      (
        db.prepare('SELECT value FROM instance_settings WHERE key=?').get('ui.language') as {
          value: string
        }
      ).value,
      'en',
    )
    assert.deepEqual(await (await fetch(base + '/api/instance')).json(), { language: 'en' })
    assert.deepEqual(events, ['en'])
    assert.equal((await patch(owner, { language: 'en' })).status, 200)
    assert.deepEqual(events, ['en'])
    assert.equal((await patch(owner, { language: 'fr' })).status, 400)
    assert.equal((await patch(owner, { language: 'ru', extra: true })).status, 400)
    assert.equal(getInstanceLanguage(), 'en')
    await patch(owner, { language: 'ru' })
  } finally {
    stop()
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})
