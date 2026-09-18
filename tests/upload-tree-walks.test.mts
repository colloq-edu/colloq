/**
 * Один обход папки на одну загрузку — и он свежий.
 *
 * Обход комнаты — `readdir` плюс `lstat` на каждую из двух тысяч записей,
 * синхронно, в том же цикле событий, где идёт занятие. Загрузка просила его
 * дважды: сначала рассылка комнате строила дерево сама (`broadcastFiles`), а
 * следом маршрут строил его заново на ответ тому, кто нажал.
 *
 * Вторая половина той же истории — короткая память обхода (workspace.ts ·
 * TREE_MEMO_MS): загрузка пишет своими потоками, мимо workspace.ts, и памяти об
 * этом не говорил никто. Две загрузки подряд в одну комнату — и вторая
 * отвечала деревом БЕЗ только что положенного файла: он лежит на диске, а в
 * панели его нет до следующего изменения папки.
 *
 * Эта же память сегодня чаще всего гасит и второй обход — но правило «одно
 * дерево на запрос» не должно держаться на кэше с окном в триста миллисекунд,
 * поэтому обходы считаются по-настоящему, подменённым `fs.readdirSync`, а
 * рядом проверяется, что комнате и тому, кто нажал, достаётся одно и то же
 * дерево и что оно не вчерашнее.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { applyFilesDelta } from '../web/src/lib/files-delta.js'
import type { ControlServerMessage, FileEntry } from '../shared/protocol.js'
import type { TokenPayload } from '../server/src/auth.js'
import { signToken } from '../server/src/auth.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { closeControlRoom, handleControlSocket } from '../server/src/control.js'
import { shutdownCollab } from '../server/src/collab/index.js'
import { listTree, sessionDir } from '../server/src/workspace.js'
import { fileRoutes } from '../server/src/routes/files.js'
import { sessionRoutes } from '../server/src/routes/sessions.js'

const ROOM = 'walks-room'
const QUIET = 'walks-quiet'
const HOST: TokenPayload = { sessionId: ROOM, participantId: 'p_host', role: 'host' }
const QUIET_HOST: TokenPayload = { sessionId: QUIET, participantId: 'p_quiet', role: 'host' }
let base = ''
let server: http.Server

/** Ровно то, что читает `send` управляющего сокета. */
function socket(): { ws: WebSocket; heard: ControlServerMessage[] } {
  const heard: ControlServerMessage[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => heard.push(JSON.parse(frame) as ControlServerMessage),
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return this
    },
    ping: () => {},
    terminate: () => {},
    close: () => {
      for (const fn of handlers.get('close') ?? []) fn()
    },
  } as unknown as WebSocket
  return { ws, heard }
}

/**
 * Сколько раз обошли корень комнаты.
 *
 * Обход всегда начинается с `readdir` самого корня (workspace.ts · walkTree), и
 * другого способа посчитать обходы снаружи нет: `listTree` зовут четыре разных
 * места, и меряется здесь именно работа с диском, а не число вызовов.
 */
const real = fs.readdirSync
const walks = new Map<string, number>()
function countingReaddir(target: fs.PathLike, options?: unknown): unknown {
  /*
   * На Linux обход идёт не по имени, а по дескриптору: secure-files.ts открывает
   * корень и читает `/proc/self/fd/N`, чтобы подменённый симлинк не увёл обход
   * наружу. Такой путь переводится обратно в имя — иначе на Linux обходов
   * насчитывалось ноль, и тест проверял бы пустоту.
   */
  let at = String(target)
  // secure-files.ts читает `/proc/self/fd/N/.` — с точкой на конце, а readlink
  // понимает только сам `/proc/self/fd/N`.
  const fd = /^\/proc\/self\/fd\/(\d+)(?:\/\.)?$/.exec(at)
  if (fd) {
    try {
      at = fs.readlinkSync(`/proc/self/fd/${fd[1]}`)
    } catch {
      // Дескриптор уже закрыт — такой вызов к корню комнаты отношения не имеет.
    }
  }
  if (walks.has(at)) walks.set(at, (walks.get(at) ?? 0) + 1)
  return (real as (p: fs.PathLike, o?: unknown) => unknown)(target, options)
}

/** Обходы корня комнаты за одно действие. */
async function walksDuring(room: string, act: () => Promise<void>): Promise<number> {
  const root = sessionDir(room)
  walks.set(root, 0)
  await act()
  const seen = walks.get(root) ?? 0
  walks.delete(root)
  return seen
}

before(async () => {
  for (const [id, who] of [
    [ROOM, HOST],
    [QUIET, QUIET_HOST],
  ] as const) {
    createSession(id, 'Комната с файлами', null)
    upsertParticipant({
      id: who.participantId,
      sessionId: id,
      name: 'Ада',
      avatar: null,
      role: 'host',
      tokenHost: true,
    })
    fs.mkdirSync(sessionDir(id), { recursive: true })
  }

  const app = express()
  app.use(express.json())
  app.use(sessionRoutes())
  app.use(fileRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  fs.readdirSync = countingReaddir as typeof fs.readdirSync
})

after(() => {
  fs.readdirSync = real
  closeControlRoom(ROOM)
  server?.close()
  shutdownCollab()
  for (const id of [ROOM, QUIET]) fs.rmSync(sessionDir(id), { recursive: true, force: true })
})

interface Answer {
  status: number
  files: string[]
}

async function upload(room: string, who: TokenPayload, name: string): Promise<Answer> {
  const form = new FormData()
  form.append('file', new Blob(['a,b\n1,2\n']), name)
  const res = await fetch(`${base}/api/sessions/${room}/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${signToken(who)}` },
    body: form,
  })
  const body = (await res.json()) as { files?: { path: string }[] }
  return { status: res.status, files: (body.files ?? []).map((f) => f.path) }
}

/**
 * Список файлов, каким его собрала комната из всего, что ей рассказали.
 *
 * Перемена в дереве едет дельтой (`files:delta`), а не списком целиком: один
 * заведённый файл стоил комнате в пятьсот человек 3.0 МБ. Поэтому здесь не
 * последний кадр, а сборка — ровно та же, что делает вкладка.
 */
const lastFiles = (heard: ControlServerMessage[]): string[] | null => {
  let files: FileEntry[] | null = null
  for (const frame of heard) {
    if (frame.t === 'files') files = frame.files
    else if (frame.t === 'files:delta') files = applyFilesDelta(files ?? [], frame)
  }
  return files ? files.map((f) => f.path) : null
}

test('загрузка обходит папку один раз — и на комнату, и на ответ', async () => {
  const seat = socket()
  handleControlSocket(seat.ws, ROOM, HOST)
  // Первая загрузка греет то, что считается раз на комнату (уборка хвостов,
  // занятое место): мерить надо обход дерева, а не их.
  await upload(ROOM, HOST, 'warm.csv')

  // Кадры НЕ забываются: перемена едет дельтой, и собрать из неё дерево можно
  // только поверх полного списка, который комната получила приветственной пачкой.
  let answer: Answer = { status: 0, files: [] }
  const walked = await walksDuring(ROOM, async () => {
    answer = await upload(ROOM, HOST, 'handout.csv')
  })

  assert.equal(answer.status, 200)
  assert.equal(walked, 1, `папку обошли ${walked} раза вместо одного`)
  // Одно дерево на обоих — и в нём есть только что положенный файл.
  assert.ok(answer.files.includes('handout.csv'), 'в ответе нет только что положенного файла')
  assert.deepEqual(
    lastFiles(seat.heard)?.sort(),
    [...answer.files].sort(),
    'комната и тот, кто нажал, увидели разные списки файлов',
  )
})

test('удаление обходит папку один раз — и комната узнаёт о нём тем же деревом', async () => {
  const seat = socket()
  handleControlSocket(seat.ws, ROOM, HOST)

  let files: string[] = []
  const walked = await walksDuring(ROOM, async () => {
    const res = await fetch(`${base}/api/sessions/${ROOM}/file?path=handout.csv`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${signToken(HOST)}` },
    })
    assert.equal(res.status, 200)
    files = ((await res.json()) as { files: { path: string }[] }).files.map((f) => f.path)
  })

  assert.equal(walked, 1, `папку обошли ${walked} раза вместо одного`)
  assert.ok(!files.includes('handout.csv'), 'удалённый файл остался в ответе')
  assert.deepEqual(
    lastFiles(seat.heard)?.sort(),
    [...files].sort(),
    'комната и тот, кто нажал, увидели разные списки файлов',
  )
})

test('вторая загрузка подряд видит файл первой, даже если в комнате никого', async () => {
  /*
   * Комната без единого сокета — это не «ничего не изменилось»: так файлы и
   * кладут, до входа класса. Рассылка выходила на пустой комнате первой же
   * строкой, память обхода не сбрасывал никто, и дерево в ответе отставало на
   * целое окно памяти.
   */
  const first = await upload(QUIET, QUIET_HOST, 'handout.csv')
  assert.equal(first.status, 200)
  // Память обхода заполнена и в ней только первый файл — ровно то состояние,
  // в котором вторая загрузка отвечала списком из одного handout.csv.
  assert.deepEqual(
    listTree(QUIET).files.map((f) => f.path),
    ['handout.csv'],
  )

  const second = await upload(QUIET, QUIET_HOST, 'model.py')
  assert.equal(second.status, 200)
  assert.deepEqual(
    [...second.files].sort(),
    ['handout.csv', 'model.py'],
    'ответ на вторую загрузку отстал от папки',
  )
  assert.ok(fs.existsSync(path.join(sessionDir(QUIET), 'model.py')))
})
