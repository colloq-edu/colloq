/**
 * Присутствие одной ячейки: редактор видит только тех, кто стоит в НЕЙ.
 *
 * `yCollab` получал присутствие комнаты целиком, и его плагин чужих кареток на
 * ЛЮБОЙ чужой кадр диспатчил транзакцию в свой редактор, а потом обходил все
 * состояния и резолвил по две относительные позиции на каждый курсор. В тетради
 * смонтировано десять–двадцать пять редакторов, так что один чужой курсор стоил
 * «редакторы × состояния». Здесь проверяется, что вид отдаёт только своих, что
 * обход общий на присутствие (а не на редактор), что кадр вообще не приходит,
 * если в этой ячейке ничего не изменилось, — и что уход СЧИТАЕТСЯ изменением:
 * выбывший обязан приехать в `removed`.
 *
 * Ломается всё это молча: без сравнения снимков лишний кадр просто «немного
 * дороже», с неверным фильтром чужая каретка перестаёт рисоваться вовсе, а без
 * `removed` она, наоборот, остаётся нарисованной в покинутой ячейке — плагин
 * диспатчит транзакцию только на кадр, в котором есть хоть один чужой клиент.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { cellAwareness, type AwarenessDiff } from '../web/src/components/notebook/cell-awareness.js'

/** Склейка кадров — вручную: рамки отрисовки в node не наступает. */
function manualSchedule() {
  const queue: (() => void)[] = []
  const schedule = (run: () => void) => {
    queue.push(run)
    return () => {
      const at = queue.indexOf(run)
      if (at >= 0) queue.splice(at, 1)
    }
  }
  const flush = () => {
    const pending = queue.splice(0, queue.length)
    for (const run of pending) run()
  }
  return { schedule, flush, get size() { return queue.length } }
}

/*
 * Присутствие держит свой таймер устаревания, а документ — память: без уборки
 * файл теста не завершается вовсе. Тот же порядок, что и в самом компоненте.
 */
const opened: { doc: Y.Doc; awareness: Awareness }[] = []
after(() => {
  for (const { doc, awareness } of opened) {
    awareness.destroy()
    doc.destroy()
  }
})

function room() {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  awareness.setLocalStateField('user', { id: 'me', name: 'Я', color: '#fff', activeCellId: 'c1' })
  opened.push({ doc, awareness })
  return { doc, awareness }
}

/** Чужой клиент в общем присутствии — так, как его туда кладёт сеть. */
function peer(
  awareness: Awareness,
  clientId: number,
  activeCellId: string | null,
  cursor: unknown = { anchor: { item: clientId }, head: { item: clientId } },
): void {
  const states = awareness.getStates()
  states.set(clientId, {
    user: { id: `p${clientId}`, name: `P${clientId}`, color: '#0f0', activeCellId },
    cursor,
  })
  awareness.emit('change', [{ added: [clientId], updated: [], removed: [] }, 'test'])
}

/** Вкладка закрылась: присутствие выкидывает состояние и говорит `removed`. */
function leave(awareness: Awareness, clientId: number): void {
  awareness.getStates().delete(clientId)
  awareness.emit('change', [{ added: [], updated: [], removed: [clientId] }, 'test'])
}

/** То самое условие, по которому плагин чужих кареток решает диспатчить. */
function wakesEditor(diff: AwarenessDiff, self: number): boolean {
  const clients = diff.added.concat(diff.updated).concat(diff.removed)
  return clients.findIndex((id) => id !== self) >= 0
}

test('вид ячейки показывает своих и себя, а чужих не показывает', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  peer(awareness, 2, 'c1')
  peer(awareness, 3, 'c2')
  peer(awareness, 4, null)

  const view = cellAwareness(awareness, 'c1', clock.schedule)
  const states = view.getStates()
  assert.deepEqual([...states.keys()].sort((a, b) => a - b), [awareness.clientID, 2].sort((a, b) => a - b))
  // Локальное состояние остаётся на месте: свой курсор объявляется по-прежнему
  // в настоящее присутствие, вид только читает.
  assert.equal(view.getLocalState()?.user !== undefined, true)
  assert.equal(view.clientID, awareness.clientID)
  view.destroy()
})

test('человек без объявленной ячейки в вид не попадает', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  peer(awareness, 7, null)
  const view = cellAwareness(awareness, 'c1', clock.schedule)
  assert.deepEqual([...view.getStates().keys()], [awareness.clientID])
  view.destroy()
})

test('чужой курсор в ДРУГОЙ ячейке кадра не даёт', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  const view = cellAwareness(awareness, 'c1', clock.schedule)
  let frames = 0
  view.on('change', () => (frames += 1))

  peer(awareness, 5, 'c2')
  clock.flush()
  assert.equal(frames, 0, 'сосед печатает в другой ячейке — этому редактору всё равно')

  peer(awareness, 6, 'c1')
  clock.flush()
  assert.equal(frames, 1, 'а тот, кто встал сюда, обязан появиться')
  view.destroy()
})

test('движение курсора в своей ячейке — кадр; повтор того же — нет', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  const view = cellAwareness(awareness, 'c1', clock.schedule)
  let frames = 0
  view.on('change', () => (frames += 1))

  peer(awareness, 8, 'c1', { anchor: { item: 1 }, head: { item: 1 } })
  clock.flush()
  assert.equal(frames, 1)

  // Присутствие раскодирует состояния заново на каждый тик, поэтому объект
  // всегда новый: сравнение по ссылке дало бы кадр на ровном месте.
  peer(awareness, 8, 'c1', { anchor: { item: 1 }, head: { item: 1 } })
  clock.flush()
  assert.equal(frames, 1, 'то же положение — нечего перерисовывать')

  peer(awareness, 8, 'c1', { anchor: { item: 4 }, head: { item: 9 } })
  clock.flush()
  assert.equal(frames, 2, 'каретка поехала — кадр')
  view.destroy()
})

test('десять кадров подряд склеиваются в один обход', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  const view = cellAwareness(awareness, 'c1', clock.schedule)
  let frames = 0
  view.on('change', () => (frames += 1))

  for (let i = 0; i < 10; i++) peer(awareness, 20 + i, 'c1')
  assert.equal(clock.size, 1, 'обход отложен ровно один, а не десять')
  clock.flush()
  assert.equal(frames, 1)
  assert.equal(view.getStates().size, 11)
  view.destroy()
})

test('двадцать пять редакторов делят один обход присутствия', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  const views = Array.from({ length: 25 }, (_, i) => cellAwareness(awareness, `c${i}`, clock.schedule))
  const seen = views.map(() => 0)
  views.forEach((view, index) => view.on('change', () => (seen[index] += 1)))

  peer(awareness, 99, 'c7')
  assert.equal(clock.size, 1, 'обход один на присутствие, а не по одному на редактор')
  clock.flush()
  assert.deepEqual(
    seen.map((count, index) => (count > 0 ? index : -1)).filter((index) => index >= 0),
    [7],
    'разбудить обязано ровно ту ячейку, в которую встали',
  )
  for (const view of views) view.destroy()
})

test('вид отпускает присутствие: после destroy слушателей не остаётся', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  const view = cellAwareness(awareness, 'c1', clock.schedule)
  const handler = () => {}
  view.on('change', handler)
  // `listenerCount` есть не у всякой сборки y-protocols, поэтому спрашивается
  // через необязательный вызов: где его нет, проверять нечего.
  const observed = awareness as unknown as { listenerCount?: (name: string) => number }
  assert.ok((observed.listenerCount?.('change') ?? 1) > 0)
  view.destroy()
  peer(awareness, 42, 'c1')
  // Ничего не отложено: подписка на присутствие снята вместе с последним видом.
  assert.equal(clock.size, 0)
})

test('сосед ушёл в другую ячейку — кадр несёт его в removed', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  const view = cellAwareness(awareness, 'c1', clock.schedule)
  const frames: AwarenessDiff[] = []
  view.on('change', (diff) => frames.push(diff))

  peer(awareness, 11, 'c1')
  clock.flush()
  assert.deepEqual(frames.at(-1), { added: [11], updated: [], removed: [] })

  // Перешёл в соседнюю ячейку: здесь его больше нет — и кадр обязан это сказать
  // словом, а не пустотой, иначе каретка с его именем останется висеть.
  peer(awareness, 11, 'c2')
  clock.flush()
  assert.deepEqual(frames.at(-1), { added: [], updated: [], removed: [11] })
  assert.equal(wakesEditor(frames.at(-1)!, awareness.clientID), true)
  assert.deepEqual([...view.getStates().keys()], [awareness.clientID])
  view.destroy()
})

test('вкладка соседа закрылась — снимают его одного, остальных не трогают', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  const view = cellAwareness(awareness, 'c1', clock.schedule)
  const frames: AwarenessDiff[] = []
  view.on('change', (diff) => frames.push(diff))

  peer(awareness, 12, 'c1')
  peer(awareness, 13, 'c1')
  clock.flush()
  assert.deepEqual(frames.at(-1), { added: [12, 13], updated: [], removed: [] })

  leave(awareness, 13)
  clock.flush()
  // Двенадцатый не двигался — в `updated` ему делать нечего.
  assert.deepEqual(frames.at(-1), { added: [], updated: [], removed: [13] })
  assert.equal(wakesEditor(frames.at(-1)!, awareness.clientID), true)
  assert.deepEqual([...view.getStates().keys()].sort((a, b) => a - b), [awareness.clientID, 12].sort((a, b) => a - b))
  view.destroy()
})

test('движение стоящего — updated, а не повторное added', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  const view = cellAwareness(awareness, 'c1', clock.schedule)
  const frames: AwarenessDiff[] = []
  view.on('change', (diff) => frames.push(diff))

  peer(awareness, 14, 'c1', { anchor: { item: 1 }, head: { item: 1 } })
  clock.flush()
  peer(awareness, 14, 'c1', { anchor: { item: 5 }, head: { item: 7 } })
  clock.flush()
  assert.deepEqual(frames.at(-1), { added: [], updated: [14], removed: [] })
  view.destroy()
})

test('последний ушёл из ячейки, где никого не осталось, — кадр всё равно приходит', () => {
  const { awareness } = room()
  const clock = manualSchedule()
  // Два вида на одну ячейку: так же, как два смонтированных редактора одной
  // ячейки (перестройка компонента). Дифф у каждого свой, но одинаковый.
  const first = cellAwareness(awareness, 'c1', clock.schedule)
  peer(awareness, 15, 'c1')
  clock.flush()
  const second = cellAwareness(awareness, 'c1', clock.schedule)
  const seenFirst: AwarenessDiff[] = []
  const seenSecond: AwarenessDiff[] = []
  first.on('change', (diff) => seenFirst.push(diff))
  second.on('change', (diff) => seenSecond.push(diff))

  leave(awareness, 15)
  clock.flush()
  assert.deepEqual(seenFirst, [{ added: [], updated: [], removed: [15] }])
  assert.deepEqual(seenSecond, [{ added: [], updated: [], removed: [15] }])
  first.destroy()
  second.destroy()
})
