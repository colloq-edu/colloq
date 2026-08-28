/**
 * Таблица прав на управляющем сокете.
 *
 * Каждая строка здесь — отказ, который должен прозвучать РАНЬШЕ действия:
 * ядро не трогается, оболочка не открывается, очередь не растёт. Поэтому
 * сокет здесь поддельный и ядра нет вовсе — если проверка пропустит, тест
 * упадёт не утверждением, а попыткой сходить в несуществующий Jupyter.
 *
 * И вторая половина, без которой первая ничего не стоит: при разрешающих
 * умолчаниях всё это проходит. Правило, которое отказывает всем, — не правило.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, setRules } from '../server/src/db.js'
import { OPEN_ROOM, type RoomRules } from '../shared/rules.js'
import { dispatch } from '../server/src/control.js'
import type { ControlClientMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

/** Ровно то, что читает `send`: состояние и приём кадра. */
function socket(): { ws: WebSocket; said: string[] } {
  const said: string[] = []
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => {
      const message = JSON.parse(frame) as { t: string; message?: string }
      if (message.t === 'error') said.push(message.message ?? '')
    },
  } as unknown as WebSocket
  return { ws, said }
}

let rooms = 0

/** Комната с этими правилами и один человек в ней. */
function room(rules: Partial<RoomRules>): string {
  const id = `ctl-${++rooms}`
  createSession(id, 'Control', null)
  setRules(id, { ...OPEN_ROOM, ...rules })
  return id
}

function who(role: 'host' | 'participant', sessionId: string): TokenPayload {
  return { sessionId, participantId: `p_${role}`, role }
}

/** Что сказал сервер в ответ на это сообщение. `null` — не сказал ничего. */
function say(
  sessionId: string,
  role: 'host' | 'participant',
  message: ControlClientMessage,
): string | null {
  const { ws, said } = socket()
  dispatch(ws, sessionId, who(role, sessionId), message)
  return said[0] ?? null
}

/* ------------------------------------------------------------ весь лист */

test('«по одной» разрешает ячейку и отказывает всему листу', () => {
  const id = room({ run: 'single' })
  // Одна ячейка — до ядра дойти и не должно: такой ячейки в тетради нет.
  assert.equal(say(id, 'participant', { t: 'run', cellId: 'c_nope' }), null)
  assert.match(say(id, 'participant', { t: 'runAll' }) ?? '', /по одной/)
  assert.match(say(id, 'participant', { t: 'runAbove', cellId: 'c_nope' }) ?? '', /по одной/)
  // Преподавателю — и то и другое.
  assert.equal(say(id, 'host', { t: 'runAll' }), null)
})

test('«запускает преподаватель» отказывает и ячейке, и листу', () => {
  const id = room({ run: 'host' })
  assert.ok(say(id, 'participant', { t: 'run', cellId: 'c_nope' }))
  assert.ok(say(id, 'participant', { t: 'runAll' }))
  assert.equal(say(id, 'host', { t: 'run', cellId: 'c_nope' }), null)
})

/* -------------------------------------------------- своё и общее — разное */

test('свою ячейку студент чистит, всю доску — нет', () => {
  /*
   * Иначе «стирать всё — преподавателю» запрещало бы студенту прибрать за
   * собой в собственной ячейке, чего никто не имел в виду.
   */
  const id = room({ wipe: 'host' })
  assert.equal(say(id, 'participant', { t: 'clearOutputs', cellId: 'c_nope' }), null)
  assert.match(say(id, 'participant', { t: 'clearOutputs' }) ?? '', /доск/i)
  assert.equal(say(id, 'host', { t: 'clearOutputs' }), null)
})

test('в лекционной комнате студент не чистит и свою ячейку', () => {
  // Вывод — часть тетради; правило про тетрадь распространяется и на него.
  const id = room({ edit: 'host' })
  assert.ok(say(id, 'participant', { t: 'clearOutputs', cellId: 'c_nope' }))
})

/* --------------------------------------------------------------- оболочка */

test('открыть и закрыть оболочку — не одно право', () => {
  /*
   * Открыть может любой: оболочка общая и в этом её смысл. Закрыть — то же, что
   * стереть расшифровку: гасит её тот, кто вправе стирать общее, иначе один
   * клик убирает у комнаты то, что она смотрела.
   */
  const id = room({})
  assert.equal(say(id, 'participant', { t: 'term:open' }), null)
  assert.equal(say(id, 'participant', { t: 'term:run', command: 'ls' }), null)
  assert.ok(say(id, 'participant', { t: 'term:close' }))
  assert.equal(say(id, 'host', { t: 'term:close' }), null)
})

/* ------------------------------------------------------------ состав и ядро */

test('«только дописывать» не даёт переставлять чужие ячейки', () => {
  // Переставить в никуда — обход запрета убирать, поэтому move идёт с remove.
  const id = room({ structure: 'add' })
  assert.match(
    say(id, 'participant', { t: 'cells:move', cellId: 'c_nope', direction: 1 }) ?? '',
    /порядок/i,
  )
  assert.equal(say(id, 'host', { t: 'cells:move', cellId: 'c_nope', direction: 1 }), null)
})

test('перезапуск ядра — правило, а не роль', () => {
  const strict = room({})
  assert.ok(say(strict, 'participant', { t: 'restart' }))
  // Комната, где работают вдвоём, вправе решить иначе.
  const open = room({ restart: 'room' })
  assert.equal(say(open, 'participant', { t: 'restart' }), null)
})

test('форматирование строже обоих соседей', () => {
  // black и переписывает каждую ячейку, и выполняется на общем ядре.
  assert.ok(say(room({ edit: 'host' }), 'participant', { t: 'format' }))
  assert.ok(say(room({ run: 'single' }), 'participant', { t: 'format' }))
  assert.equal(say(room({}), 'participant', { t: 'format' }), null)
})

/* ---------------------------------------------------- поведение, не право */

test('ответ на input() приходит от того, чья ячейка спрашивает', () => {
  /*
   * Приглашение живёт в документе, потому что его должна видеть комната. Видеть
   * и отвечать — разное, а `input()` под паролем тем более.
   */
  const id = room({})
  assert.match(say(id, 'participant', { t: 'input', value: 'пароль' }) ?? '', /чья ячейка/i)
  assert.equal(say(id, 'host', { t: 'input', value: 'да' }), null)
})

test('остановить может тот, чья ячейка считается, — или преподаватель', () => {
  // Правило старше правил комнаты и ими не управляется: ядро одно, и остановка
  // задевает того, чей код в нём сейчас.
  const id = room({})
  assert.match(say(id, 'participant', { t: 'interrupt' }) ?? '', /host/i)
  assert.equal(say(id, 'host', { t: 'interrupt' }), null)
})

/* ------------------------------------------------- и всё это при умолчаниях */

test('в комнате, где ничего не решали, студенту не отказывает ничто из его работы', () => {
  // Правило, которое отказывает всем, — не правило. Умолчание — это Colloq,
  // каким он был: работать в тетради и в оболочке может вся комната.
  const id = room({})
  const messages: ControlClientMessage[] = [
    { t: 'run', cellId: 'c_nope' },
    { t: 'runAll' },
    { t: 'runAbove', cellId: 'c_nope' },
    { t: 'clearOutputs', cellId: 'c_nope' },
    { t: 'format' },
    { t: 'term:open' },
    { t: 'term:run', command: 'ls' },
    { t: 'cells:move', cellId: 'c_nope', direction: 1 },
  ]
  for (const message of messages) {
    assert.equal(say(id, 'participant', message), null, `отказано на ${message.t}`)
  }
})

test('а разрушительное для всей комнаты — преподавательское с самого начала', () => {
  /*
   * Единственное место, где умолчание строже прежнего поведения, и это
   * намеренно. «Стереть все выводы» не спрашивало никого: одно нажатие
   * студента убирало с экрана всё, что комната насчитала за полтора часа, и
   * вернуть это нельзя ничем, кроме повторного запуска. Перезапуск ядра и
   * очистка расшифровки были преподавательскими и раньше.
   */
  const id = room({})
  for (const message of [
    { t: 'clearOutputs' },
    { t: 'restart' },
    { t: 'term:clear' },
  ] as ControlClientMessage[]) {
    assert.ok(say(id, 'participant', message), `${message.t} прошло у студента`)
    assert.equal(say(id, 'host', message), null, `${message.t} отказано преподавателю`)
  }
})
