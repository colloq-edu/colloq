/**
 * Место комнаты и занятое имя — на комнату, а не на запрос.
 *
 * Обе величины считались один раз в начале запроса, и обе из-за этого
 * обходились одновременными загрузками. Пятьсот студентов сдают CSV в одну
 * минуту: каждый запрос видел старую сумму и вместе они клали в комнату
 * сколько угодно; двое с одинаковым именем файла оба видели «такого нет», и
 * второй ложился поверх первого молча — без отказа и без пометки «заменил».
 *
 * И третье, из той же семьи: оборванная загрузка. Клиент ушёл посреди тела —
 * busboy не получает 'end', поток файла не закрывается, обещание записи не
 * разрешается никогда. Недописанный `.uploading-*` лежал в папке до ближайшей
 * уборки (порог — час), всё это время занимал место комнаты и отнимал его у
 * следующих загрузок.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../server/src/config.js'
import { createSession, upsertParticipant } from '../server/src/db.js'
import { signToken } from '../server/src/auth.js'
import { app } from '../server/src/app.js'
import { sessionDir } from '../server/src/workspace.js'

let base = ''
let server: http.Server
const rooms: string[] = []

/** `config` объявлен `as const`; подвинуть потолок на один тест — вот так. */
const tunable: { maxSessionBytes: number; maxUploadBytes: number } = config

before(async () => {
  /*
   * Приложение целиком (server/src/app.ts), а не свой express рядом: копия
   * порядка middleware расхождений с продуктом не ловит, она их повторяет.
   */
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  server?.close()
  for (const id of rooms) fs.rmSync(sessionDir(id), { recursive: true, force: true })
})

function room(id: string): string {
  createSession(id, id, null)
  upsertParticipant({ id: 'p_1', sessionId: id, name: 'Нина', avatar: null, role: 'participant' })
  upsertParticipant({ id: 'p_2', sessionId: id, name: 'Гриша', avatar: null, role: 'participant' })
  fs.mkdirSync(sessionDir(id), { recursive: true })
  rooms.push(id)
  return id
}

const bearer = (room: string, who = 'p_1') => ({
  authorization: `Bearer ${signToken({ sessionId: room, participantId: who, role: 'participant' })}`,
})

async function upload(
  id: string,
  name: string,
  bytes: number,
  who = 'p_1',
): Promise<number> {
  const form = new FormData()
  form.append('file', new Blob(['x'.repeat(bytes)]), name)
  const res = await fetch(`${base}/api/sessions/${id}/files`, {
    method: 'POST',
    headers: bearer(id, who),
    body: form,
  })
  return res.status
}

const temps = (id: string) => fs.readdirSync(sessionDir(id)).filter((n) => n.includes('.uploading-'))

test('две загрузки в одну секунду делят потолок комнаты, а не берут его каждая', async () => {
  const id = room('budget-parallel')
  const wasRoom = tunable.maxSessionBytes
  tunable.maxSessionBytes = 4096
  try {
    const [first, second] = await Promise.all([
      upload(id, 'a.csv', 3000),
      upload(id, 'b.csv', 3000, 'p_2'),
    ])
    const codes = [first, second].sort()
    assert.deepEqual(codes, [200, 413], `обе загрузки прошли мимо потолка: ${codes.join(', ')}`)
    // И лишнего на диске не осталось: отказ не платит местом.
    assert.deepEqual(temps(id), [])
  } finally {
    tunable.maxSessionBytes = wasRoom
  }
})

test('двое с одинаковым именем: один кладёт, второй получает отказ', async () => {
  const id = room('budget-samename')
  const [first, second] = await Promise.all([
    upload(id, 'data.csv', 64, 'p_1'),
    upload(id, 'data.csv', 64, 'p_2'),
  ])
  const codes = [first, second].sort()
  /*
   * Второй — не «загружено» молча поверх первого: заменить чужой файл значит
   * удалить его, а удаление преподавательское. Проверка занятости теперь стоит
   * за строку до переименования, а не на событии начала файла.
   */
  assert.deepEqual(codes, [200, 403], `имя досталось обоим: ${codes.join(', ')}`)
  assert.deepEqual(temps(id), [])
})

test('межсайтовый POST в папку семинара не проходит', async () => {
  /*
   * Единственная запись вне /api/admin, которую авторизует одно печенье
   * преподавателя, — и проверка `sameOrigin` висела только на префиксе
   * /api/admin. То есть чужая страница могла положить файл в папку семинара, и
   * держал это только SameSite=Lax браузера.
   */
  const id = room('budget-origin')
  const form = new FormData()
  form.append('file', new Blob(['x']), 'from-elsewhere.txt')
  const res = await fetch(`${base}/api/sessions/${id}/files`, {
    method: 'POST',
    headers: { ...bearer(id), origin: 'https://evil.example' },
    body: form,
  })
  assert.equal(res.status, 403)
  assert.equal(fs.existsSync(`${sessionDir(id)}/from-elsewhere.txt`), false)

  // А со своей страницы — как и раньше.
  const ok = await fetch(`${base}/api/sessions/${id}/files`, {
    method: 'POST',
    headers: { ...bearer(id), origin: base },
    body: (() => {
      const own = new FormData()
      own.append('file', new Blob(['x']), 'from-here.txt')
      return own
    })(),
  })
  assert.equal(ok.status, 200)
})

/** Оборвать загрузку посреди тела: заголовки ушли, файл — наполовину. */
function cutOff(id: string): Promise<void> {
  return new Promise((resolve) => {
    const boundary = '----colloqcut'
    const req = http.request(
      `${base}/api/sessions/${id}/files`,
      {
        method: 'POST',
        headers: {
          ...bearer(id),
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
      },
      () => undefined,
    )
    req.on('error', () => undefined)
    req.write(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="half.csv"\r\n' +
        'Content-Type: text/csv\r\n\r\n',
    )
    req.write('x'.repeat(50_000))
    // Дать серверу принять начало тела и завести временный файл.
    setTimeout(() => {
      req.destroy()
      resolve()
    }, 80)
  })
}

test('оборванная загрузка не оставляет недописанного и возвращает комнате место', async () => {
  const id = room('budget-abort')
  const wasRoom = tunable.maxSessionBytes
  // Потолка ровно на один нормальный файл: если брошенные 50 КБ останутся
  // числиться за комнатой, следующая загрузка получит отказ.
  tunable.maxSessionBytes = 120_000
  try {
    await cutOff(id)
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(temps(id), [], 'недописанный файл остался лежать в комнате')

    assert.equal(await upload(id, 'whole.csv', 100_000), 200, 'место комнаты не вернулось')
    assert.equal(fs.readFileSync(`${sessionDir(id)}/whole.csv`, 'utf8').length, 100_000)
  } finally {
    tunable.maxSessionBytes = wasRoom
  }
})
