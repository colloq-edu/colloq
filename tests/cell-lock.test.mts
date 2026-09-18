import { tr } from '../shared/i18n.js'
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
  cellLock,
  cloneCell,
  councilSettingsOf,
  DEFAULT_COUNCIL,
  createCell,
  findCell,
  isCellCouncil,
  isCellOpen,
  normalizeAttempt,
  openValueFor,
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

/** Преподаватель открыл консилиум: у каждого свой лист, общий текст закрыт. */
function council(server: Y.Doc, client: Y.Doc, i: number): void {
  server.transact(() => {
    cellAt(server, i).set('open', 'council')
    cellAt(server, i).set('council', { studentRun: true })
  }, 'server')
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

test('консилиум — третье положение того же ключа, и для набора он закрыт', () => {
  /*
   * Одно поле на три положения: двум полям пришлось бы договариваться, какое
   * главнее, когда выставлены оба. А `isCellOpen` отвечает строго на `true` —
   * иначе консилиум открыл бы общий текст тем самым пятистам человекам, ради
   * которых его и завели.
   */
  const { server } = pair()
  const cell = cellAt(server, 0)
  assert.equal(cellLock(cell), 'closed')
  cell.set('open', 'council')
  assert.equal(isCellOpen(cell), false, 'консилиум открыл общий текст')
  assert.equal(isCellCouncil(cell), true)
  assert.equal(cellLock(cell), 'council')
  // Ручки с умолчаниями на каждое поле отдельно: ключа нет — запуск студентам
  // выключен, имена на проекторе включены, регламент умолчаний. Сравнение с
  // `DEFAULT_COUNCIL` целиком, а не перечислением: ручка, добавленная завтра,
  // должна приезжать своим умолчанием, а не ронять эту строку.
  assert.deepEqual(councilSettingsOf(cell), DEFAULT_COUNCIL)
  cell.set('council', { studentRun: true })
  assert.deepEqual(councilSettingsOf(cell), { ...DEFAULT_COUNCIL, studentRun: true })
  const snap = readCell(cell)
  assert.equal(snap.open, false, 'снимок сказал «печатать можно»')
  assert.equal(snap.lock, 'council')
  assert.deepEqual(snap.council, { ...DEFAULT_COUNCIL, studentRun: true })
  // А вне консилиума ручек нет, какой бы мусор ни остался в ключе.
  cell.set('open', true)
  assert.equal(cellLock(cell), 'open')
  assert.equal(councilSettingsOf(cell), null)
  // И туда-обратно через имя положения — то, что пишет control.ts.
  assert.equal(openValueFor('council'), 'council')
  assert.equal(openValueFor('open'), true)
  assert.equal(openValueFor('closed'), null)
})

test('перестановка соседа не теряет консилиум и его ручки', () => {
  const { server } = pair()
  server.transact(() => {
    cellAt(server, 0).set('open', 'council')
    cellAt(server, 0).set('council', { studentRun: true, namesOnProjector: false })
    server.getArray(CELLS_KEY).push([cloneCell(cellAt(server, 0))])
  }, 'server')
  assert.equal(cellLock(cellAt(server, 2)), 'council')
  assert.deepEqual(councilSettingsOf(cellAt(server, 2)), {
    ...DEFAULT_COUNCIL,
    studentRun: true,
    namesOnProjector: false,
  })
})

test('ключ группы: одно решение, записанное по-разному', () => {
  // Пробелы, пустые строки и комментарии — не решение; кавычки — решение.
  assert.equal(normalizeAttempt('x = 1  # ответ\n\nprint( x )\n'), 'x=1\nprint(x)')
  assert.equal(normalizeAttempt('x=1\nprint(x)'), normalizeAttempt('x = 1\n# всё\nprint (x)'))
  assert.notEqual(normalizeAttempt('print("# нет")'), normalizeAttempt('print("")'))
  assert.equal(normalizeAttempt('   \n# только комментарий\n'), '')
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

test('консилиум кадром не открыть — и ручки его не повернуть', () => {
  // «Запуск студентам» — право, а не показания: ячейка, включившая его себе,
  // есть класс, разрешивший себе очередь к ядру.
  const first = pair()
  const lock = first.frame(() => cellAt(first.client, 0).set('open', 'council'))
  assert.match(passes(first.server, lock, LECTURE_ROOM, 'participant') ?? '', /ячейку открывает/)
  // Отвергнутый кадр сервер не видел, и следующий за ним продолжал бы нажатия,
  // которых у сервера нет, — поэтому вторая пара документов.
  const second = pair()
  const knob = second.frame(() => cellAt(second.client, 1).set('council', { studentRun: true }))
  assert.match(passes(second.server, knob, OPEN_ROOM, 'host') ?? '', /ячейку открывает/)
})

test('в консилиуме общий текст закрыт, как в закрытой ячейке', () => {
  /*
   * Это и есть правило первое: у каждого свой лист. Попытка едет снимком по
   * управляющему сокету, а кадр в общий Y.Text от участника — отказ той же
   * фразой, что и у закрытой: для гейта консилиум ничем от неё не отличается.
   */
  const { server, client, frame } = pair()
  council(server, client, 0)
  const bytes = frame(() => typing(client, 0))
  const judged = classify(server, bytes)
  assert.ok(judged.ok)
  assert.deepEqual(
    judged.verdicts.map((v) => `${v.rule}:${v.open === true}`),
    ['edit:false'],
  )
  assert.match(passes(server, bytes, LECTURE_ROOM, 'participant') ?? '', /преподавател/i)
  // Преподаватель печатает в общий текст: «Показать классу» — это его правка.
  assert.equal(passes(server, bytes, LECTURE_ROOM, 'host'), null)
})

test('ячейка, принесённая с консилиумом, приезжает закрытой и без ручек', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => {
    const made = createCell('code', 'моё', 'c8')
    made.set('open', 'council')
    made.set('council', { studentRun: true })
    client.getArray(CELLS_KEY).push([made])
  })
  assert.equal(passes(server, bytes, OPEN_ROOM, 'participant'), null, 'кадр не приняли')
  Y.applyUpdate(server, bytes)
  server.transact(() => settleFresh('lock-room', server, ['c8']), 'server')
  const landed = findCell(server, 'c8')
  assert.ok(landed, 'ячейка не доехала')
  assert.equal(cellLock(landed.cell), 'closed', 'консилиум пережил приведение к чистой')
  assert.equal(landed.cell.get('council') ?? null, null, 'ручки пережили приведение к чистой')
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
    tr(CLASS_IS_OVER),
    'открытая ячейка пережила конец занятия',
  )
  // А преподаватель после пары печатает: комната остаётся живой.
  assert.equal(passes(server, bytes, after, 'host', true), null)
})
