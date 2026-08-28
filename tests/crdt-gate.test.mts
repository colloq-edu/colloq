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
import { CELLS_KEY, CHAT_KEY, META_KEY, TERMINAL_KEY } from '../shared/notebook.js'

/** Сервер и браузер: два документа, синхронные на старте. */
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
    client.transact(write, 'browser')
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
