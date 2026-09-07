/**
 * Номера в очереди консилиума — одним проходом, и именно они едут в листы.
 *
 * Очередь дёргается дважды на каждую работу ядра, а ждущих на паре столько же,
 * сколько людей. Раньше `tellQueued` спрашивал номер поштучно — поиск по всей
 * очереди на каждого её участника, — и второй раз то же самое делал `mineMessage`
 * внутри листа: два квадрата на один сдвиг. Теперь номера считаются разом
 * (`kernel/index.ts · councilQueuePositions`) и передаются в лист готовыми.
 *
 * Проверяется не скорость, а то, ради чего скорость меняли: число в листе —
 * то же самое, что даёт массовый счёт, и оно по-прежнему двигается, когда
 * впереди снимают ячейку.
 *
 * Ни сети, ни ядра: сокеты поддельные, комната настоящая, диспетчер тот же, что
 * слушает провод.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { createSession, setRules, upsertParticipant } from '../server/src/db.js'
import { closeControlRoom, dispatch, handleControlSocket } from '../server/src/control.js'
import { councilQueuePositions } from '../server/src/kernel/index.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { cellId, createCell, getCells } from '../shared/notebook.js'
import { LECTURE_ROOM } from '../shared/rules.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'

interface Person {
  payload: TokenPayload
  heard: ControlServerMessage[]
  ws: WebSocket
}

function join(
  sessionId: string,
  participantId: string,
  name: string,
  role: 'host' | 'participant',
): Person {
  upsertParticipant({ id: participantId, sessionId, name, avatar: null, role })
  const heard: ControlServerMessage[] = []
  const fake = {
    readyState: WebSocket.OPEN as number,
    send(frame: unknown) {
      if (typeof frame === 'string') heard.push(JSON.parse(frame) as ControlServerMessage)
    },
    on() {
      return this
    },
    ping() {},
    terminate() {},
    close() {
      fake.readyState = WebSocket.CLOSED
    },
  }
  const ws = fake as unknown as WebSocket
  const payload: TokenPayload = { sessionId, participantId, role }
  handleControlSocket(ws, sessionId, payload)
  return { payload, heard, ws }
}

test('номер в листе — тот, что дал массовый счёт, и он двигается вместе с очередью', async () => {
  const id = 'queue-bulk-1'
  createSession(id, 'Консилиум', null)
  setRules(id, { ...LECTURE_ROOM })
  const { doc } = getSessionDoc(id)
  const task = createCell('code', '# задание: посчитайте x')
  const plain = createCell('code', 'x = 1')
  doc.transact(() => getCells(doc).push([task, plain]))
  const cell = cellId(task)

  const teacher = join(id, `${id}_t`, 'Ада', 'host')
  const class_ = [0, 1, 2].map((i) => join(id, `${id}_s${i}`, `Студент ${i}`, 'participant'))

  const say = (who: Person, message: ControlClientMessage): string | null => {
    const before = who.heard.length
    dispatch(who.ws, id, who.payload, message)
    const error = who.heard.slice(before).find((m) => m.t === 'error')
    return error && error.t === 'error' ? error.message : null
  }

  assert.equal(
    say(teacher, {
      t: 'cell:lock',
      cellId: cell,
      state: 'council',
      settings: { studentRun: true },
    }),
    null,
  )

  // Ячейка преподавателя встала в очередь первой — все три попытки за ней.
  assert.equal(say(teacher, { t: 'run', cellId: cellId(plain) }), null)
  for (const [i, student] of class_.entries()) {
    assert.equal(say(student, { t: 'council:draft', cellId: cell, text: `x = ${i}` }), null)
    assert.equal(say(student, { t: 'council:run', cellId: cell }), null)
  }

  /** Последний номер, который этот человек видел в своём листе. */
  const queue = (who: Person): number | null | 'кадра нет' => {
    const m = [...who.heard].reverse().find((x) => x.t === 'council:mine' && x.cellId === cell)
    return m && m.t === 'council:mine' ? m.state.queue : 'кадра нет'
  }

  const bulk = (who: Person): number | undefined =>
    councilQueuePositions(id).find(
      (item) => item.cellId === cell && item.participantId === who.payload.participantId,
    )?.position

  // Массовый счёт видит всех троих по порядку — и ячейку преподавателя впереди.
  assert.deepEqual(class_.map(bulk), [2, 3, 4], 'массовый счёт разошёлся с очередью')
  // И ровно эти числа приехали в листы: лист берёт готовый номер, а не считает
  // его заново.
  assert.deepEqual(class_.map(queue), [2, 3, 4], 'в лист поехал не тот номер, что посчитан разом')

  // Ячейку сняли — впереди никого, и каждому уехал НОВЫЙ номер, хотя ни одного
  // события консилиума не произошло.
  assert.equal(say(teacher, { t: 'cancel', cellId: cellId(plain) }), null)
  await sleep(400)
  assert.deepEqual(class_.map(bulk), [1, 2, 3])
  assert.deepEqual(
    class_.map(queue),
    [1, 2, 3],
    'после сдвига очереди номера в листах остались старыми',
  )

  closeControlRoom(id)
})

test('рассылка номеров не ищет в очереди на каждого ждущего', () => {
  /*
   * Числа выше сойдутся и при поштучном поиске — он даёт тот же ответ, только
   * дороже. Поэтому здесь читается сам текст рассылки: в теле `tellQueued`
   * поштучного `councilQueuePosition` быть не должно ни на прямой строке, ни
   * внутри листа (номер уезжает в `mineOut` готовым), а `councilQueued`,
   * который отдавал ждущих без номеров, не нужен во всём сервере.
   */
  const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
  const source = fs.readFileSync(path.join(root, 'server/src/control.ts'), 'utf8')

  const from = source.indexOf('function tellQueued(')
  assert.ok(from > 0, 'в control.ts не нашлось tellQueued')
  const to = source.indexOf('\n}\n', from)
  const body = source.slice(from, to)

  assert.match(body, /councilQueuePositions\(sessionId\)/, 'номера считаются не одним проходом')
  assert.doesNotMatch(
    body.replace(/councilQueuePositions/g, ''),
    /councilQueuePosition\(/,
    'номер снова ищется в очереди на каждого ждущего',
  )
  assert.match(body, /mineOut\([^)]*position\)/, 'лист не получил готовый номер и посчитает свой')
  assert.equal(
    /\bcouncilQueued\b/.test(source),
    false,
    'councilQueued больше ничей — его незачем звать',
  )
})
