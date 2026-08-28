/**
 * Правило комнаты, доведённое до документа.
 *
 * Разбор говорит, ЧТО в кадре; правила — кому это можно. Здесь проверяется
 * стык, и проверяется на настоящих кадрах: два документа, обмен байтами,
 * никаких выдуманных приговоров. Ошибка здесь выглядит как работающий гейт и
 * стоит либо запертой комнаты при разрешающих умолчаниях, либо правила,
 * которое ничего не значит.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { classify, permits } from '../server/src/collab/gate.js'
import { OPEN_ROOM, type RoomRules } from '../shared/rules.js'
import { CELLS_KEY, META_KEY, createCell } from '../shared/notebook.js'

function pair(): { server: Y.Doc; client: Y.Doc; frame: (write: () => void) => Uint8Array } {
  const server = new Y.Doc()
  const client = new Y.Doc()
  server.transact(() => {
    server.getMap(META_KEY).set('title', 'Семинар')
    server.getArray(CELLS_KEY).push([createCell('code', 'print(1)', 'c1'), createCell('code', 'x', 'c2')])
  })
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
  const frame = (write: () => void): Uint8Array => {
    let captured: Uint8Array | null = null
    const grab = (u: Uint8Array): void => {
      captured = captured ? Y.mergeUpdates([captured, u]) : u
    }
    client.on('update', grab)
    client.transact(write)
    client.off('update', grab)
    assert.ok(captured)
    return captured!
  }
  return { server, client, frame }
}

/** Прошёл бы этот кадр в такой комнате от такого человека. */
function passes(
  server: Y.Doc,
  bytes: Uint8Array,
  rules: Partial<RoomRules>,
  role: 'host' | 'participant',
): string | null {
  const judged = classify(server, bytes)
  if (!judged.ok) return judged.why
  const verdict = permits(judged.verdicts, { ...OPEN_ROOM, ...rules }, role)
  return verdict.ok ? null : verdict.message
}

const typing = (client: Y.Doc): void => {
  const cell = client.getArray(CELLS_KEY).get(0) as Y.Map<unknown>
  ;(cell.get('source') as Y.Text).insert(0, 'ы')
}

/* --------------------------------------------------------------- печатать */

test('в лекционной комнате студент не пишет, а преподаватель пишет', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => typing(client))
  assert.match(passes(server, bytes, { edit: 'host' }, 'participant') ?? '', /преподавател/i)
  assert.equal(passes(server, bytes, { edit: 'host' }, 'host'), null)
  assert.equal(passes(server, bytes, {}, 'participant'), null, 'умолчание закрыло тетрадь')
})

/* ------------------------------------------------------------ состав листа */

test('«только дописывать» разрешает свою ячейку и запрещает убрать чужую', () => {
  const { server, client, frame } = pair()
  const added = frame(() => client.getArray(CELLS_KEY).push([createCell('code', 'моё', 'c9')]))
  assert.equal(passes(server, added, { structure: 'add' }, 'participant'), null)
  Y.applyUpdate(server, added)

  const removed = frame(() => client.getArray(CELLS_KEY).delete(0, 1))
  assert.match(passes(server, removed, { structure: 'add' }, 'participant') ?? '', /убирает/i)
  assert.equal(passes(server, removed, { structure: 'add' }, 'host'), null)
})

test('«состав — преподавательский» запрещает и добавление', () => {
  const { server, client, frame } = pair()
  const added = frame(() => client.getArray(CELLS_KEY).push([createCell('code', 'моё', 'c9')]))
  assert.match(passes(server, added, { structure: 'host' }, 'participant') ?? '', /добавляет/i)
})

/* ------------------------------------------------------------- имя семинара */

test('имя семинара меняет преподаватель, при любых правилах', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getMap(META_KEY).set('title', 'Моё имя'))
  for (const rules of [{}, { edit: 'room' as const }, { structure: 'room' as const }]) {
    assert.ok(passes(server, bytes, rules, 'participant'), 'имя переписали при правилах ' + JSON.stringify(rules))
  }
  assert.equal(passes(server, bytes, {}, 'host'), null)
})

/* --------------------------------------------------------------------- пол */

test('пол комнаты не поднимается никакими правилами', () => {
  /*
   * Разрешительнее «всем можно всё» правил не бывает — а это по-прежнему
   * отказывает, и должно: сервер пишет вывод сам, и никакая настройка не
   * делает подделку чужого вывода вопросом настройки.
   */
  const { server, client, frame } = pair()
  const bytes = frame(() => {
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ 'text/html': '<style>*{display:none}</style>' }))
    ;((client.getArray(CELLS_KEY).get(0) as Y.Map<unknown>).get('outputs') as Y.Array<unknown>).push([out])
  })
  const everything: Partial<RoomRules> = {
    edit: 'room',
    run: 'room',
    structure: 'room',
    terminal: 'room',
    files: 'room',
    wipe: 'room',
    restart: 'room',
    history: 'room',
  }
  assert.ok(passes(server, bytes, everything, 'participant'))
  assert.ok(passes(server, bytes, everything, 'host'), 'преподавателю подделка вывода тоже закрыта')
})

/* ---------------------------------------------------- ужесточение на ходу */

test('правило, поменявшееся посреди пары, действует на следующий же кадр', () => {
  // Правила читаются на каждый кадр, а не на подключение: иначе «глаза сюда»
  // начинало бы работать только после того, как все переподключились.
  const { server, client, frame } = pair()
  const before = frame(() => typing(client))
  assert.equal(passes(server, before, {}, 'participant'), null)
  Y.applyUpdate(server, before)
  const after = frame(() => typing(client))
  assert.ok(passes(server, after, { edit: 'host' }, 'participant'))
})
