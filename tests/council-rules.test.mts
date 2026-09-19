/**
 * Регламент консилиума: предел одного запуска и пауза между своими запусками.
 *
 * Обе ручки заведены против одной и той же беды, и беда эта не гипотетическая:
 * ядро в комнате одно, очередь к нему общая, и на потоке в пятьсот человек
 * `while True` у одного — это «В очереди: 37» у остальных до конца пары, пока
 * преподаватель не заметит и не нажмёт «Прервать». Очередь из нажимающих
 * «Запустить» после каждой правки — то же самое, только без злого умысла.
 *
 * Здесь проверяется ровно то, что ломается молча:
 *
 *   — сигнал по пределу достаётся ТОЙ попытке, которая его перебрала, а
 *     следующая в очереди считается как ни в чём не бывало. Это главная
 *     опасность: `interrupt` уходит в Jupyter по HTTP и отвечает не мгновенно,
 *     а очередь за это время успевает взять следующую работу;
 *   — остановленная попытка объясняется словами, а не трейсбеком
 *     `KeyboardInterrupt`: студент читает его как «преподаватель нажал стоп»
 *     или как свою ошибку;
 *   — вывод ДО остановки сохраняется: в нём обычно и виден зациклившийся кусок;
 *   — предел, поменянный посреди запуска, действует на этот же запуск;
 *   — пауза считается от конца СВОЕГО запуска, преподавателя не касается и
 *     приезжает студенту числом (`CouncilMine.nextRunAt`), а не одним отказом.
 *
 * Подделка Jupyter вместо настоящего ядра: нужен запуск, который не кончается,
 * пока его не прервут, — живое ядро такого по заказу не делает. Масштаб предела
 * сдвинут тестовым швом (`setCouncilLimitTick`), иначе каждая проверка стоила бы
 * пяти секунд ожидания.
 */
import './_env.mts'
import { createServer, type Server } from 'node:http'
import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { ControlClientMessage, ControlServerMessage, CouncilMine } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'
// Ни одного статического импорта серверных модулей: config читает JUPYTER_URL
// на импорте, а подделка поднимается в before(). Так же устроены kernel.test и
// control-interrupt.test.

/* ---------------------------------------------------------- подделка Jupyter */

const kernels = new Map<string, { alive: boolean }>()
const byPath = new Map<string, string>()
let minted = 0
let http: Server
let wss: WebSocketServer
let sockets: WebSocket[] = []
/** Запросы, на которых подделка сидит: «считается, пока не прервут». */
let held: Array<{ socket: WebSocket; parent: unknown }> = []
/** Сколько раз комнату просили прервать — по нему видно, что сигнал не штормит. */
let interrupts = 0
/**
 * Чем подделка отвечает на вход изоляции (kernel/council-isolation.ts).
 *
 * `null` — «ядро промолчало»: `user_expressions` пустой, и сервер обязан
 * НЕ запускать попытку. По умолчанию — обычное подтверждение без пропусков,
 * иначе ни одна проверка регламента до запуска бы не добралась.
 */
let councilReport: Record<string, unknown> | null = {
  ok: true, copied: 2, skipped: [], failed: [], bytes: 0, ms: 1,
}
/** Сколько раз подделку просили выйти из изоляции — выход обязан быть всегда. */
let isolationExits = 0
/** Всё, что доехало до ядра: по нему видно, запускали попытку или нет. */
let seen: string[] = []

function reply(socket: WebSocket, parent: unknown, msgType: string, content: unknown): void {
  socket.send(
    JSON.stringify({
      header: { msg_id: `m_${Math.random().toString(36).slice(2)}`, msg_type: msgType },
      parent_header: parent,
      metadata: {},
      content,
      channel: msgType.endsWith('_reply') ? 'shell' : 'iopub',
    }),
  )
}

before(async () => {
  http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const kernelMatch = /^\/api\/kernels\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const path = (JSON.parse(body || '{}') as { path?: string }).path ?? ''
        let id = byPath.get(path)
        if (!id || !kernels.get(id)?.alive) {
          id = `k_${++minted}`
          byPath.set(path, id)
          kernels.set(id, { alive: true })
        }
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: `s_${id}`, kernel: { id } }))
      })
      return
    }
    if (req.method === 'GET' && kernelMatch) {
      if (!kernels.get(kernelMatch[1])?.alive) return void res.writeHead(404).end('{}')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: kernelMatch[1], execution_state: 'idle' }))
      return
    }
    if (req.method === 'POST' && /\/interrupt$/.test(url.pathname)) {
      interrupts += 1
      /*
       * Ровно то, что делает настоящее ядро: ждущий запрос падает
       * `KeyboardInterrupt` с трейсбеком. Именно этот трейсбек и не должен
       * доехать до карточки студента.
       */
      for (const { socket, parent } of held.splice(0)) {
        reply(socket, parent, 'error', {
          ename: 'KeyboardInterrupt',
          evalue: '',
          traceback: [
            'Traceback (most recent call last)',
            'Cell In[1], line 2',
            'KeyboardInterrupt: ',
          ],
        })
        reply(socket, parent, 'execute_reply', { status: 'error', execution_count: 1 })
        reply(socket, parent, 'status', { execution_state: 'idle' })
      }
      /*
       * Ответ на сам POST — с задержкой, и это не украшение подделки.
       *
       * Ровно на нём стоит граница очереди: сервер кладёт это обещание в
       * `beforeNext`, и следующая работа не начинается, пока прерывание не
       * отстоялось (kernel/index.ts · stopRunningJob). Отвечать мгновенно
       * значило бы проверять код, из которого границу можно убрать, не заметив.
       */
      setTimeout(() => res.writeHead(204).end(), 120)
      return
    }
    res.writeHead(404).end('{}')
  })

  wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (req, socket, head) => {
    const id = /^\/api\/kernels\/([^/]+)\/channels/.exec(req.url ?? '')?.[1]
    if (!id || !kernels.has(id)) return void socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws)
      ws.on('message', (raw: RawData) => {
        const msg = JSON.parse(String(raw)) as {
          header: { msg_type: string }
          content: { code: string }
        }
        if (msg.header.msg_type !== 'execute_request') return
        const code = msg.content.code
        seen.push(code)
        reply(ws, msg.header, 'status', { execution_state: 'busy' })
        reply(ws, msg.header, 'execute_input', { code, execution_count: 1 })
        /*
         * HANG — попытка, которая не кончается сама. Печатает строку и садится
         * ждать: без этой строки проверить «вывод до остановки сохранён» было
         * бы нечем. Всё остальное, включая вход и выход изоляции вокруг
         * попытки (council-isolation.ts), отвечает сразу — иначе очередь
         * встала бы ещё до запуска.
         */
        if (code.includes('HANG')) {
          reply(ws, msg.header, 'stream', { name: 'stdout', text: 'считаю…\n' })
          held.push({ socket: ws, parent: msg.header })
          return
        }
        if (code.includes('PRINT')) {
          reply(ws, msg.header, 'stream', { name: 'stdout', text: 'готово\n' })
        }
        /*
         * Вход изоляции отчитывается `user_expressions` — настоящее ядро
         * отвечает ими даже на молчаливый запрос, и без этой ветки сервер
         * справедливо отказался бы запускать хоть одну попытку.
         */
        const expressions = (msg.content as { user_expressions?: Record<string, string> })
          .user_expressions
        const wantsReport = expressions !== undefined && Object.keys(expressions).length > 0
        if (code.includes('.leave(globals())')) isolationExits += 1
        reply(ws, msg.header, 'execute_reply', {
          status: 'ok',
          execution_count: 1,
          ...(wantsReport
            ? {
                user_expressions: councilReport
                  ? {
                      colloq: {
                        status: 'ok',
                        data: { 'text/plain': JSON.stringify(councilReport) },
                        metadata: {},
                      },
                    }
                  : {},
              }
            : {}),
        })
        reply(ws, msg.header, 'status', { execution_state: 'idle' })
      })
    })
  })

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as { port: number }
  process.env.JUPYTER_URL = `http://127.0.0.1:${port}`
  process.env.JUPYTER_TOKEN = 'fake'
  const { setCouncilLimitTick } = await import('../server/src/kernel/index.js')
  // Секунда предела — пятьдесят миллисекунд: сюита проверяет поведение, а не
  // терпение. Повтор сигнала при этом тоже ускоряется, см. LIMIT_RETRY_TICKS.
  setCouncilLimitTick(50)
})

afterEach(() => {
  // Зависший запрос не переживает свой тест: комната у каждого своя, а
  // досиживать его некому — упавшее утверждение иначе роняло бы весь хвост.
  for (const { socket, parent } of held.splice(0)) {
    reply(socket, parent, 'execute_reply', { status: 'ok', execution_count: 1 })
    reply(socket, parent, 'status', { execution_state: 'idle' })
  }
  interrupts = 0
  isolationExits = 0
  seen = []
  councilReport = { ok: true, copied: 2, skipped: [], failed: [], bytes: 0, ms: 1 }
})

after(async () => {
  held = []
  const { setCouncilLimitTick, shutdownKernels } = await import('../server/src/kernel/index.js')
  const { shutdownCollab } = await import('../server/src/collab/index.js')
  setCouncilLimitTick(1000)
  await shutdownKernels()
  shutdownCollab()
  for (const socket of sockets) socket.terminate()
  wss?.close()
  await new Promise<void>((resolve) => http.close(() => resolve()))
})

/* ------------------------------------------------------------------ комната */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await what()) return true
    await wait(10)
  }
  return await what()
}

interface Person {
  payload: TokenPayload
  heard: ControlServerMessage[]
  ws: WebSocket
}

interface Room {
  id: string
  cell: string
  teacher: Person
  petya: Person
  masha: Person
}

let seq = 0

/** Ровно то, что читают `send` и `handleControlSocket`: состояние, приём, подписки. */
async function join(
  sessionId: string,
  participantId: string,
  name: string,
  role: 'host' | 'participant',
): Promise<Person> {
  const { upsertParticipant } = await import('../server/src/db.js')
  const { handleControlSocket } = await import('../server/src/control.js')
  upsertParticipant({ id: participantId, sessionId, name, avatar: null, role })
  const heard: ControlServerMessage[] = []
  const fake = {
    readyState: WebSocket.OPEN as number,
    send(frame: unknown) {
      if (typeof frame === 'string' || Buffer.isBuffer(frame)) {
        heard.push(JSON.parse(String(frame)) as ControlServerMessage)
      }
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

async function room(): Promise<Room> {
  const { createSession, setRules } = await import('../server/src/db.js')
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  const { cellId, createCell, getCells } = await import('../shared/notebook.js')
  const { LECTURE_ROOM } = await import('../shared/rules.js')
  const id = `council-rules-${++seq}`
  createSession(id, 'Консилиум', null)
  setRules(id, { ...LECTURE_ROOM })
  const { doc } = getSessionDoc(id)
  const task = createCell('code', '# задание')
  doc.transact(() => getCells(doc).push([task]))
  return {
    id,
    cell: cellId(task),
    teacher: await join(id, `${id}_t`, 'Ада', 'host'),
    petya: await join(id, `${id}_p`, 'Петя', 'participant'),
    masha: await join(id, `${id}_m`, 'Маша', 'participant'),
  }
}

/** Сказать в провод и вернуть текст отказа, если он был. */
async function say(at: Room, who: Person, message: ControlClientMessage): Promise<string | null> {
  const { dispatch } = await import('../server/src/control.js')
  const before = who.heard.length
  dispatch(who.ws, at.id, who.payload, message)
  const error = who.heard.slice(before).find((m) => m.t === 'error')
  return error && error.t === 'error' ? error.message : null
}

function lastMine(who: Person, cellId: string): CouncilMine | null {
  for (let i = who.heard.length - 1; i >= 0; i--) {
    const m = who.heard[i]
    if (m.t === 'council:mine' && m.cellId === cellId) return m.state
  }
  return null
}

async function council(
  at: Room,
  settings: Record<string, unknown> = {},
): Promise<string | null> {
  return say(at, at.teacher, {
    t: 'cell:lock',
    cellId: at.cell,
    state: 'council',
    settings: settings as never,
  })
}

async function knobs(at: Room) {
  const { getSessionDoc } = await import('../server/src/collab/index.js')
  const { councilSettingsOf, findCell } = await import('../shared/notebook.js')
  const found = findCell(getSessionDoc(at.id).doc, at.cell)
  return councilSettingsOf(found!.cell)
}

async function runOf(at: Room, who: Person) {
  const { attemptOf } = await import('../server/src/council.js')
  return attemptOf(at.id, at.cell, who.payload.participantId)?.run ?? null
}

/* --------------------------------------------------------------- санитайзер */

test('мусор в ручках регламента не доезжает до документа', async () => {
  const { DEFAULT_COUNCIL, readCouncilSettings } = await import('../shared/notebook.js')

  // Чистая половина: чтение ячейки, в которой уже лежит что угодно.
  assert.deepEqual(readCouncilSettings({ runLimitSec: 'долго', rerunPauseSec: [] }), DEFAULT_COUNCIL)
  assert.equal(readCouncilSettings({ runLimitSec: 1.5 }).runLimitSec, DEFAULT_COUNCIL.runLimitSec)
  assert.equal(readCouncilSettings({ runLimitSec: 0 }).runLimitSec, DEFAULT_COUNCIL.runLimitSec)
  assert.equal(readCouncilSettings({ runLimitSec: 99999 }).runLimitSec, DEFAULT_COUNCIL.runLimitSec)
  // `null` — не «поля нет», а осознанный выбор преподавателя.
  assert.equal(readCouncilSettings({ runLimitSec: null }).runLimitSec, null)
  assert.equal(readCouncilSettings({ rerunPauseSec: 0 }).rerunPauseSec, 0)
  assert.equal(readCouncilSettings({ rerunPauseSec: -5 }).rerunPauseSec, 0)

  // И вторая половина: то же самое проводом. Негодное значение отбрасывается —
  // прежняя ручка остаётся, а не подменяется умолчанием.
  const at = await room()
  assert.equal(await council(at, { runLimitSec: 5, rerunPauseSec: 15 }), null)
  assert.deepEqual(await knobs(at), {
    studentRun: false,
    namesOnProjector: true,
    runLimitSec: 5,
    rerunPauseSec: 15,
  })
  assert.equal(await council(at, { runLimitSec: 99999, rerunPauseSec: 'чуть-чуть' }), null)
  assert.equal((await knobs(at))!.runLimitSec, 5, 'предел вне границ сбросил ручку')
  assert.equal((await knobs(at))!.rerunPauseSec, 15, 'мусор сбросил паузу')
  assert.equal(await council(at, { runLimitSec: null }), null)
  assert.equal((await knobs(at))!.runLimitSec, null, '«без предела» не доехало')

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

/* ------------------------------------------------------------ предел запуска */

test('запуск сверх предела останавливает сервер — и следующий в очереди этого не замечает', async () => {
  const at = await room()
  assert.equal(await council(at, { studentRun: true, runLimitSec: 1 }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'HANG' }), null)
  assert.equal(
    await say(at, at.masha, { t: 'council:draft', cellId: at.cell, text: 'PRINT' }),
    null,
  )
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  // Вторая попытка встаёт в очередь ЗА первой — ровно та расстановка, при
  // которой поздний SIGINT попадал в чужую работу.
  assert.equal(await say(at, at.masha, { t: 'council:run', cellId: at.cell }), null)

  assert.ok(
    await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'error', 4000),
    'предел не сработал',
  )

  const stopped = await runOf(at, at.petya)
  assert.equal(stopped?.timedOut, 1, 'на попытке не отмечен сработавший предел')
  assert.equal(stopped?.state, 'error')
  const outputs = stopped?.outputs ?? []
  assert.equal(outputs[0]?.kind, 'stream', 'вывод до остановки пропал')
  assert.match(String((outputs[0] as { text: string }).text), /считаю/)
  const failure = outputs.find((o) => o.kind === 'error') as
    | { ename: string; evalue: string; traceback: string[] }
    | undefined
  assert.equal(failure?.ename, '', 'перед русской фразой снова английское имя исключения')
  assert.match(failure!.evalue, /Остановлено/)
  assert.deepEqual(failure!.traceback, [], 'трейсбек прерывания остался на карточке')
  assert.equal(
    JSON.stringify(outputs).includes('KeyboardInterrupt'),
    false,
    'студент читает про клавиатуру, которую никто не нажимал',
  )

  /*
   * Отметка доезжает обоим, кому попытка видна, и переживает перезапуск.
   *
   * Автору — листом (`council:mine`), пульту — дельтой стопки; в базе она лежит
   * внутри `run_json`, то есть кадром из прошлой жизни сервера её не потерять.
   * Список работ и очередь пульта читают именно её, а не разбирают вывод: в
   * стопке вывода часто и нет вовсе (`outputsOmitted`).
   */
  assert.equal(lastMine(at.petya, at.cell)?.run?.timedOut, 1, 'автор не узнал причину остановки')
  assert.ok(
    await until(
      () =>
        at.teacher.heard.some(
          (m) =>
            (m.t === 'council:patch' || m.t === 'council:board') &&
            (m.t === 'council:patch' ? m.attempts : m.board.attempts).some(
              (a) => a.run?.timedOut === 1,
            ),
        ),
      2000,
    ),
    'в стопку преподавателя причина остановки не поехала',
  )
  const { resetCouncilCache } = await import('../server/src/council.js')
  resetCouncilCache(at.id)
  assert.equal((await runOf(at, at.petya))?.timedOut, 1, 'отметка не пережила чтение из базы')

  // И главное: соседняя попытка досчиталась сама, а не получила чужой сигнал.
  assert.ok(
    await until(async () => ((await runOf(at, at.masha))?.state ?? '') === 'ok', 4000),
    'следующая в очереди попытка не досчиталась',
  )
  const next = await runOf(at, at.masha)
  assert.equal(next?.timedOut, undefined, 'сигнал по пределу достался следующей работе')
  assert.equal(next?.outputs.some((o) => o.kind === 'error'), false)

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

test('запуск в пределах не трогают, и будильник за ним не остаётся', async () => {
  const at = await room()
  assert.equal(await council(at, { studentRun: true, runLimitSec: 2 }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT' }), null)
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'ok', 4000))
  const done = await runOf(at, at.petya)
  assert.equal(done?.timedOut, undefined)
  /*
   * Будильник, переживший свою попытку, — это сигнал в следующую работу
   * очереди. Проверяется он единственным честным способом: подождать дольше
   * предела и убедиться, что ядро никто не прерывал.
   */
  await wait(2 * 50 + 120)
  assert.equal(interrupts, 0, 'будильник досчитал уже после конца запуска')
  assert.equal((await runOf(at, at.petya))?.state, 'ok')

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

test('«без предела» не прерывает никогда', async () => {
  const at = await room()
  assert.equal(await council(at, { studentRun: true, runLimitSec: null }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'HANG' }), null)
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'running', 4000))
  // Дольше умолчания (30 «секунд» по ускоренным часам): молчание здесь значит
  // «предела нет», а не «предел ещё не подошёл».
  await wait(30 * 50 + 150)
  assert.equal(interrupts, 0, 'попытку прервали там, где предела нет')
  assert.equal((await runOf(at, at.petya))?.state, 'running')

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

test('преподавательский запуск чужой попытки предел тоже касается', async () => {
  const at = await room()
  assert.equal(await council(at, { runLimitSec: 1 }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'HANG' }), null)
  // Ручка запуска студентам выключена: нажимает преподаватель, и это тот самый
  // случай, в котором «предел не про меня» стоило бы всей комнате.
  assert.equal(
    await say(at, at.teacher, {
      t: 'council:run',
      cellId: at.cell,
      participantId: at.petya.payload.participantId,
    }),
    null,
  )
  assert.ok(
    await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'error', 4000),
    'запуск преподавателя не остановился по пределу',
  )
  assert.equal((await runOf(at, at.petya))?.timedOut, 1)
  assert.equal((await runOf(at, at.petya))?.by, 'host')

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

test('предел, поменянный посреди запуска, действует на этот же запуск', async () => {
  const at = await room()
  // Начали без предела: попытка висит и висела бы до конца пары.
  assert.equal(await council(at, { studentRun: true, runLimitSec: null }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'HANG' }), null)
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'running', 4000))
  await wait(200)
  assert.equal(interrupts, 0)

  /*
   * Преподаватель ставит предел, ГЛЯДЯ на зависший цикл. Считается он от начала
   * этой попытки, а она идёт уже дольше — значит, срабатывает сразу, а не через
   * секунду после нажатия.
   */
  assert.equal(await council(at, { runLimitSec: 1 }), null)
  assert.ok(
    await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'error', 4000),
    'новый предел не достал идущую попытку',
  )
  assert.equal((await runOf(at, at.petya))?.timedOut, 1)
  assert.equal(interrupts, 1, 'сигнал ушёл не один раз')

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

test('новый предел достаёт и тех, кто уже стоит в очереди', async () => {
  const at = await room()
  /*
   * Предел записан в работу при постановке в очередь: ядро документа не читает.
   * Преподаватель снимает «без предела», глядя на вставшую очередь, — и если
   * новое число получила только идущая попытка, следующая за ней зависает уже
   * без предела вовсе, и очередь стоит снова, теперь под регламентом, который
   * это запрещает.
   */
  assert.equal(await council(at, { studentRun: true, runLimitSec: null }), null)
  for (const who of [at.petya, at.masha]) {
    assert.equal(await say(at, who, { t: 'council:draft', cellId: at.cell, text: 'HANG' }), null)
    assert.equal(await say(at, who, { t: 'council:run', cellId: at.cell }), null)
  }
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'running', 4000))
  assert.equal((await runOf(at, at.masha))?.state, 'queued')

  assert.equal(await council(at, { runLimitSec: 1 }), null)
  assert.ok(
    await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'error', 4000),
    'новый предел не достал идущую попытку',
  )
  assert.ok(
    await until(async () => ((await runOf(at, at.masha))?.state ?? '') === 'error', 4000),
    'ждавшая в очереди попытка пошла без предела',
  )
  assert.equal((await runOf(at, at.masha))?.timedOut, 1)

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

/* --------------------------------------------------------- пауза между своими */

test('пауза не пускает студента в очередь снова — и не касается преподавателя', async () => {
  const at = await room()
  assert.equal(await council(at, { studentRun: true, runLimitSec: null, rerunPauseSec: 30 }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT' }), null)
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'ok', 4000))

  // Отсчёт приехал автору вместе с концом его запуска: на месте кнопки должен
  // стоять он, а не кнопка, которая отвечает отказом.
  const mine = lastMine(at.petya, at.cell)
  assert.ok(mine, 'лист автору не уехал')
  assert.ok(typeof mine!.nextRunAt === 'number', 'в листе нет отсчёта до следующего запуска')
  assert.ok(mine!.nextRunAt! > Date.now(), 'отсчёт уже в прошлом')
  assert.ok(mine!.nextRunAt! <= Date.now() + 30_000)

  // Своё нажатие — отказ словами и с числом.
  const refused = await say(at, at.petya, { t: 'council:run', cellId: at.cell })
  assert.match(refused ?? '', /Следующий запуск/)
  assert.match(refused ?? '', /\d+ с|мин/)

  // А преподаватель запускает ту же попытку тут же: пауза — про автора.
  assert.equal(
    await say(at, at.teacher, {
      t: 'council:run',
      cellId: at.cell,
      participantId: at.petya.payload.participantId,
    }),
    null,
    'пауза автора остановила преподавателя',
  )

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

test('пауза спрашивается на просьбе, а не на одобрении', async () => {
  const at = await room()
  assert.equal(
    await council(at, { studentRun: 'request', runLimitSec: null, rerunPauseSec: 30 }),
    null,
  )
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT' }), null)
  assert.equal(await say(at, at.petya, { t: 'council:run:request', cellId: at.cell }), null)

  const { attemptOf } = await import('../server/src/council.js')
  const request = attemptOf(at.id, at.cell, at.petya.payload.participantId)?.runRequest
  assert.equal(request?.status, 'pending')
  assert.equal(
    await say(at, at.teacher, {
      t: 'council:run:approve',
      cellId: at.cell,
      participantId: at.petya.payload.participantId,
      requestId: request!.id,
    }),
    null,
  )
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'ok', 4000))

  /*
   * Одобренная просьба — тоже свой запуск: время ядра потрачено на этого
   * человека, а «одобрить» нажал преподаватель только потому, что его попросили.
   * Без этого режим «по просьбе» — единственный, где паузы нет вовсе.
   */
  const refused = await say(at, at.petya, { t: 'council:run:request', cellId: at.cell })
  assert.match(refused ?? '', /Следующий запуск/)
  const again = attemptOf(at.id, at.cell, at.petya.payload.participantId)?.runRequest
  assert.equal(again ?? null, null, 'просьба встала в очередь сквозь паузу')

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

test('пауза 0 не отказывает никому и отсчёта в лист не кладёт', async () => {
  const at = await room()
  assert.equal(await council(at, { studentRun: true, runLimitSec: null }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT' }), null)
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'ok', 4000))
  assert.equal(lastMine(at.petya, at.cell)?.nextRunAt ?? null, null, 'отсчёт там, где паузы нет')

  // Правка текста — и сразу новый запуск: ничем не хуже первого.
  assert.equal(
    await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT  # ещё' }),
    null,
  )
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'ok', 4000))

  /*
   * И обратный ход: ручку включили после того, как запуск уже кончился, — она
   * действует и на него. Срок не хранится, он считается из конца прошлого
   * запуска и ТЕКУЩЕЙ паузы.
   */
  const { nextRunAtFor } = await import('../server/src/council.js')
  const who = at.petya.payload.participantId
  assert.equal(nextRunAtFor(at.id, at.cell, who, 0), null)
  assert.ok((nextRunAtFor(at.id, at.cell, who, 60) ?? 0) > Date.now())
  // И ручку, снятую преподавателем, никто не переживает.
  assert.equal(nextRunAtFor(at.id, at.cell, who, 0), null)

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

/* ------------------------------------------------------ личные копии данных */

/**
 * Вход не подтвердился — попытка не запускается вовсе.
 *
 * Это не осторожность, а единственный честный исход. Отчёт входа
 * (kernel/council-isolation.ts) — единственное, по чему сервер знает, чьи
 * сейчас данные в ядре; молчание означает «неизвестно», и запуск на общих
 * объектах ровно здесь и стоил бы пары: студент получил бы правильный на вид
 * ответ, испортив `data` всей группе. Поэтому вместо запуска — одна строка без
 * трейсбека, а выход отрабатывает всё равно: вход мог успеть подменить
 * привязки и упасть после.
 */
test('вход без подтверждения не пускает попытку в ядро и говорит об этом одной строкой', async () => {
  const at = await room()
  assert.equal(await council(at, { studentRun: true, runLimitSec: null }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT' }), null)
  councilReport = null
  const exitsBefore = isolationExits
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)

  assert.ok(
    await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'error', 4000),
    'попытка не кончилась отказом',
  )
  const run = await runOf(at, at.petya)
  const outputs = run?.outputs ?? []
  assert.equal(outputs.length, 1, 'к отказу прицепился чужой вывод')
  const failure = outputs[0] as { kind: string; ename: string; evalue: string; traceback: string[] }
  assert.equal(failure.kind, 'error')
  assert.match(failure.evalue, /Не удалось подготовить личные копии/)
  // Без трейсбека: кадры `<colloq-council>` — не код студента и ему не помогут.
  assert.deepEqual(failure.traceback, [])
  assert.doesNotMatch(failure.evalue, /\n/, 'отказ перестал быть одной строкой')

  // Текст попытки до ядра не доехал — а выход отработал.
  assert.ok(!seen.some((code) => code.includes('PRINT')), 'попытка всё-таки исполнилась')
  assert.ok(isolationExits > exitsBefore, 'выход не выполнили после неудачного входа')

  // И очередь этим не сломана: следующая попытка при живом входе считается.
  councilReport = { ok: true, copied: 1, skipped: [], failed: [], bytes: 0, ms: 1 }
  assert.equal(
    await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT # снова' }),
    null,
  )
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.ok(
    await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'ok', 4000),
    'очередь встала после одного отказа входа',
  )

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})

/**
 * Что осталось общим, названо в начале вывода — до первой строки самой попытки.
 *
 * Молчаливая половинчатая изоляция хуже прежней дыры: студент, привыкший, что
 * данные у него свои, на большой таблице испортил бы их всем и не узнал об
 * этом. Строка стоит первой, потому что читают её вместе с ответом, и в ней
 * сразу написано, что делать.
 */
test('переменная, не влезшая в бюджет копий, названа строкой перед выводом попытки', async () => {
  const at = await room()
  assert.equal(await council(at, { studentRun: true, runLimitSec: null }), null)
  assert.equal(await say(at, at.petya, { t: 'council:draft', cellId: at.cell, text: 'PRINT' }), null)
  councilReport = {
    ok: true,
    copied: 2,
    bytes: 10,
    ms: 3,
    skipped: [{ name: 'big', bytes: 1288490188 }],
    failed: [{ name: 'conn', error: 'TypeError: cannot pickle' }],
  }
  assert.equal(await say(at, at.petya, { t: 'council:run', cellId: at.cell }), null)
  assert.ok(await until(async () => ((await runOf(at, at.petya))?.state ?? '') === 'ok', 4000))

  const outputs = (await runOf(at, at.petya))?.outputs ?? []
  const first = outputs[0] as { kind: string; name: string; text: string }
  assert.equal(first.kind, 'stream')
  assert.equal(first.name, 'stderr', 'предупреждение ушло в stdout, к ответу')
  assert.match(first.text, /Переменная `big` \(1,2 ГБ\)/)
  assert.match(first.text, /big = big\.copy\(\)/)
  // Неудачная копия — то же предупреждение, только без размера.
  assert.match(first.text, /Переменную `conn`/)
  // А вывод самой попытки идёт следом и не потерян.
  assert.ok(
    outputs.some((o) => o.kind === 'stream' && /готово/.test((o as { text: string }).text)),
    'вывод попытки пропал за предупреждением',
  )

  const { closeControlRoom } = await import('../server/src/control.js')
  closeControlRoom(at.id)
})
