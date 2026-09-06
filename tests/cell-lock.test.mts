/**
 * Замок на ячейке: лекция, в которой открыты отдельные ячейки.
 *
 * Тетрадь лекции закрыта целиком, и единственная дверь в ней — ячейка, которую
 * преподаватель открыл сам. Дверь узкая по устройству: в неё проходит набор и
 * ничего больше. Ошибка здесь не видна ни на экране, ни в логе — она либо
 * запирает класс в комнате, где ему как раз разрешили печатать, либо отдаёт ему
 * всю тетрадь по одной открытой ячейке.
 *
 * Кадры настоящие: два документа и байты между ними, как в crdt-gate. Замок
 * ставится серверным тактом, потому что ставит его только сервер.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { classify, permits } from '../server/src/collab/gate.js'
import {
  CELLS_KEY,
  META_KEY,
  cloneCell,
  createCell,
  findCell,
  isCellOpen,
  readCell,
} from '../shared/notebook.js'
import { settleFresh } from '../server/src/collab/ops.js'
import {
  CLASS_IS_OVER,
  LECTURE_ROOM,
  OPEN_ROOM,
  rulesAfterClass,
  type RoomRules,
} from '../shared/rules.js'

function pair(): { server: Y.Doc; client: Y.Doc; frame: (write: () => void) => Uint8Array } {
  const server = new Y.Doc()
  const client = new Y.Doc()
  server.transact(() => {
    server.getMap(META_KEY).set('title', 'Лекция')
    server
      .getArray(CELLS_KEY)
      .push([createCell('code', 'print(1)', 'c1'), createCell('code', 'print(2)', 'c2')])
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
    assert.ok(captured, 'транзакция не дала обновления')
    return captured
  }
  return { server, client, frame }
}

function cellAt(doc: Y.Doc, i: number): Y.Map<any> {
  return doc.getArray(CELLS_KEY).get(i) as Y.Map<any>
}

/** Преподаватель открыл ячейку. Пишет сервер — иначе это и не замок. */
function unlock(server: Y.Doc, client: Y.Doc, i: number): void {
  server.transact(() => cellAt(server, i).set('open', true), 'server')
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
}

/** Прошёл бы этот кадр в такой комнате от такого человека. `null` — прошёл. */
function passes(
  server: Y.Doc,
  bytes: Uint8Array,
  rules: RoomRules,
  role: 'host' | 'participant',
  finished = false,
): string | null {
  const judged = classify(server, bytes)
  if (!judged.ok) return judged.why
  const verdict = permits(judged.verdicts, rules, role, finished)
  return verdict.ok ? null : verdict.message
}

const typing = (client: Y.Doc, i: number): void => {
  ;(cellAt(client, i).get('source') as Y.Text).insert(0, 'ы')
}

/* ------------------------------------------------------------------ модель */

test('замка нет — ячейка закрыта; и `false` тоже закрыта', () => {
  // Ключа нет у всякой ячейки, которой преподаватель не касался, и у всякой
  // тетради, написанной до лекций. Это один и тот же случай, и он закрытый.
  const { server } = pair()
  const cell = cellAt(server, 0)
  assert.equal(isCellOpen(cell), false)
  cell.set('open', false)
  assert.equal(isCellOpen(cell), false)
  cell.set('open', true)
  assert.equal(isCellOpen(cell), true)
  assert.equal(readCell(cell).open, true, 'снимок ячейки не рассказывает про замок')
})

test('перестановка соседа не захлопывает открытую ячейку', () => {
  /*
   * `moveInCells` пересоздаёт соседку клоном, и всё, что клон забыл, у неё
   * пропадает. Забытый замок — это ячейка, которая закрылась под руками у
   * печатающей комнаты, из-за того что кто-то подвинул соседнюю строку.
   */
  const { server } = pair()
  server.transact(() => {
    cellAt(server, 0).set('open', true)
    // Клон читается уже в документе: у ещё не вставленной Y.Map `get` молчит.
    const cells = server.getArray(CELLS_KEY)
    cells.push([cloneCell(cellAt(server, 0)), cloneCell(cellAt(server, 1))])
  }, 'server')
  assert.equal(isCellOpen(cellAt(server, 2)), true)
  // А у закрытой клон ключа не заводит: пустой ключ на каждой перестановке —
  // такт в документе и запись на диск ни за чем.
  assert.equal(cellAt(server, 3).get('open') ?? null, null)
})

/* -------------------------------------------------------------------- гейт */

test('набор в открытой ячейке — правка, у которой замок снят', () => {
  const { server, client, frame } = pair()
  unlock(server, client, 0)
  const judged = classify(
    server,
    frame(() => typing(client, 0)),
  )
  assert.equal(judged.ok, true)
  if (!judged.ok) return
  assert.deepEqual(
    judged.verdicts.map((v) => `${v.rule}:${v.open === true}`),
    ['edit:true'],
  )
})

test('набор в закрытой ячейке — правка без замка, как и была', () => {
  const { server, client, frame } = pair()
  unlock(server, client, 0)
  const judged = classify(
    server,
    frame(() => typing(client, 1)),
  )
  assert.equal(judged.ok, true)
  if (!judged.ok) return
  assert.deepEqual(
    judged.verdicts.map((v) => `${v.rule}:${v.open === true}`),
    ['edit:false'],
    'замок соседней ячейки достался этой',
  )
})

test('открыть ячейку кадром нельзя — ни участнику, ни преподавателю', () => {
  /*
   * Это право, а не показания: ячейка, открывшая себя сама, — участник,
   * разрешивший себе печатать в закрытой тетради. Преподавателю отказано тем
   * же отказом, и это не строгость: открывает он управляющим сообщением, где
   * спрашивают роль, а не кадром, где роль ни при чём.
   */
  const { server, client, frame } = pair()
  const bytes = frame(() => cellAt(client, 0).set('open', true))
  assert.match(passes(server, bytes, LECTURE_ROOM, 'participant') ?? '', /ячейку открывает/)
  assert.match(passes(server, bytes, OPEN_ROOM, 'host') ?? '', /ячейку открывает/)
})

test('снять замок кадром тоже нельзя', () => {
  const { server, client, frame } = pair()
  unlock(server, client, 0)
  const bytes = frame(() => cellAt(client, 0).set('open', false))
  assert.match(
    passes(server, bytes, LECTURE_ROOM, 'participant') ?? '',
    /ячейку открывает/,
    'замок сняли из браузера',
  )
})

test('ячейка, принесённая с замком, приезжает закрытой', () => {
  /*
   * «Добавлять можно» не должно читаться как «печатать можно везде»:
   * достаточно принести ячейку, уже открытую самой себе. Но и отказывать
   * нельзя — тем же кадром приходит Ctrl+Z преподавателя, отменяющий удаление
   * открытой ячейки, и он получал бы перезагрузку вкладки за своё же
   * движение. Поэтому кадр принимается, а замок снимает сервер.
   */
  const { server, client, frame } = pair()
  const bytes = frame(() => {
    const made = createCell('code', 'моё', 'c9')
    made.set('open', true)
    client.getArray(CELLS_KEY).push([made])
  })
  assert.equal(passes(server, bytes, OPEN_ROOM, 'participant'), null, 'кадр не приняли')
  Y.applyUpdate(server, bytes)
  server.transact(() => settleFresh('lock-room', server, ['c9']), 'server')
  const landed = findCell(server, 'c9')
  assert.ok(landed, 'ячейка не доехала')
  assert.equal(isCellOpen(landed.cell), false, 'замок пережил приведение к чистой')
})

/* ------------------------------------------------------------ что даёт дверь */

test('в лекции комната печатает в открытой ячейке и молчит в закрытой', () => {
  const { server, client, frame } = pair()
  unlock(server, client, 0)

  const inside = frame(() => typing(client, 0))
  assert.equal(passes(server, inside, LECTURE_ROOM, 'participant'), null, 'дверь не открылась')
  Y.applyUpdate(server, inside)

  const outside = frame(() => typing(client, 1))
  assert.match(
    passes(server, outside, LECTURE_ROOM, 'participant') ?? '',
    /преподавател/i,
    'открытая ячейка открыла всю тетрадь',
  )
})

test('в открытой ячейке стирают так же, как печатают', () => {
  /*
   * Backspace — это удаление, а удаления гейт судит другим путём, чем вставки:
   * по набору удалений, снизу вверх до самого внешнего удаляемого предка. Замок
   * обязан найтись и там, иначе открытая ячейка принимает набор и отвергает
   * возврат — то есть ломается на первой же опечатке.
   */
  const { server, client, frame } = pair()
  unlock(server, client, 0)
  const bytes = frame(() => (cellAt(client, 0).get('source') as Y.Text).delete(0, 3))
  assert.equal(passes(server, bytes, LECTURE_ROOM, 'participant'), null, 'стереть своё не дали')
})

test('открытая ячейка не даёт убрать себя', () => {
  const { server, client, frame } = pair()
  unlock(server, client, 0)
  const bytes = frame(() => client.getArray(CELLS_KEY).delete(0, 1))
  assert.match(passes(server, bytes, LECTURE_ROOM, 'participant') ?? '', /убирает/)
})

test('открытая ячейка не даёт переставить себя', () => {
  // Перестановка в браузере — это удаление и вставка копии, то есть состав
  // тетради. Иначе «переставить в никуда» было бы способом убрать ячейку,
  // которую убирать нельзя.
  const { server, client, frame } = pair()
  unlock(server, client, 0)
  const bytes = frame(() => {
    const cells = client.getArray(CELLS_KEY)
    cells.delete(0, 1)
    cells.insert(1, [createCell('code', 'print(1)', 'c1')])
  })
  assert.match(
    passes(server, bytes, LECTURE_ROOM, 'participant') ?? '',
    /добавляет|убирает/,
    'ячейку переставили в лекции',
  )
})

test('открытая ячейка не даёт сменить себе вид', () => {
  // Ячейка, ставшая заметкой, теряет вывод и «In [7]» — это состав тетради, а
  // он в лекции преподавательский. Дверь открыта для набора, а не для правки
  // тетради изнутри одной ячейки.
  const { server, client, frame } = pair()
  unlock(server, client, 0)
  const bytes = frame(() => cellAt(client, 0).set('type', 'markdown'))
  assert.match(passes(server, bytes, LECTURE_ROOM, 'participant') ?? '', /преподавател/i)
})

test('преподавателю открытая ячейка ничего не меняет: он и так пишет везде', () => {
  const { server, client, frame } = pair()
  unlock(server, client, 0)
  assert.equal(
    passes(
      server,
      frame(() => typing(client, 1)),
      LECTURE_ROOM,
      'host',
    ),
    null,
  )
})

/* ------------------------------------------------------------ конец занятия */

test('в законченном занятии открытая ячейка закрыта вместе со всей тетрадью', () => {
  /*
   * Иначе «Закончить занятие» оставляло бы комнате столько дверей, сколько
   * преподаватель успел открыть за пару, и закрывать их пришлось бы по одной,
   * вспоминая, какие открывал.
   */
  const { server, client, frame } = pair()
  unlock(server, client, 0)
  const bytes = frame(() => typing(client, 0))
  // Правила приезжают в гейт действующими — после конца пары преподавательскими.
  const after = rulesAfterClass(LECTURE_ROOM)
  assert.equal(
    passes(server, bytes, after, 'participant', true),
    CLASS_IS_OVER,
    'открытая ячейка пережила конец занятия',
  )
  // А преподаватель после пары печатает: комната остаётся живой.
  assert.equal(passes(server, bytes, after, 'host', true), null)
})
