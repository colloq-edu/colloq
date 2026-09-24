/**
 * One folder walk per upload — and a fresh one.
 *
 * A room walk is a `readdir` plus an `lstat` on each of two thousand entries,
 * synchronously, in the same event loop where the class is going on. An
 * upload asked for it twice: first the broadcast to the room built the tree
 * itself (`broadcastFiles`), and right after it the route built it again for
 * the reply to whoever pressed the button.
 *
 * The second half of the same story is the walk's short memory (workspace.ts ·
 * TREE_MEMO_MS): an upload writes with its own streams, bypassing
 * workspace.ts, and nobody told the memory about it. Two uploads in a row to
 * one room — and the second answered with a tree WITHOUT the file that had
 * just been put there: it lies on disk, but the panel does not have it until
 * the next change to the folder.
 *
 * The same memory is today what most often puts out the second walk too — but
 * the "one tree per request" rule must not rest on a cache with a
 * three-hundred-millisecond window, so walks are counted for real, with a
 * swapped `fs.readdirSync`, and next to it we check that the room and whoever
 * pressed the button get the same tree and that it is not yesterday's.
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

/** Exactly what `send` of the control socket reads. */
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
 * How many times the room root was walked.
 *
 * A walk always starts with a `readdir` of the root itself (workspace.ts ·
 * walkTree), and there is no other way to count walks from outside:
 * `listTree` is called from four different places, and what is measured here
 * is precisely the disk work, not the number of calls.
 */
const real = fs.readdirSync
const walks = new Map<string, number>()
function countingReaddir(target: fs.PathLike, options?: unknown): unknown {
  /*
   * On Linux the walk goes not by name but by descriptor: secure-files.ts
   * opens the root and reads `/proc/self/fd/N`, so that a swapped symlink
   * cannot lead the walk outside. Such a path is translated back into a name —
   * otherwise on Linux zero walks were counted, and the test would check
   * emptiness.
   */
  let at = String(target)
  // secure-files.ts reads `/proc/self/fd/N/.` — with a dot at the end, while
  // readlink understands only `/proc/self/fd/N` itself.
  const fd = /^\/proc\/self\/fd\/(\d+)(?:\/\.)?$/.exec(at)
  if (fd) {
    try {
      at = fs.readlinkSync(`/proc/self/fd/${fd[1]}`)
    } catch {
      // The descriptor is already closed — such a call has nothing to do with
      // the room root.
    }
  }
  if (walks.has(at)) walks.set(at, (walks.get(at) ?? 0) + 1)
  return (real as (p: fs.PathLike, o?: unknown) => unknown)(target, options)
}

/** Walks of the room root during one action. */
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
 * The file list as the room assembled it from everything it was told.
 *
 * A change in the tree travels as a delta (`files:delta`), not as the whole
 * list: one created file cost a room of five hundred people 3.0 MB. So here it
 * is not the last frame but the assembly — exactly the same one the tab does.
 */
const lastFiles = (heard: ControlServerMessage[]): string[] | null => {
  let files: FileEntry[] | null = null
  for (const frame of heard) {
    if (frame.t === 'files') files = frame.files
    else if (frame.t === 'files:delta') files = applyFilesDelta(files ?? [], frame)
  }
  return files ? files.map((f) => f.path) : null
}

test('an upload walks the folder once — for both the room and the reply', async () => {
  const seat = socket()
  handleControlSocket(seat.ws, ROOM, HOST)
  // The first upload warms up what is computed once per room (cleaning up
  // leftovers, used space): it is the tree walk that must be measured, not
  // those.
  await upload(ROOM, HOST, 'warm.csv')

  // Frames are NOT forgotten: the change travels as a delta, and the tree can
  // be assembled from it only on top of the full list the room got in the
  // welcome batch.
  let answer: Answer = { status: 0, files: [] }
  const walked = await walksDuring(ROOM, async () => {
    answer = await upload(ROOM, HOST, 'handout.csv')
  })

  assert.equal(answer.status, 200)
  assert.equal(walked, 1, `the folder was walked ${walked} times instead of once`)
  // One tree for both — and it has the file that was just put there.
  assert.ok(answer.files.includes('handout.csv'), 'the reply does not have the file that was just put there')
  assert.deepEqual(
    lastFiles(seat.heard)?.sort(),
    [...answer.files].sort(),
    'the room and whoever pressed the button saw different file lists',
  )
})

test('a deletion walks the folder once — and the room learns about it from the same tree', async () => {
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

  assert.equal(walked, 1, `the folder was walked ${walked} times instead of once`)
  assert.ok(!files.includes('handout.csv'), 'the deleted file stayed in the reply')
  assert.deepEqual(
    lastFiles(seat.heard)?.sort(),
    [...files].sort(),
    'the room and whoever pressed the button saw different file lists',
  )
})

test('a second upload in a row sees the file of the first, even if nobody is in the room', async () => {
  /*
   * A room without a single socket is not "nothing changed": that is how
   * files are put in, before the class enters. The broadcast exited on an
   * empty room at its very first line, nobody reset the walk memory, and the
   * tree in the reply lagged a whole memory window behind.
   */
  const first = await upload(QUIET, QUIET_HOST, 'handout.csv')
  assert.equal(first.status, 200)
  // The walk memory is filled and holds only the first file — exactly the
  // state in which the second upload answered with a list of just
  // handout.csv.
  assert.deepEqual(
    listTree(QUIET).files.map((f) => f.path),
    ['handout.csv'],
  )

  const second = await upload(QUIET, QUIET_HOST, 'model.py')
  assert.equal(second.status, 200)
  assert.deepEqual(
    [...second.files].sort(),
    ['handout.csv', 'model.py'],
    'the reply to the second upload lagged behind the folder',
  )
  assert.ok(fs.existsSync(path.join(sessionDir(QUIET), 'model.py')))
})
