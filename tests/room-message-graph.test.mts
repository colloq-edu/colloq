import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { collectEntryMessages } from '../web/scripts/entry-messages.js'
import { messages } from '../shared/i18n.js'

test('room dictionary discovery follows the room static graph and leaves optional components aside', () => {
  const room = collectEntryMessages(path.resolve(import.meta.dirname, '..'), messages, ['web/src/screens/SessionScreen.svelte'])
  assert.ok(room.messages['room.ui.494'], 'the visible Oracle empty state needs its words')
  assert.ok(room.files.some(file => file.endsWith('/CodeEditor.svelte')), 'immediate editor belongs to this graph')
  for (const deferred of ['ChatTurn', 'CellOutputs', 'Markdown', 'PdfReader', 'ConsoleView']) {
    assert.ok(!room.files.some(file => file.endsWith(`/${deferred}.svelte`)), `${deferred} was paid ahead of its content`)
  }
})

test('entry, room and optional room dictionaries partition the complete room catalog in each language', async () => {
  const { default: config } = await import('../web/vite.config.js')
  const { commonMessages } = await import('../shared/locales/common.js')
  const { roomMessages } = await import('../shared/locales/room.js')
  const { activityMessages } = await import('../shared/locales/activity.js')
  const root = path.resolve(import.meta.dirname, '..')
  const plugin = (config as any).plugins.find((item: any) => item.name === 'colloq-screen-language')
  const entry = collectEntryMessages(root, messages).messages
  const get = (area: string, locale: string) => {
    const code = plugin.load.call({ addWatchFile() {} }, path.join(root, `web/src/lib/messages/${area}-${locale}.ts`)) as string
    return JSON.parse(code.slice(code.indexOf('registerMessages(') + 17, code.lastIndexOf(')')))
  }
  for (const locale of ['ru', 'en'] as const) {
    const core = get('room', locale), extra = get('room-extra', locale)
    for (const [key, pair] of Object.entries({...commonMessages, ...roomMessages, ...activityMessages})) {
      assert.deepEqual(entry[key]?.[locale] ?? core[key]?.[locale] ?? extra[key]?.[locale], pair[locale], key)
      assert.equal(Number(key in entry) + Number(key in core) + Number(key in extra), 1, `${key} paid twice`)
    }
    assert.ok(Object.keys(extra).length > 0, 'unopened features must carry their own dictionary')
  }
})
