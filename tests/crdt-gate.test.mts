/**
 * Разбор входящего кадра на глаголы — до применения.
 *
 * Тест здесь не формальность: гейт целиком построен на свойствах Yjs, которые
 * не следуют из документации, а измеряются. Родитель приходит на проводе в
 * трёх видах и чаще всего отсутствует; удаление одной ячейки задевает два
 * клиента; браузер при каждой перезагрузке заново предлагает серверу весь свой
 * документ. Ошибка в любом из этих мест выглядит как работающий гейт — и
 * запирает комнату при разрешающих правилах или пропускает подделку.
 *
 * Поэтому кадры здесь настоящие: два документа, обмен байтами между ними,
 * никаких вручную собранных структур.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { classify, MAX_SYNC_FRAME_BYTES } from '../server/src/collab/gate.js'
import { rememberDeleted, rememberedIn, settleFresh } from '../server/src/collab/ops.js'
import { CELLS_KEY, CHAT_KEY, META_KEY, TERMINAL_KEY } from '../shared/notebook.js'

/** Сервер и браузер: два документа, синхронные на старте. */
/** Имя комнаты — сервер помнит удаления по семинарам. */
const ROOM = 'gate-test'

function pair(): { server: Y.Doc; client: Y.Doc; frame: (write: () => void) => Uint8Array } {
  const server = new Y.Doc()
  const client = new Y.Doc()

  const cells = server.getArray(CELLS_KEY)
  server.transact(() => {
    server.getMap(META_KEY).set('title', 'Семинар')
    cells.push([cell('c1', 'print(1)')])
    cells.push([cell('c2', 'print(2)')])
  })
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))

  /** Байты, которые браузер отправил бы серверу за одну транзакцию. */
  const frame = (write: () => void): Uint8Array => {
    let captured: Uint8Array | null = null
    const grab = (update: Uint8Array): void => {
      captured = captured ? Y.mergeUpdates([captured, update]) : update
    }
    client.on('update', grab)
    client.transact(write)
    client.off('update', grab)
    assert.ok(captured, 'транзакция не дала обновления')
    return captured
  }

  return { server, client, frame }
}

function cell(id: string, source: string): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  map.set('id', id)
  map.set('type', 'code')
  const text = new Y.Text()
  text.insert(0, source)
  map.set('source', text)
  map.set('outputs', new Y.Array())
  map.set('state', 'idle')
  map.set('execCount', null)
  map.set('runBy', null)
  map.set('runById', null)
  map.set('startedAt', null)
  map.set('ranMs', null)
  return map
}

function cellAt(doc: Y.Doc, i: number): Y.Map<unknown> {
  return doc.getArray(CELLS_KEY).get(i) as Y.Map<unknown>
}

function ok(judgement: ReturnType<typeof classify>): { verdicts: { rule: string; verb?: string; cellId: string | null }[]; retyped: string[] } {
  assert.equal(judgement.ok, true, judgement.ok ? '' : `отказ: ${judgement.why} (${judgement.path})`)
  if (!judgement.ok) throw new Error('unreachable')
  return judgement
}

function refused(judgement: ReturnType<typeof classify>): string {
  assert.equal(judgement.ok, false, 'кадр прошёл, а не должен был')
  return judgement.ok ? '' : judgement.why
}

/* ------------------------------------------------------------- обычная жизнь */

test('нажатие в тексте ячейки — это правка, и ничего больше', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => (cellAt(client, 0).get('source') as Y.Text).insert(8, '0'))
  const { verdicts } = ok(classify(server, bytes))
  assert.deepEqual(
    verdicts.map((v) => v.rule),
    ['edit'],
  )
  assert.equal(verdicts[0].cellId, 'c1', 'правку не привязали к ячейке')
})

test('новая ячейка — это один приговор о составе тетради', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getArray(CELLS_KEY).push([cell('c3', 'x = 1')]))
  const { verdicts } = ok(classify(server, bytes))
  assert.deepEqual(new Set(verdicts.map((v) => `${v.rule}/${v.verb ?? ''}`)), new Set(['structure/add']))
})

test('удаление ячейки, которая считалась, — тоже один приговор', () => {
  /*
   * Здесь ломается очевидное правило «взять внешний элемент диапазона».
   * Удаление посчитавшей ячейки даёт диапазоны под ДВУМЯ клиентами: кроме
   * браузера, свой такт есть у сервера, писавшего outputs и state. Внутри
   * серверного диапазона внешний элемент — запись вывода, которую пол
   * объявляет серверной; по тому правилу любое законное удаление посчитавшей
   * ячейки отказывалось бы в любой комнате.
   */
  const { server, client, frame } = pair()
  // Сервер пишет вывод — своим тактом, как это делает ядро.
  server.transact(() => {
    const map = cellAt(server, 0)
    const outputs = map.get('outputs') as Y.Array<unknown>
    const out = new Y.Map<unknown>()
    out.set('kind', 'stream')
    out.set('name', 'stdout')
    out.set('text', new Y.Text('1\n'))
    outputs.push([out])
    map.set('state', 'ok')
    map.set('execCount', 1)
    map.set('ranMs', 12)
  }, 'server')
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))

  const bytes = frame(() => client.getArray(CELLS_KEY).delete(0, 1))
  const { verdicts } = ok(classify(server, bytes))
  assert.deepEqual(
    verdicts.map((v) => `${v.rule}/${v.verb ?? ''}`),
    ['structure/remove'],
    'вложенное не поглотилось — приговоров больше одного',
  )
  assert.equal(verdicts[0].cellId, 'c1')
})

test('смена вида ячейки — правка, и сервер узнаёт, какую сбросить', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => cellAt(client, 0).set('type', 'markdown'))
  const { verdicts, retyped } = ok(classify(server, bytes))
  assert.deepEqual(verdicts.map((v) => v.rule), ['edit'])
  assert.deepEqual(retyped, ['c1'], 'сервер не узнает, чьё состояние выполнения сбрасывать')
})

test('заголовок семинара — отдельное правило', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getMap(META_KEY).set('title', 'Другое имя'))
  const { verdicts } = ok(classify(server, bytes))
  assert.deepEqual(verdicts.map((v) => v.rule), ['title'])
})

/* ------------------------------------------------------------ то, ради чего */

test('подделать чужой вывод нельзя ни в какой комнате', () => {
  // Это `text/html`, гасящий экран всему семинару, и он приходил как обычный кадр.
  const { server, client, frame } = pair()
  const bytes = frame(() => {
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ 'text/html': '<script>…' }))
    ;(cellAt(client, 0).get('outputs') as Y.Array<unknown>).push([out])
  })
  assert.match(refused(classify(server, bytes)), /сервер/)
})

test('поддельное приглашение ввести пароль не проходит', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => cellAt(client, 0).set('stdin', { prompt: 'Пароль:', password: true }))
  assert.match(refused(classify(server, bytes)), /сервер/)
})

test('объявить ядро мёртвым здоровой комнате нельзя', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getMap(META_KEY).set('kernelStatus', 'dead'))
  assert.ok(refused(classify(server, bytes)))
})

test('строка в терминал от чужого имени не проходит', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getArray(TERMINAL_KEY).push([{ who: 'Ада', text: 'rm -rf /' }]))
  assert.ok(refused(classify(server, bytes)))
})

test('поддельный ответ оракула не проходит', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getArray(CHAT_KEY).push([{ role: 'assistant', text: 'да, удаляй' }]))
  assert.ok(refused(classify(server, bytes)))
})

test('переименовать чужую ячейку нельзя', () => {
  // Совпавшее имя — захват: «Запустить» ищет ячейку по имени.
  const { server, client, frame } = pair()
  const bytes = frame(() => cellAt(client, 1).set('id', 'c1'))
  assert.match(refused(classify(server, bytes)), /имя/)
})

test('заменить текст ячейки целиком нельзя — в нём чужие курсоры', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => cellAt(client, 0).set('source', new Y.Text('свой текст')))
  assert.match(refused(classify(server, bytes)), /целиком/)
})

test('раздел, которого у документа нет, отказывается', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getArray('secrets').push(['x']))
  assert.match(refused(classify(server, bytes)), /раздел/)
})

/* -------------------------------------------- значения новой ячейки, не путь */

test('новая ячейка с готовым выводом не проходит', () => {
  const { server, client, frame } = pair()
  // Ячейка и её вывод в одной транзакции — то есть в одном кадре, где ячейки
  // ещё нет у сервера. Именно это разрешение «создавать ячейки» и открыло бы.
  const bytes = frame(() => {
    client.getArray(CELLS_KEY).push([cell('c3', 'x')])
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ 'text/html': '<script>…' }))
    ;(cellAt(client, 2).get('outputs') as Y.Array<unknown>).push([out])
  })
  assert.ok(refused(classify(server, bytes)))
})

test('новая ячейка с поддельным stdin не проходит', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => {
    const map = cell('c3', 'x')
    map.set('stdin', { prompt: 'Пароль:', password: true })
    client.getArray(CELLS_KEY).push([map])
  })
  assert.match(refused(classify(server, bytes)), /лишнее поле/)
})

test('новая ячейка с чужим именем не проходит', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getArray(CELLS_KEY).push([cell('c1', 'x')]))
  assert.match(refused(classify(server, bytes)), /уже есть/)
})

test('две новые ячейки с одним именем в одном кадре не проходят', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getArray(CELLS_KEY).push([cell('c9', 'a'), cell('c9', 'b')]))
  assert.match(refused(classify(server, bytes)), /одним именем/)
})

test('новая ячейка, объявляющая себя выполненной, не проходит', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => {
    const map = cell('c3', 'x')
    map.set('state', 'ok')
    map.set('execCount', 41)
    client.getArray(CELLS_KEY).push([map])
  })
  assert.ok(refused(classify(server, bytes)))
})

test('текст новой ячейки обязан быть Y.Text', () => {
  // Простая строка на месте Y.Text бросает внутри отрисовки в КАЖДОЙ вкладке,
  // а не только у того, кто написал.
  const { server, client, frame } = pair()
  const bytes = frame(() => {
    const map = cell('c3', 'x')
    map.set('source', 'просто строка')
    client.getArray(CELLS_KEY).push([map])
  })
  assert.match(refused(classify(server, bytes)), /Y\.Text/)
})

test('вид ячейки, которого не бывает, не проходит', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => cellAt(client, 0).set('type', 'sql'))
  assert.ok(refused(classify(server, bytes)))
})

/* --------------------------------------------------- новизна и переподключение */

test('браузер, заново предложивший весь свой документ, не отказывается', () => {
  /*
   * Это происходит при каждой перезагрузке страницы: `y-indexeddb` переигрывает
   * локальный кэш, `y-websocket` пересылает всё, что не он сам. Без проверки
   * новизны такой кадр отказывался бы в любой комнате при любых правилах — и
   * предписанная перестройка стирала бы студенту кэш.
   */
  const { server, client } = pair()
  const whole = Y.encodeStateAsUpdate(client)
  const { verdicts } = ok(classify(server, whole))
  assert.deepEqual(verdicts, [], `весь документ дал приговоры: ${JSON.stringify(verdicts)}`)
})

test('повторное удаление уже удалённого ничего не значит', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getArray(CELLS_KEY).delete(1, 1))
  ok(classify(server, bytes))
  Y.applyUpdate(server, bytes)
  // Тот же кадр вторым заходом — переподключение, кэш, что угодно.
  assert.deepEqual(ok(classify(server, bytes)).verdicts, [])
})

test('ссылка на содержимое, которого у сервера нет, отказывается', () => {
  /*
   * Измерено: кадр без структур с одним диапазоном удаления на текущем такте
   * ведущего Yjs кладёт в pendingDs и переприменяет внутри каждого следующего
   * applyUpdate. Ведущий печатает « world» — у него «hello world», на сервере
   * «hello», и каждое следующее нажатие удаляется по прибытии. Молча. Навсегда.
   */
  const { server, client, frame } = pair()
  const ahead = new Y.Doc()
  Y.applyUpdate(ahead, Y.encodeStateAsUpdate(client))
  // Вкладка, о содержимом которой сервер ещё не слышал, удаляет своё же.
  const local = frame(() => (cellAt(client, 0).get('source') as Y.Text).insert(0, 'ЛОКАЛЬНО'))
  Y.applyUpdate(ahead, local)
  let bytes: Uint8Array | null = null
  ahead.on('update', (u: Uint8Array) => (bytes = bytes ? Y.mergeUpdates([bytes, u]) : u))
  ahead.transact(() => (cellAt(ahead, 0).get('source') as Y.Text).delete(0, 8))
  assert.ok(bytes)
  assert.match(refused(classify(server, bytes!)), /нет/)
})

test('запись в надгробие проходит', () => {
  /*
   * И это НЕ предыдущий случай: такт их разводит механически. Одна удалила
   * ячейку, в которой печатает другой; его структура разрешается через origin
   * на низком такте, getItem отдаёт GC — запись в надгробие не меняет ничего,
   * что кто-нибудь увидит.
   */
  const { server, client, frame } = pair()
  const typing = frame(() => (cellAt(client, 1).get('source') as Y.Text).insert(0, 'ещё '))
  server.transact(() => server.getArray(CELLS_KEY).delete(1, 1), 'other')
  // Надгробию нужен сбор мусора — он и делает getItem возвращающим GC.
  Y.applyUpdate(server, Y.encodeStateAsUpdate(server))
  ok(classify(server, typing))
})

/* ------------------------------------------------------------------ потолки */

test('кадр сверх потолка отказывается до разбора', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() =>
    (cellAt(client, 0).get('source') as Y.Text).insert(0, 'ы'.repeat(MAX_SYNC_FRAME_BYTES)),
  )
  assert.ok(bytes.byteLength > MAX_SYNC_FRAME_BYTES)
  assert.match(refused(classify(server, bytes)), /большой/)
})

test('мусор вместо кадра отказывается, а не пропускается', () => {
  // Пропустить то, что не смогли прочитать, — значит выполнить это после того,
  // как проверка перестала смотреть.
  const { server } = pair()
  assert.ok(refused(classify(server, new Uint8Array([9, 9, 9, 9, 9, 9]))))
})

/* -------------------------------------------------- отмена собственного удаления */

test('Ctrl+Z после удаления посчитавшей ячейки проходит и возвращает вывод', () => {
  /*
   * Жест, который гейт ломал молча и в любой комнате. Yjs отменяет удаление
   * КОПИЕЙ — то есть браузер предлагает серверу новую ячейку с готовым
   * выводом, — а пол запрещает браузеру писать вывод. Отказ здесь означал бы
   * пересборку документа за обычное Ctrl+Z.
   *
   * Разводит это память сервера: он помнит, что у него удалили. И вывод
   * возвращает свой, а не присланный, так что пол цел.
   */
  const { server, client, frame } = pair()
  server.transact(() => {
    const map = cellAt(server, 0)
    const out = new Y.Map<unknown>()
    out.set('kind', 'stream')
    out.set('name', 'stdout')
    out.set('text', new Y.Text('42\n'))
    ;(map.get('outputs') as Y.Array<unknown>).push([out])
    map.set('state', 'ok')
    map.set('execCount', 7)
    map.set('runBy', 'Мария')
  }, 'server')
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server))

  const undo = new Y.UndoManager(client.getArray(CELLS_KEY), {
    trackedOrigins: new Set([null, 'local']),
    captureTimeout: 400,
  })

  const removal = frame(() => client.transact(() => client.getArray(CELLS_KEY).delete(0, 1)))
  const gone = ok(classify(server, removal))
  assert.deepEqual(gone.removed, ['c1'], 'сервер не узнает, что запоминать')
  // Сервер запоминает ДО применения: после него читать уже нечего.
  rememberDeleted(ROOM, server, gone.removed)
  Y.applyUpdate(server, removal)

  let back: Uint8Array | null = null
  const grab = (u: Uint8Array): void => {
    back = back ? Y.mergeUpdates([back, u]) : u
  }
  client.on('update', grab)
  undo.undo()
  client.off('update', grab)
  assert.ok(back)

  const restored = ok(classify(server, back!, rememberedIn(ROOM)))
  assert.deepEqual(restored.created, ['c1'], 'отмена не опознана как создание ячейки')
  Y.applyUpdate(server, back!)
  server.transact(() => settleFresh(ROOM, server, restored.created), 'server')

  const cell = cellAt(server, 0)
  assert.equal(cell.get('id'), 'c1', 'вернулась не та ячейка')
  const outputs = cell.get('outputs') as Y.Array<Y.Map<unknown>>
  assert.equal(outputs.length, 1, 'ячейка вернулась без вывода')
  assert.equal((outputs.get(0).get('text') as Y.Text).toString(), '42\n')
  assert.equal(cell.get('execCount'), 7)
  assert.equal(cell.get('runBy'), 'Мария')
  assert.equal(cell.get('startedAt'), null, 'секундомер вернулся на ячейке, которую никто не считает')
})

test('подделанный вывод не проходит, а совпавшее имя его не отмывает', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => {
    client.getArray(CELLS_KEY).push([cell('c7', 'x')])
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ 'text/html': '<style>*{display:none}</style>' }))
    ;(cellAt(client, 2).get('outputs') as Y.Array<unknown>).push([out])
  })

  // Сервер такого удаления не помнит — «новая ячейка с готовым выводом»
  // остаётся тем, чем была.
  assert.ok(refused(classify(server, bytes)))

  /*
   * А если бы помнил — кадр проходит, но вывод в документ всё равно кладёт
   * сервер, из своей записи. Здесь его записи нет, поэтому не кладёт ничего:
   * вывода, которого сервер не производил, в документе не появляется даже
   * тогда, когда имя ячейки совпало с удалённой.
   */
  assert.equal(classify(server, bytes, new Set(['c7'])).ok, true)
  Y.applyUpdate(server, bytes)
  server.transact(() => settleFresh(ROOM, server, ['c7']), 'server')
  const made = server
    .getArray(CELLS_KEY)
    .toArray()
    .find((c) => (c as Y.Map<unknown>).get('id') === 'c7') as Y.Map<unknown>
  assert.equal((made.get('outputs') as Y.Array<unknown>).length, 0, 'подделанный вывод остался в документе')
})

test('новая ячейка всегда чиста, даже если браузер прислал её грязной', () => {
  const { server, client, frame } = pair()
  const bytes = frame(() => client.getArray(CELLS_KEY).push([cell('c8', 'x')]))
  const judged = ok(classify(server, bytes))
  Y.applyUpdate(server, bytes)
  server.transact(() => settleFresh(ROOM, server, judged.created), 'server')
  const made = server.getArray(CELLS_KEY).toArray().find((c) => (c as Y.Map<unknown>).get('id') === 'c8') as Y.Map<unknown>
  assert.equal(made.get('state'), 'idle')
  assert.equal(made.get('execCount'), null)
  assert.equal(made.get('stdin') ?? null, null)
})
