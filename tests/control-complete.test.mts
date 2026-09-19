/**
 * Дополнение в ячейке: дверь, через которую браузер спрашивает ЖИВОЕ ядро.
 *
 * Проверяется здесь не удобство, а три вещи, которые ломаются молча.
 *
 * Право. `complete_request` отвечает по состоянию ядра комнаты: `df.` — это
 * настоящие столбцы настоящего DataFrame, `_` — то, что считали последним.
 * Комната, где запускает преподаватель, — это комната, где содержимое ядра
 * принадлежит ему, и читать его через подсказку было бы обходом правила, а не
 * удобством. Отказ при этом БЕЗМОЛВНЫЙ: подсказка спрашивается на нажатие
 * клавиши, и тост «здесь запускает преподаватель» на каждую набранную точку —
 * наказание за печатание, а не объяснение правила.
 *
 * Потолок вопросов. Это единственное сообщение пульта, которое человек шлёт
 * десятками в секунду, ничего осознанно не нажимая.
 *
 * И то, что ответ приходит ВСЕГДА. На той стороне обещание, которого ждёт
 * автодополнение CodeMirror: не разрешённое — это список, который не появится
 * и не закроется.
 *
 * Ядра у сюиты нет (KERNEL_BACKEND=test, JUPYTER_URL смотрит в мёртвый порт),
 * и заготовленный ответ тестового бэкенда — тот же набор, что даёт pandas на
 * `df.`, — здесь стоит вместо него.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createSession, setRules } from '../server/src/db.js'
import { dispatch } from '../server/src/control.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { cellId as nameOf, createCell, getCells } from '../shared/notebook.js'
import { LECTURE_ROOM, OPEN_ROOM, type RoomRules } from '../shared/rules.js'
import type { ControlClientMessage, ControlServerMessage } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'
import { after } from 'node:test'

after(() => shutdownCollab())

/** Ровно то, что читает `send`: состояние и приём кадра. */
function socket(): { ws: WebSocket; said: ControlServerMessage[] } {
  const said: ControlServerMessage[] = []
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (frame: string) => said.push(JSON.parse(frame) as ControlServerMessage),
  } as unknown as WebSocket
  return { ws, said }
}

let rooms = 0

function room(rules: Partial<RoomRules> = {}): string {
  const id = `cmpl-${++rooms}`
  createSession(id, 'Дополнение', null)
  setRules(id, { ...OPEN_ROOM, ...rules })
  return id
}

function who(role: 'host' | 'participant', sessionId: string): TokenPayload {
  return { sessionId, participantId: `p_${role}`, role }
}

/**
 * Спросить и дождаться ответа.
 *
 * Ответ асинхронный — между `dispatch` и кадром лежит поход к ядру, — поэтому
 * ждём его, а не читаем сразу. Ждём с потолком: неразрешившееся обещание и
 * есть та беда, которую этот файл сторожит, и выглядеть она должна как
 * упавшее утверждение, а не как висящий навсегда тест.
 */
async function ask(
  ws: WebSocket,
  said: ControlServerMessage[],
  sessionId: string,
  role: 'host' | 'participant',
  message: ControlClientMessage,
): Promise<ControlServerMessage> {
  const before = said.length
  dispatch(ws, sessionId, who(role, sessionId), message)
  const deadline = Date.now() + 5000
  while (said.length === before && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const reply = said[before]
  assert.ok(reply, 'на вопрос о дополнении не ответили вовсе')
  return reply
}

test('в комнате, где запускает преподаватель, студенту отвечают пустым списком и без слов', async () => {
  const id = room(LECTURE_ROOM)
  const { ws, said } = socket()
  const reply = await ask(ws, said, id, 'participant', { t: 'complete', id: 1, code: 'df.', cursor: 3 })
  assert.deepEqual(reply, { t: 'complete:reply', id: 1, matches: [], start: 0, end: 0 })
  // Ни одного `error`: отказ подсказки не разговаривает.
  assert.equal(
    said.some((frame) => frame.t === 'error'),
    false,
    'отказ в подсказке сказал что-то вслух',
  )

  /*
   * У справки отказ теперь ГОВОРИТ, но говорит не всё. `refused` — та
   * единственная причина, которую клиент проживает молча: жест человек сделал
   * правильный, а объяснять «здесь запускает преподаватель» на каждое
   * наведение мышью значит ругать за наведение.
   */
  const help = await ask(ws, said, id, 'participant', { t: 'inspect', id: 2, code: 'df.head', cursor: 7 })
  assert.deepEqual(help, { t: 'inspect:reply', id: 2, found: false, reason: 'refused' })
})

test('преподавателю той же комнаты ядро отвечает именами и их видом', async () => {
  const id = room(LECTURE_ROOM)
  const { ws, said } = socket()
  const reply = await ask(ws, said, id, 'host', { t: 'complete', id: 7, code: 'df.', cursor: 3 })
  assert.equal(reply.t, 'complete:reply')
  assert.equal(reply.id, 7)
  const matches = (reply as Extract<ControlServerMessage, { t: 'complete:reply' }>).matches
  assert.deepEqual(
    matches.map((match) => match.text),
    ['head', 'tail', 'describe', 'shape', 'columns'],
  )
  // Вид приезжает вместе с именем: по нему редактор рисует значок и подпись.
  assert.equal(matches[0].type, 'function')
  assert.equal(matches.find((match) => match.text === 'shape')?.type, 'instance')
  // Заменяется кусок ПОСЛЕ точки, а не всё выражение целиком.
  assert.deepEqual(
    [
      (reply as Extract<ControlServerMessage, { t: 'complete:reply' }>).start,
      (reply as Extract<ControlServerMessage, { t: 'complete:reply' }>).end,
    ],
    [3, 3],
  )

  const help = await ask(ws, said, id, 'host', { t: 'inspect', id: 8, code: 'df.head', cursor: 7 })
  assert.equal(help.t, 'inspect:reply')
  assert.equal((help as Extract<ControlServerMessage, { t: 'inspect:reply' }>).found, true)
  assert.match(
    (help as Extract<ControlServerMessage, { t: 'inspect:reply' }>).text ?? '',
    /Signature: df\.head/,
  )
})

test('в открытой комнате дополнение даётся всем, а начатое слово фильтруется ядром', async () => {
  const id = room()
  const { ws, said } = socket()
  const reply = (await ask(ws, said, id, 'participant', {
    t: 'complete',
    id: 3,
    code: 'df.he',
    cursor: 5,
  })) as Extract<ControlServerMessage, { t: 'complete:reply' }>
  assert.deepEqual(
    reply.matches.map((match) => match.text),
    ['head'],
  )
  // Начало замены — там, где начато слово, а не там, где стоит каретка.
  assert.deepEqual([reply.start, reply.end], [3, 5])
})

test('перебравшему вопросов отвечают пустым, а не молчанием', async () => {
  const id = room()
  const { ws, said } = socket()
  /*
   * Ведро — десять вопросов и четыре в полёте; двадцать подряд без единой
   * паузы гарантированно его исчерпывают. Считаем не «сколько прошло», а два
   * факта: ответили на КАЖДЫЙ и часть ответов пуста. Первое — обещание
   * клиенту, второе — то, ради чего ведро заведено.
   */
  const replies: Extract<ControlServerMessage, { t: 'complete:reply' }>[] = []
  for (let i = 0; i < 20; i++) {
    replies.push(
      (await ask(ws, said, id, 'host', {
        t: 'complete',
        id: 100 + i,
        code: 'df.',
        cursor: 3,
      })) as Extract<ControlServerMessage, { t: 'complete:reply' }>,
    )
  }
  assert.equal(replies.length, 20)
  assert.deepEqual(
    replies.map((reply) => reply.id),
    Array.from({ length: 20 }, (_, i) => 100 + i),
    'ответ пришёл не на свой вопрос',
  )
  const refused = replies.filter((reply) => reply.matches.length === 0)
  assert.ok(refused.length > 0, 'ведро не остановило ни одного вопроса из двадцати')
  assert.ok(replies[0].matches.length > 0, 'первый же вопрос упёрся в ведро')

  // Другой сокет — своё ведро: одна разошедшаяся вкладка не молчит всей комнате.
  const other = socket()
  const fresh = (await ask(other.ws, other.said, id, 'host', {
    t: 'complete',
    id: 1,
    code: 'df.',
    cursor: 3,
  })) as Extract<ControlServerMessage, { t: 'complete:reply' }>
  assert.ok(fresh.matches.length > 0, 'ведро оказалось общим на комнату')
})

test('ячейка длиннее потолка отвечается, а не отвергается', async () => {
  const id = room()
  const { ws, said } = socket()
  /*
   * Сорок тысяч знаков — это вставленный в ячейку файл, и такое случается.
   * Ядру едет только хвост, кончающийся кареткой: дополняют то, что перед
   * ней. Важно здесь одно — ответ есть, и он про то место, где стоит каретка,
   * а не отказ и не молчание.
   */
  const code = `${'# заметка на полях\n'.repeat(2000)}df.`
  const reply = (await ask(ws, said, id, 'host', {
    t: 'complete',
    id: 42,
    code,
    cursor: code.length,
  })) as Extract<ControlServerMessage, { t: 'complete:reply' }>
  assert.ok(code.length > 24 * 1024, 'проверка перестала проверять длинный текст')
  assert.deepEqual(
    reply.matches.map((match) => match.text),
    ['head', 'tail', 'describe', 'shape', 'columns'],
  )
})

test('кадр без кода или без номера не роняет комнату и не отвечает мусором', async () => {
  const id = room()
  const { ws, said } = socket()
  const broken = { t: 'complete', id: 5 } as unknown as ControlClientMessage
  const reply = await ask(ws, said, id, 'host', broken)
  assert.deepEqual(reply, { t: 'complete:reply', id: 5, matches: [], start: 0, end: 0 })
})

/* ------------------------------------------------- свой лист консилиума */

/** Ячейка в тетради комнаты — с замком в это положение. */
function cell(sessionId: string, lock: 'closed' | 'council'): string {
  const { doc } = getSessionDoc(sessionId)
  const made = createCell('code', 'imp = ...')
  doc.transact(() => {
    // Положение замка живёт в ключе `open` (notebook.ts · cellLock); ручки —
    // отдельным ключом, и без них консилиум всё равно консилиум.
    if (lock === 'council') made.set('open', 'council')
    getCells(doc).push([made])
  })
  return nameOf(made)
}

test('в лекционной комнате студент дополняет в своём листе консилиума — и только в нём', async () => {
  const id = room(LECTURE_ROOM)
  const council = cell(id, 'council')
  const plain = cell(id, 'closed')
  const { ws, said } = socket()

  /*
   * Та же комната, тот же человек, та же строка кода — разница только в том,
   * какую ячейку называет кадр. Лист консилиума — единственная ячейка, где
   * студенту велено писать код самому, и молчаливый отказ в ней означал «пиши
   * на память»: имена приезжали из слов самой ячейки, а столбцы настоящего
   * `df` — нет.
   */
  const mine = (await ask(ws, said, id, 'participant', {
    t: 'complete',
    id: 11,
    code: 'df.',
    cursor: 3,
    cellId: council,
  })) as Extract<ControlServerMessage, { t: 'complete:reply' }>
  assert.ok(mine.matches.length > 0, 'в своём листе консилиума студенту отказали')
  assert.deepEqual(
    mine.matches.map((match) => match.text),
    ['head', 'tail', 'describe', 'shape', 'columns'],
  )

  // Соседняя ячейка той же комнаты — правило прежнее, и отказ по-прежнему молчит.
  const other = (await ask(ws, said, id, 'participant', {
    t: 'complete',
    id: 12,
    code: 'df.',
    cursor: 3,
    cellId: plain,
  })) as Extract<ControlServerMessage, { t: 'complete:reply' }>
  assert.deepEqual(other.matches, [], 'обычная ячейка лекции раздала состояние ядра')

  // И имя ячейки, которой в комнате нет, ничего не открывает: замок читается
  // из документа, а не из кадра.
  const made = (await ask(ws, said, id, 'participant', {
    t: 'complete',
    id: 13,
    code: 'df.',
    cursor: 3,
    cellId: 'c_nosuchcell',
  })) as Extract<ControlServerMessage, { t: 'complete:reply' }>
  assert.deepEqual(made.matches, [], 'выдуманное имя ячейки дало право')

  assert.equal(
    said.some((frame) => frame.t === 'error'),
    false,
    'отказ в подсказке сказал что-то вслух',
  )
})

test('справка по наведению в листе консилиума отвечает тому же студенту', async () => {
  const id = room(LECTURE_ROOM)
  const council = cell(id, 'council')
  const { ws, said } = socket()
  const help = (await ask(ws, said, id, 'participant', {
    t: 'inspect',
    id: 21,
    code: 'df.head',
    cursor: 7,
    cellId: council,
  })) as Extract<ControlServerMessage, { t: 'inspect:reply' }>
  assert.equal(help.found, true, 'сигнатуры в своём листе нет')
  assert.match(help.text ?? '', /Signature: df\.head/)
})

/* ------------------------------------------------- почему справки нет */

/**
 * Молчание вместо ответа — то, из-за чего справка казалась сломанной.
 *
 * «Она не всегда появляется»: ядро не поднято, имя не выполняли, ядро считает
 * чужую ячейку — три РАЗНЫХ случая, и все три выглядели одинаково, то есть
 * никак. Теперь отказ везёт причину одним словом (protocol.ts · InspectMiss),
 * а слова к ней подбирает клиент на языке комнаты.
 */
test('на имя, о котором сказать нечего, отвечают причиной, а не молчанием', async () => {
  const id = room()
  const { ws, said } = socket()
  // Под указателем пробел: имени нет, и ядро честно отвечает «не нашлось».
  const help = (await ask(ws, said, id, 'host', {
    t: 'inspect',
    id: 31,
    code: 'x = ',
    cursor: 4,
  })) as Extract<ControlServerMessage, { t: 'inspect:reply' }>
  assert.equal(help.found, false)
  assert.equal(help.reason, 'unknown')
  assert.equal(help.text, undefined)
})

test('дополнение по-прежнему отказывает молча: причин у него нет', async () => {
  const id = room(LECTURE_ROOM)
  const { ws, said } = socket()
  const reply = (await ask(ws, said, id, 'participant', {
    t: 'complete',
    id: 32,
    code: 'df.',
    cursor: 3,
  })) as Extract<ControlServerMessage, { t: 'complete:reply' }>
  assert.equal('reason' in reply, false, 'у дополнения завелась причина отказа')
})

test('в своём листе консилиума справка есть, а поднимать комнате ядро — нельзя', async () => {
  /*
   * Два разных права, и разводит их ровно этот случай. Дополнять и наводиться
   * в своём листе студенту можно и в лекционной комнате (`mayComplete`) —
   * иначе задание пишется на память. А ПУСК ядра — это полторы минуты, которые
   * видит вся комната, и нажимает их тот, у кого есть Run (`mayWake`).
   *
   * Ядра в сюите нет вовсе, поэтому ответ здесь — `no-kernel`: «запускать его
   * в этой комнате может только преподаватель». Если бы право будить
   * протекало, ответом было бы `starting`, а на машине поднялся бы контейнер.
   */
  const previous = process.env.KERNEL_BACKEND
  process.env.KERNEL_BACKEND = 'docker'
  try {
    const id = room(LECTURE_ROOM)
    const council = cell(id, 'council')
    const { ws, said } = socket()
    const help = (await ask(ws, said, id, 'participant', {
      t: 'inspect',
      id: 33,
      code: 'df.head',
      cursor: 7,
      cellId: council,
    })) as Extract<ControlServerMessage, { t: 'inspect:reply' }>
    assert.equal(help.found, false)
    assert.equal(help.reason, 'no-kernel', 'студент разбудил ядро комнаты справкой')
  } finally {
    if (previous === undefined) delete process.env.KERNEL_BACKEND
    else process.env.KERNEL_BACKEND = previous
  }
})
