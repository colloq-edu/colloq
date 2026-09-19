/**
 * Сообщения пульта, которые до сих пор ни разу не проходили через `dispatch`.
 *
 * Таблица прав проверена построчно (control-rules), замок — отдельно
 * (control-lock), а три двери оставались без единого утверждения: команда
 * `term:interrupt`, где студент мог унести очередь преподавателя, и `tree:mkdir`
 * с `book:open` под правилом `files`. Плюс два места, где отказ был не тем: своя
 * ячейка, открытая преподавателем, и тетрадь, названная именем, которого в
 * комнате нет.
 *
 * Ни сети, ни ядра: сокет поддельный, комната настоящая. Здесь стояло
 * обещание, что отказ обязан прозвучать раньше действия и потому промах
 * проверки «упал бы не утверждением, а попыткой сходить в несуществующий
 * Jupyter». Это неправда, и полагаться на неё нельзя: `JUPYTER_URL` смотрит в
 * мёртвый порт, отказ соединения глотается молча, а разрешающая половина каждой
 * строки уходит туда же и остаётся зелёной. Промах ловит другое — то, что
 * сказано, и то, что после этого лежит в комнате: очередь (`stateOf`), папка на
 * диске, тетрадь в документе. Поэтому у каждой разрешающей половины ниже стоит
 * не только `null`, но и след — или прямо сказано, что следа у неё нет вовсе.
 *
 * Побочный эффект той же тишины: разрешённый `run` будит переподключение ядра,
 * которое живёт до `--test-force-exit`.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { WebSocket, type RawData } from 'ws'
import { createSession, setRules } from '../server/src/db.js'
import { dispatch, handleControlSocket, closeControlRoom } from '../server/src/control.js'
import { getSessionDoc } from '../server/src/collab/index.js'
import { sessionDir } from '../server/src/workspace.js'
import { bookAt, cellId, createCell, findCell, getCells, isCellOpen } from '../shared/notebook.js'
import { LECTURE_ROOM, OPEN_ROOM, type RoomRules } from '../shared/rules.js'
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

function room(rules: Partial<RoomRules> = {}): string {
  const id = `disp-${++rooms}`
  createSession(id, 'Пульт', null)
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

/** Ячейка с кодом в тетради комнаты — и её имя. */
function cell(sessionId: string, source: string): string {
  const { doc } = getSessionDoc(sessionId)
  const made = createCell('code', source)
  doc.transact(() => getCells(doc).push([made]))
  return cellId(made)
}

function stateOf(sessionId: string, id: string): string {
  const found = findCell(getSessionDoc(sessionId).doc, id)
  return (found?.cell.get('state') as string) ?? 'нет такой'
}

/** Вывод в ячейке — то, что «стереть вывод» обязано унести, а отказ обязан оставить. */
function putOutput(sessionId: string, id: string): void {
  const { doc } = getSessionDoc(sessionId)
  const found = findCell(doc, id)
  assert.ok(found, 'ячейки нет в тетради')
  doc.transact(() => {
    const out = new Y.Map<unknown>()
    out.set('kind', 'stream')
    out.set('json', JSON.stringify({ name: 'stdout', text: 'посчитано\n' }))
    ;(found.cell.get('outputs') as Y.Array<unknown>).push([out])
  }, 'server')
}

function outputsOf(sessionId: string, id: string): number {
  const found = findCell(getSessionDoc(sessionId).doc, id)
  return (found?.cell.get('outputs') as Y.Array<unknown> | undefined)?.length ?? -1
}

/* ------------------------------------------------------------- оболочка */

test('Ctrl+C в оболочке: свою команду останавливает автор, чужую — преподаватель', () => {
  /*
   * Развилка `role === 'host' ? undefined : participantId` — это и есть
   * правило: студент, прервавший свой зависший `pip install`, не должен
   * уносить очередь, поставленную преподавателем. Команды в комнате нет
   * вовсе, значит и «своей бегущей» у студента нет — отказ.
   */
  const id = room()
  // Отказ — на языке комнаты, как и вся расшифровка ящика: он всплывает тостом
  // поверх русских вкладок и русского приглашения (аудит · panels-15).
  assert.match(say(id, 'participant', { t: 'term:interrupt' }) ?? '', /Прервать команду/)
  /*
   * У разрешающей половины следа нет и быть не может: оболочки в комнате не
   * открывали, `interruptTerminal` на такой комнате выходит первой строкой, и
   * утверждать здесь можно только молчание. Сказано прямо, чтобы `null` не
   * читался как проверка действия.
   */
  assert.equal(say(id, 'host', { t: 'term:interrupt' }), null)
})

/* ---------------------------------------------------------------- файлы */

test('под правилом files папку заводит преподаватель, а тетрадь спрашивает своё правило', () => {
  const id = room({ files: 'host' })
  assert.match(
    say(id, 'participant', { t: 'tree:mkdir', path: 'разбор' }) ?? '',
    /Создавать файлы/,
    'участник завёл папку в комнате, где файлы преподавательские',
  )
  // Отказ участнику — это ещё и папка, которой на диске не завелось.
  assert.equal(
    fs.existsSync(path.join(sessionDir(id), 'разбор')),
    false,
    'папка завелась, а отказ прозвучал',
  )
  assert.equal(say(id, 'host', { t: 'tree:mkdir', path: 'разбор' }), null)
  // А разрешение — это папка на диске, а не молчание провода.
  assert.ok(
    fs.statSync(path.join(sessionDir(id), 'разбор')).isDirectory(),
    'преподавателю разрешили, а папки нет',
  )

  /*
   * Внести .ipynb в комнату — это ДОБАВИТЬ тетрадь, и правило у этого своё
   * (shared/rules.ts · ownBooks), а не `files`. Раньше стояло второе, и пара
   * «файлы преподавательские, личные тетради разрешены» была невозможна; теперь
   * отказ приходит от своего правила и говорит про него — его же словами, теми,
   * что стоят в строке правил.
   */
  assert.match(
    say(id, 'participant', { t: 'book:open', path: 'прошлая.ipynb' }) ?? '',
    /Личные тетради/,
  )
  /*
   * У преподавателя отказ тоже будет — файла на диске нет, — но ДРУГОЙ: право
   * пройдено, дальше говорит уже сам файл.
   */
  const asHost = say(id, 'host', { t: 'book:open', path: 'прошлая.ipynb' }) ?? ''
  assert.doesNotMatch(asHost, /Свои тетради/)
  // И ни у того, ни у другого тетради в документе не появилось: имя пустое.
  assert.equal(
    bookAt(getSessionDoc(id).doc, 'прошлая.ipynb'),
    null,
    'тетрадь встала в комнату из несуществующего файла',
  )
})

/* --------------------------------------------------------------- запуск */

test('«по одной»: вторая ячейка того же человека в очередь не встаёт', () => {
  /*
   * Потолок берётся из правила, и это делает «по одной» границей, а не
   * счётчиком нажатий: скриптовый цикл получает одну ячейку в очереди и одну
   * фразу. До сих пор проверялся только отказ Run All.
   */
  const id = room({ run: 'single' })
  const first = cell(id, 'x = 1')
  const second = cell(id, 'y = 2')
  assert.equal(say(id, 'participant', { t: 'run', cellId: first }), null)
  assert.equal(stateOf(id, first), 'queued')
  assert.match(say(id, 'participant', { t: 'run', cellId: second }) ?? '', /по одной/)
  assert.equal(stateOf(id, second), 'idle', 'вторая ячейка всё-таки попала в очередь')
  // А преподавателю потолок не мешает: правило про то, чтобы очередь ядра не
  // забивал класс, а не про то, чтобы её не было.
  assert.equal(say(id, 'host', { t: 'run', cellId: second }), null)
  assert.equal(stateOf(id, second), 'queued', 'преподавателю разрешили, а очередь не выросла')
  closeControlRoom(id)
})

/* --------------------------------------------------------- своя ячейка */

test('в открытой ячейке студент стирает свой же вывод', () => {
  /*
   * Право на «стереть вывод одной ячейки» — то же, что на набор в ней, замок
   * включая. Иначе в лекционной тетради студент запускает открытую ячейку,
   * получает трейсбек на пол-экрана и читает «тетрадь принадлежит
   * преподавателю» про ячейку, которую ему открыли.
   */
  const id = room({ ...LECTURE_ROOM })
  const open = cell(id, 'открыто = 1')
  const shut = cell(id, 'закрыто = 1')
  putOutput(id, open)
  putOutput(id, shut)
  assert.equal(say(id, 'host', { t: 'cell:open', cellId: open, open: true }), null)
  assert.equal(isCellOpen(findCell(getSessionDoc(id).doc, open)!.cell), true, 'замок не открылся')

  assert.equal(say(id, 'participant', { t: 'clearOutputs', cellId: open }), null)
  assert.equal(outputsOf(id, open), 0, 'разрешили, а трейсбек так и висит')
  assert.match(
    say(id, 'participant', { t: 'clearOutputs', cellId: shut }) ?? '',
    /редактировать тетрадь может только преподаватель/i,
    'закрытая ячейка отдалась вместе с открытой',
  )
  assert.equal(outputsOf(id, shut), 1, 'вывод закрытой ячейки стёрт, а отказ прозвучал')
  // Вся доска — по-прежнему по правилу `wipe`, и замок её не открывает.
  assert.match(say(id, 'participant', { t: 'clearOutputs' }) ?? '', /доск/i)
  assert.equal(outputsOf(id, shut), 1, 'доска стёрлась после отказа')
})

/* -------------------------------------------------------------- тетради */

test('format с именем убранной тетради не форматирует тетрадь комнаты', () => {
  /*
   * Ниже по дороге неизвестный путь означает «тетрадь не названа» — то есть
   * black переписал бы каждую кодовую ячейку тетради КОМНАТЫ по нажатию во
   * вкладке, которая ещё не узнала об уборке файла.
   */
  const id = room()
  assert.match(say(id, 'host', { t: 'format', book: 'убранная.ipynb' }) ?? '', /тетради/i)
  // Тот же ответ у соседей по смыслу — они его давали и раньше.
  assert.match(say(id, 'host', { t: 'runAll', book: 'убранная.ipynb' }) ?? '', /тетради/i)
  assert.match(
    say(id, 'host', { t: 'clearOutputs', book: 'убранная.ipynb' }) ?? '',
    /тетради/i,
  )
})

/* ----------------------------------------------------------------- кадр */

test('кадр толще потолка не выбрасывается молча', () => {
  /*
   * Для попытки консилиума молчание — худшее, что этот провод может сделать:
   * студент дописывает лист, снимки перестают доезжать без единого слова, а на
   * «Сдать» преподаватель видит текст получасовой давности.
   */
  const id = room()
  const said: string[] = []
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => {
      const message = JSON.parse(frame) as { t: string; message?: string }
      if (message.t === 'error') said.push(message.message ?? '')
    },
    on(event: string, cb: (...args: unknown[]) => void) {
      handlers.set(event, cb)
      return this
    },
    ping() {},
    terminate() {},
    close() {},
  } as unknown as WebSocket
  handleControlSocket(ws, id, who('participant', id))

  const onMessage = handlers.get('message')
  assert.ok(onMessage, 'сокет не подписался на сообщения')
  const huge = JSON.stringify({ t: 'council:draft', cellId: 'c_1', text: 'ы'.repeat(40_000) })
  onMessage(Buffer.from(huge, 'utf8') as unknown as RawData, false)
  assert.match(said[0] ?? '', /слишком длинн/i)
  closeControlRoom(id)
})
