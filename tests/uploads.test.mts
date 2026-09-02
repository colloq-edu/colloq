/**
 * An upload lands whole or not at all.
 *
 * The route used to write straight into the target file, which truncates it
 * first: a cell already reading that CSV watched it shrink to nothing and grow
 * again, read half the rows, and finished *without an error* — the worst of the
 * three possible outcomes. The same window swallowed the old file whenever an
 * upload was cut off partway through.
 *
 * Uploads now write beside the target and rename over it. Every failure path
 * removes its own temp file; the one that cannot is the process dying mid-write,
 * and what that leaves is swept here.
 *
 * Ниже — сам маршрут: до этого ни один тест не отправлял multipart, и триста
 * строк с временными файлами и синхронными вызовами fs внутри обработчиков
 * потока жили без страховки. Одна из них роняла процесс.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../server/src/config.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { fileRoutes } from '../server/src/routes/files.js'
import { signToken } from '../server/src/auth.js'
import { sessionDir, sweepStaleUploads } from '../server/src/workspace.js'

let seq = 0
const rooms: string[] = []
function room(): string {
  const id = `sweep${seq++}`
  rooms.push(id)
  fs.mkdirSync(sessionDir(id), { recursive: true })
  return id
}
const write = (id: string, name: string, body = 'x', ageMs = 0) => {
  const full = path.join(sessionDir(id), name)
  fs.writeFileSync(full, body)
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs)
    fs.utimesSync(full, when, when)
  }
  return full
}
const listing = (id: string) => fs.readdirSync(sessionDir(id)).sort()

after(() => {
  for (const id of rooms) fs.rmSync(sessionDir(id), { recursive: true, force: true })
})

test('a temp left by a dead process is swept', () => {
  const id = room()
  write(id, '.data.csv.uploading-a1b2c3d4', 'half a file', 2 * 60 * 60 * 1000)
  sweepStaleUploads(id)
  assert.deepEqual(listing(id), [])
})

test('an upload still in flight is left alone', () => {
  const id = room()
  write(id, '.data.csv.uploading-a1b2c3d4', 'still arriving')
  sweepStaleUploads(id)
  assert.equal(listing(id).length, 1, 'a live upload was swept out from under itself')
})

test('the room\u2019s own files are never touched', () => {
  const id = room()
  write(id, 'data.csv', 'real', 5 * 60 * 60 * 1000)
  write(id, '.gitkeep', '', 5 * 60 * 60 * 1000)
  write(id, 'notes.uploading-nope.md', 'real too', 5 * 60 * 60 * 1000)
  sweepStaleUploads(id)
  assert.deepEqual(listing(id), ['.gitkeep', 'data.csv', 'notes.uploading-nope.md'])
})

test('a seminar with no folder yet is not an error', () => {
  sweepStaleUploads('a-seminar-that-never-uploaded-anything')
})

test('the temp name is hidden from the room', async () => {
  // listFiles drops dotfiles, which is what keeps a half-arrived upload out of
  // the panel. If the temp naming ever stops starting with a dot, this fails.
  const { listFiles } = await import('../server/src/workspace.js')
  const id = room()
  write(id, '.data.csv.uploading-a1b2c3d4', 'half')
  write(id, 'data.csv', 'whole')
  assert.deepEqual(listFiles(id).map((f) => f.name), ['data.csv'])
})

/* ------------------------------------------------------------- маршрут */

const UP = 'upload-room'
let base = ''
let server: http.Server

before(async () => {
  createSession(UP, 'Uploads', null)
  // Роль решается на каждом запросе и из токена не читается: преподаватель —
  // тот, чей участник заведён хост-токеном (см. roleFor в routes/sessions.ts).
  upsertParticipant({
    id: 'p_host',
    sessionId: UP,
    name: 'Преподаватель',
    avatar: null,
    role: 'host',
    tokenHost: true,
  })
  const app = express()
  app.use(fileRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  base = `http://127.0.0.1:${port}`
})

after(() => server?.close())

const asWho = (role: 'host' | 'participant') =>
  signToken({ sessionId: UP, participantId: `p_${role}`, role })

interface UploadAnswer {
  status: number
  error?: string
  files: string[]
  replaced?: string[]
}

async function upload(
  named: { name: string; body?: string }[],
  opts: { dir?: string; role?: 'host' | 'participant' } = {},
): Promise<UploadAnswer> {
  const form = new FormData()
  // Поле раньше файлов — как его кладёт панель.
  if (opts.dir !== undefined) form.append('dir', opts.dir)
  for (const one of named) {
    form.append('file', new Blob([one.body ?? 'a,b\n1,2\n']), one.name)
  }
  const res = await fetch(`${base}/api/sessions/${UP}/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${asWho(opts.role ?? 'participant')}` },
    body: form,
  })
  const body = (await res.json()) as {
    error?: string
    files?: { path: string }[]
    replaced?: string[]
  }
  return {
    status: res.status,
    error: body.error,
    files: (body.files ?? []).map((f) => f.path),
    replaced: body.replaced,
  }
}

const onDisk = (rel: string) => path.join(sessionDir(UP), rel)

test('файл, уроненный в комнату, ложится в её папку', async () => {
  const answer = await upload([{ name: 'handout.csv' }])
  assert.equal(answer.status, 200)
  assert.ok(answer.files.includes('handout.csv'))
  assert.equal(fs.readFileSync(onDisk('handout.csv'), 'utf8'), 'a,b\n1,2\n')
})

test('поле dir кладёт файл в папку, которой ещё не было', async () => {
  const answer = await upload([{ name: 'model.py', body: 'x = 1\n' }], { dir: 'src/nested' })
  assert.equal(answer.status, 200)
  assert.ok(answer.files.includes('src/nested/model.py'))
})

test('dir, называющий файл, отвечает отказом, а не роняет сервер', async () => {
  /*
   * `mkdirSync` без try/catch в обработчике busboy бросал EEXIST прямо из
   * события потока — мимо express, в `uncaughtException`, а тот делает
   * `process.exit(1)`: один запрос любого участника гасил инстанс со всеми его
   * семинарами. Вариант `data.csv/sub` — то же самое, только ENOTDIR.
   */
  for (const dir of ['handout.csv', 'handout.csv/sub']) {
    const answer = await upload([{ name: 'more.csv' }], { dir })
    assert.equal(answer.status, 400, `dir=${dir}`)
    assert.ok(answer.error && answer.error.length > 20, `нечего сказать про dir=${dir}`)
  }
  // Сервер жив, и файл, чьё имя взяли за папку, цел.
  assert.equal(fs.readFileSync(onDisk('handout.csv'), 'utf8'), 'a,b\n1,2\n')
  const after = await upload([{ name: 'after.csv' }])
  assert.equal(after.status, 200)
})

test('слишком длинное имя объясняется тем же потолком, что и в дереве', async () => {
  // Сто пятьдесят символов — обычная выгрузка из LMS. Раньше загрузка меряла
  // именем в двести, а путь дальше — сотней двадцатью, и человек получал
  // «cannot be used as a file name here» без единой причины.
  const answer = await upload([{ name: 'a'.repeat(146) + '.csv' }])
  assert.equal(answer.status, 400)
  assert.match(answer.error ?? '', /120/)
  assert.match(answer.error ?? '', /150/)
})

test('участник не кладёт файл поверх уже лежащего', async () => {
  const answer = await upload([{ name: 'handout.csv', body: 'подмена\n' }])
  assert.equal(answer.status, 403)
  assert.equal(fs.readFileSync(onDisk('handout.csv'), 'utf8'), 'a,b\n1,2\n')
  // А преподаватель — кладёт, и об этом сказано вслух.
  const asHost = await upload([{ name: 'handout.csv', body: 'a,b\n3,4\n' }], { role: 'host' })
  assert.equal(asHost.status, 200)
  assert.deepEqual(asHost.replaced, ['handout.csv'])
})

test('больше восьми файлов за раз — отказ с числом', async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ name: `many${i}.txt`, body: 'x' }))
  const answer = await upload(many)
  assert.equal(answer.status, 400)
  assert.match(answer.error ?? '', /8/)
})

test('файл крупнее потолка не ложится поверх целого и не оставляет мусора', async () => {
  /*
   * Потолок трогается прямо здесь: гонять пятьдесят мегабайт через сокет ради
   * одной ветки — минута теста на пустом месте, а читает его маршрут на каждом
   * запросе.
   */
  // `config` объявлен `as const`; подвинуть потолок на один тест — вот так.
  const tunable: { maxUploadBytes: number } = config
  const was = tunable.maxUploadBytes
  tunable.maxUploadBytes = 32
  try {
    const answer = await upload([{ name: 'handout.csv', body: 'x'.repeat(4096) }], { role: 'host' })
    assert.equal(answer.status, 413)
    assert.equal(fs.readFileSync(onDisk('handout.csv'), 'utf8'), 'a,b\n3,4\n', 'обрезок лёг поверх')
  } finally {
    tunable.maxUploadBytes = was
  }
  const leftovers = fs.readdirSync(sessionDir(UP)).filter((name) => name.startsWith('.'))
  assert.deepEqual(leftovers, [], 'недописанный файл остался лежать в папке комнаты')
})
