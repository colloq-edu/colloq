/**
 * The staff list is a list of live credentials. Three independent reviews found
 * real holes here, so the invariants that survived are pinned down.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createHmac } from 'node:crypto'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import {
  countOwners,
  createTeacher,
  deleteTeacher,
  getTeacherByEmail,
  getTeacherByLinkKey,
  linkKeyOf,
  listTeachers,
  normalizeEmail,
  oldestOwner,
  rotateLinkKey,
  updateTeacherIdentity,
  updateTeacherRole,
} from '../server/src/admin/store.js'
import {
  issueStaffCookie,
  readSetupToken,
  staffFromCookieHeader,
  verifySetupToken,
} from '../server/src/admin/auth.js'
import { parseOraclePatch } from '../server/src/admin/settings.js'
import { app } from '../server/src/app.js'
import { createSession, getRules, isFinished, setRules, storedRules } from '../server/src/db.js'
import { COUNCIL_ROOM, isLectureRoom, LECTURE_ROOM, OPEN_ROOM } from '../shared/rules.js'
import { setPublicationSlug, writePublication } from '../server/src/publish/store.js'
import { sessionDir } from '../server/src/workspace.js'

/** issueStaffCookie writes onto express's Response; this is the smallest thing that shape. */
function mintCookie(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

function fresh(name: string, email: string, role: 'owner' | 'teacher' = 'teacher') {
  const teacher = createTeacher({ name, email, role })
  assert.ok(teacher, `could not create ${email}`)
  rotateLinkKey(teacher.id)
  return teacher
}

test('an email is one identity however it was typed', () => {
  assert.equal(normalizeEmail('  Ada.Lovelace@EXAMPLE.EDU '), 'ada.lovelace@example.edu')
  const ada = fresh('Ada', 'Ada.Lovelace@EXAMPLE.EDU', 'owner')
  assert.equal(ada.email, 'ada.lovelace@example.edu')
  // The same person, shouted: a second row here is a second account nobody knows about.
  assert.equal(
    createTeacher({ name: 'Ada again', email: ' ADA.lovelace@example.edu ', role: 'teacher' }),
    null,
  )
  assert.ok(getTeacherByEmail('ada.lovelace@example.edu'))
})

test('a sign-in link is never in a listing', () => {
  const grace = fresh('Grace Hopper', 'grace@example.edu')
  const listed = listTeachers().find((t) => t.id === grace.id)
  assert.ok(listed)
  assert.equal(listed.hasLink, true)
  // hasLink says there is one; the key itself must not ride along.
  assert.equal(JSON.stringify(listed).includes(linkKeyOf(grace.id) ?? 'x'), false)
})

test('rotating a link kills the old one and every session opened from it', () => {
  const katherine = fresh('Katherine Johnson', 'katherine@example.edu')
  const oldKey = linkKeyOf(katherine.id)
  assert.ok(oldKey)
  const cookie = mintCookie(katherine)
  assert.equal(staffFromCookieHeader(cookie)?.id, katherine.id)

  const minted = rotateLinkKey(katherine.id)
  assert.ok(minted)
  assert.notEqual(minted.key, oldKey)
  // Revocation with no session table: the signature is over the link key, so
  // replacing the key invalidates every cookie ever signed with it.
  assert.equal(getTeacherByLinkKey(oldKey), null)
  assert.equal(staffFromCookieHeader(cookie), null)
  assert.equal(staffFromCookieHeader(mintCookie(minted.teacher))?.id, katherine.id)
})

test('deleting a teacher kills their cookie too', () => {
  const pavel = fresh('Pavel', 'pavel@example.edu')
  const cookie = mintCookie(pavel)
  assert.equal(staffFromCookieHeader(cookie)?.id, pavel.id)
  assert.equal(deleteTeacher(pavel.id), true)
  assert.equal(staffFromCookieHeader(cookie), null)
})

test('a forged or absent cookie is nobody', () => {
  const marina = fresh('Marina', 'marina@example.edu')
  const cookie = mintCookie(marina)
  const value = cookie.slice(STAFF_COOKIE.length + 1)
  const [body, sig] = [
    value.slice(0, value.lastIndexOf('.')),
    value.slice(value.lastIndexOf('.') + 1),
  ]

  assert.equal(staffFromCookieHeader(undefined), null)
  assert.equal(staffFromCookieHeader(''), null)
  assert.equal(staffFromCookieHeader(`${STAFF_COOKIE}=nonsense`), null)
  assert.equal(staffFromCookieHeader(`${STAFF_COOKIE}=${body}.tampered`), null)
  // Someone else's signature over your own id.
  const other = mintCookie(fresh('Other', 'other@example.edu'))
  const otherSig = other.slice(other.lastIndexOf('.') + 1)
  assert.equal(staffFromCookieHeader(`${STAFF_COOKIE}=${body}.${otherSig}`), null)
  assert.notEqual(sig, otherSig)
})

test('the owner count tracks promotion and demotion', () => {
  const before = countOwners()
  const dmitry = fresh('Dmitry', 'dmitry@example.edu')
  assert.equal(countOwners(), before)
  updateTeacherRole(dmitry.id, 'owner')
  assert.equal(countOwners(), before + 1)
  updateTeacherRole(dmitry.id, 'teacher')
  assert.equal(countOwners(), before)
})

test('a wrong setup token is refused and a right one is not', () => {
  assert.equal(verifySetupToken('definitely-not-it'), false)
  assert.equal(verifySetupToken(''), false)
  assert.equal(verifySetupToken(null), false)
  assert.equal(verifySetupToken(12345), false)
  /*
   * Положительная половина, без которой имя теста было неправдой: сломанный
   * verifySetupToken, возвращающий false всегда, проходил все четыре проверки
   * выше — а по этому токену идёт первый вход владельца на инстанс и обратная
   * дорога, когда владелец потерял свою ссылку.
   */
  assert.equal(verifySetupToken(readSetupToken()), true)
  // Пробелы и перевод строки — часть договора: токен копируют из терминала.
  assert.equal(verifySetupToken(` ${readSetupToken()}\n`), true)
})

test('a teacher can be renamed without losing their link', () => {
  const mary = fresh('Mary Somervile', 'somervile@example.edu')
  const key = linkKeyOf(mary.id)

  const fixed = updateTeacherIdentity(mary.id, {
    name: 'Mary Somerville',
    email: 'M.Somerville@EXAMPLE.edu ',
  })
  assert.equal(fixed?.name, 'Mary Somerville')
  // Тот же адрес, приведённый к одному виду — как и на заведении.
  assert.equal(fixed?.email, 'm.somerville@example.edu')
  // Смысл правки в том, что ссылка остаётся: иначе это удаление с заводом заново.
  assert.equal(linkKeyOf(mary.id), key)
  assert.ok(getTeacherByEmail('m.somerville@example.edu'))
  assert.equal(getTeacherByEmail('somervile@example.edu'), null)
})

test('a rename onto somebody else’s address is refused, not merged', () => {
  const one = fresh('Sergey', 'sergey@example.edu')
  fresh('Olga', 'olga@example.edu')

  assert.equal(updateTeacherIdentity(one.id, { name: 'Sergey', email: 'olga@example.edu' }), null)
  // Отказ не должен переименовать наполовину.
  assert.equal(getTeacherByEmail('sergey@example.edu')?.id, one.id)
})

/* ------------------------------------------------------- the routes themselves */

/**
 * Правила панели живут в маршрутах, а не в хранилище, и проверялись до сих пор
 * только глазами. Опечатка `< 1` вместо `<= 1` в одной строке оставляет
 * инстанс без владельца — добавить в штат станет некому, и обратная дорога
 * только через шелл на сервере.
 */
let base = ''
let server: http.Server

before(async () => {
  /*
   * Монтируется ПРИЛОЖЕНИЕ, а не его подобие.
   *
   * Здесь стояла своя сборка express с комментарием «тот же порядок, что в
   * index.ts» — и копия порядка расхождений не ловит, она их повторяет:
   * переставь проверку происхождения относительно роутеров в продукте, и эти
   * тесты останутся зелёными. Порядок теперь один на всех (server/src/app.ts),
   * и панельные двери проверяются за тем же, за чем стоят на паре: разбор
   * json, происхождение записи, продление печенья штата.
   */
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

function call(
  method: string,
  path: string,
  init: { cookie?: string; origin?: string; body?: unknown } = {},
): Promise<globalThis.Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.origin ? { origin: init.origin } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

test('the last owner cannot be demoted or removed', async () => {
  const owner = oldestOwner()
  assert.ok(owner)
  assert.equal(countOwners(), 1, 'этот тест имеет смысл только при одном владельце')
  const cookie = mintCookie(owner)

  const demoted = await call('PATCH', `/api/admin/teachers/${owner.id}`, {
    cookie,
    body: { role: 'teacher' },
  })
  assert.equal(demoted.status, 409)
  const removed = await call('DELETE', `/api/admin/teachers/${owner.id}`, { cookie })
  assert.equal(removed.status, 409)
  // И инстанс всё ещё кому-то принадлежит — ради этого всё и затевалось.
  assert.equal(countOwners(), 1)
})

test('a teacher is refused the owner-only doors, and told which one', async () => {
  const teacher = fresh('Anna', 'anna.routes@example.edu')
  const refused = await call('POST', '/api/admin/teachers', {
    cookie: mintCookie(teacher),
    body: { name: 'Someone', email: 'someone.routes@example.edu' },
  })
  assert.equal(refused.status, 403)
  const body = (await refused.json()) as { error: string; reason: string }
  assert.equal(body.reason, 'forbidden')
  // Отказ называет то, что отказано: «only an owner can …» про список штата.
  assert.match(body.error, /список преподавателей/)
  assert.equal(getTeacherByEmail('someone.routes@example.edu'), null)
})

test('a write from somebody else’s page is refused before it is read', async () => {
  const owner = oldestOwner()
  assert.ok(owner)
  const cookie = mintCookie(owner)

  const foreign = await call('POST', '/api/admin/teachers', {
    cookie,
    origin: 'https://evil.example',
    body: { name: 'Mallory', email: 'mallory.routes@example.edu' },
  })
  assert.equal(foreign.status, 403)
  assert.equal(getTeacherByEmail('mallory.routes@example.edu'), null)

  // Со своего происхождения тот же запрос проходит — иначе проверка запрещает всё.
  const own = await call('POST', '/api/admin/teachers', {
    cookie,
    origin: base,
    body: { name: 'Mallory', email: 'mallory.routes@example.edu' },
  })
  assert.equal(own.status, 201)
})

test('the dev server on its own port is not somebody else', async () => {
  /*
   * `npm run dev` отдаёт страницу с :5173, а прокси переписывает Host на адрес
   * сервера — Origin и Host расходятся всегда, и панель отвечала 403 на каждую
   * запись, включая вход. Для браузера это один сайт (SameSite не смотрит на
   * порт), так что уступки здесь нет.
   */
  const owner = oldestOwner()
  assert.ok(owner)
  const dev = await call('POST', '/api/admin/teachers', {
    cookie: mintCookie(owner),
    origin: 'http://localhost:5173',
    body: { name: 'Dev', email: 'dev.routes@example.edu' },
  })
  assert.equal(dev.status, 201)
})

test('the number of files on a card follows the folder', async () => {
  /*
   * Число на карточке считается с кешем — иначе список обходил дерево каждой
   * комнаты на каждую строку, при каждой смене вкладки и раз в двадцать
   * секунд, синхронно и в том же цикле событий, что обслуживает живые комнаты.
   * Цена кеша — ровно одна: он обязан замечать изменение папки.
   */
  const owner = oldestOwner()
  assert.ok(owner)
  const cookie = mintCookie(owner)
  const room = 'admin-files'
  createSession(room, 'Файлы', null)

  const shown = async (): Promise<number> => {
    const res = await call('GET', '/api/admin/seminars', { cookie })
    const rows = (await res.json()) as { id: string; fileCount: number }[]
    return rows.find((row) => row.id === room)?.fileCount ?? -1
  }

  assert.equal(await shown(), 0)
  fs.writeFileSync(path.join(sessionDir(room), 'data.csv'), 'a,b\n')
  assert.equal(await shown(), 1, 'карточка показывает вчерашнее число файлов')
})

test('карточка семинара называет адрес страницы, а не её идентификатор', async () => {
  /*
   * Заданное имя в адресе — это и есть тот адрес, который дали классу; список
   * панели был единственным местом, печатавшим вместо него идентификатор.
   * Печатает и копирует его клиент, но взять `slug` ему неоткуда, пока строка
   * списка его не несёт.
   */
  const owner = oldestOwner()
  assert.ok(owner)
  const room = 'admin-slug'
  createSession(room, 'Публикация', null)
  const pub = writePublication({
    sessionId: room,
    title: 'Неделя первая',
    by: null,
    steps: [],
    blobs: [],
  })
  assert.equal(setPublicationSlug(pub.id, 'week-one'), 'ok')

  const res = await call('GET', '/api/admin/seminars', { cookie: mintCookie(owner) })
  const rows = (await res.json()) as { id: string; publication: { slug: string | null } | null }[]
  assert.equal(rows.find((row) => row.id === room)?.publication?.slug, 'week-one')
})

test('режим при создании — это пресет правил, а присланное ложится поверх', async () => {
  /*
   * Режим не заводит в комнате второго состояния рядом с правилами: 'lecture' —
   * это `LECTURE_ROOM`, записанный в ту же строку, и дальше о том, что в комнате
   * можно, спрашивают одни правила. Два источника правды разъехались бы на
   * первом переключателе в настройках.
   */
  const owner = oldestOwner()
  assert.ok(owner)
  const cookie = mintCookie(owner)
  const made = async (body: unknown): Promise<string> => {
    const res = await call('POST', '/api/admin/seminars', { cookie, body })
    assert.equal(res.status, 201)
    return ((await res.json()) as { id: string }).id
  }

  const lecture = await made({ name: 'Лекция', mode: 'lecture' })
  assert.deepEqual(storedRules(lecture), LECTURE_ROOM)
  assert.equal(isLectureRoom(storedRules(lecture)), true)

  // Нет поля — 'lab', то есть ровно то, чем семинар был всегда.
  const lab = await made({ name: 'Лаборатория' })
  assert.deepEqual(storedRules(lab), OPEN_ROOM)

  // Человек выбрал режим и подкрутил одну строку: подкрученное сильнее пресета.
  const mixed = await made({
    name: 'Лекция, где спрашивают',
    mode: 'lecture',
    rules: { run: 'single', oracle: 'hints' },
  })
  assert.deepEqual(storedRules(mixed), { ...LECTURE_ROOM, run: 'single', oracle: 'hints' })

  // Третий режим — тем же путём: консилиум записывается своим пресетом.
  const council = await made({ name: 'Консилиум', mode: 'council' })
  assert.deepEqual(storedRules(council), COUNCIL_ROOM)
})

test('режим работает у всех дверей: импорт тетради с диска знает консилиум', async () => {
  /*
   * Панель прячет эту дыру: она всегда шлёт полный `rules` рядом с `mode`, и
   * пресет на сервере не спрашивается. Скрипт или клиент постарше шлёт один
   * `mode` — и тогда сервер обязан знать все три, иначе консилиум без правил
   * заводился бы открытой комнатой, где печатают все.
   */
  const owner = oldestOwner()
  assert.ok(owner)
  const cookie = mintCookie(owner)
  const imported = async (mode: string | undefined): Promise<string> => {
    const res = await call('POST', '/api/admin/import/notebook', {
      cookie,
      body: {
        name: `Импорт ${mode ?? 'без режима'}`,
        filename: 'lecture.ipynb',
        cells: [{ cell_type: 'code', source: 'x = 1' }],
        ...(mode ? { mode } : {}),
      },
    })
    assert.equal(res.status, 201)
    return ((await res.json()) as { id: string }).id
  }

  assert.deepEqual(storedRules(await imported('council')), COUNCIL_ROOM)
  assert.deepEqual(storedRules(await imported('lecture')), LECTURE_ROOM)
  // Без режима — лаборатория, как и у общего создания.
  assert.deepEqual(storedRules(await imported(undefined)), OPEN_ROOM)
  // Подкрученная строка сильнее пресета и здесь.
  const res = await call('POST', '/api/admin/import/notebook', {
    cookie,
    body: {
      name: 'Консилиум с подсказками',
      filename: 'x.ipynb',
      cells: [{ cell_type: 'code', source: 'x = 1' }],
      mode: 'council',
      rules: { oracle: 'hints' },
    },
  })
  assert.equal(res.status, 201)
  const id = ((await res.json()) as { id: string }).id
  assert.deepEqual(storedRules(id), { ...COUNCIL_ROOM, oracle: 'hints' })
})

test('панель заканчивает занятие и открывает его обратно', async () => {
  /*
   * Та же дверь, что кнопка в комнате: преподаватель, закрывший вкладку и
   * вспомнивший про это в метро, не должен возвращаться в неё ради одного
   * нажатия. Проверяется вместе с тем, что строка списка отдаёт ВЫБРАННЫЕ
   * правила: нарисовав в настройках ужесточённые, панель записала бы их обратно
   * первым же переключателем — и открывать занятие было бы уже не во что.
   */
  const owner = oldestOwner()
  assert.ok(owner)
  const cookie = mintCookie(owner)
  const room = 'admin-finish'
  createSession(room, 'Занятие', null)
  setRules(room, { ...OPEN_ROOM, run: 'room', edit: 'room' })

  const finished = await call('PATCH', `/api/admin/seminars/${room}`, {
    cookie,
    body: { finished: true },
  })
  assert.equal(finished.status, 200)
  const row = (await finished.json()) as {
    finishedAt: number | null
    status: string
    rules: { run: string }
  }
  assert.equal(typeof row.finishedAt, 'number', 'строка списка не назвала время')
  /*
   * И слово в списке сменилось. Раньше пустая комната и законченное занятие
   * показывались одним и тем же `ended`, так что звонок в панели ничего не
   * менял: закончил — а строка говорит то же, что и до.
   */
  assert.equal(row.status, 'finished', 'слово в списке не заметило звонка')
  assert.equal(row.rules.run, 'room', 'в настройках оказалось ужесточение вместо выбранного')
  assert.equal(isFinished(room), true)
  assert.equal(getRules(room).run, 'host', 'права в комнате остались прежними')

  const resumed = await call('PATCH', `/api/admin/seminars/${room}`, {
    cookie,
    body: { finished: false },
  })
  assert.equal(resumed.status, 200)
  const back = (await resumed.json()) as { finishedAt: number | null; status: string }
  assert.equal(back.finishedAt, null)
  /*
   * И слово вернулось к тому, что происходит само. В эту комнату не заходил
   * никто, поэтому `draft` — «ссылку ещё не давали»; заходили бы и ушли, было
   * бы `idle`. Важно, что «закончено» больше не прилипает к пустой комнате.
   */
  assert.equal(back.status, 'draft')
  assert.equal(isFinished(room), false)
  // И комната вернулась ровно в ту настройку, из которой её закончили.
  assert.equal(storedRules(room).run, 'room')
  assert.equal(getRules(room).run, 'room')
})

test('a cookie older than its month is nobody', () => {
  const boris = fresh('Boris', 'boris.routes@example.edu')
  const key = linkKeyOf(boris.id)
  assert.ok(key)
  const stale = (ageMs: number): string => {
    const body = Buffer.from(JSON.stringify({ tid: boris.id, iat: Date.now() - ageMs })).toString(
      'base64url',
    )
    const sig = createHmac('sha256', process.env.SESSION_SECRET as string)
      .update(`${body}.${key}`)
      .digest('base64url')
    return `${STAFF_COOKIE}=${body}.${sig}`
  }
  // Max-Age — обещание браузера; сервер стареет печенье сам, иначе снятая
  // копия живёт вечно.
  assert.equal(staffFromCookieHeader(stale(31 * 24 * 3_600_000)), null)
  assert.equal(staffFromCookieHeader(stale(60_000))?.id, boris.id)
})

test('a malformed cookie is nobody, not a crash', () => {
  /*
   * `decodeURIComponent('%')` бросает URIError, а ту же функцию зовёт разбор
   * роли на рукопожатии сокета — где исключение уходило в uncaughtException и
   * клало процесс со всеми комнатами. Стоила эта строка одного участника с
   * ссылкой и одной строчки в консоли браузера.
   */
  for (const bad of ['%', '%E0%A4%A', '%%%', 'a%zz']) {
    assert.equal(staffFromCookieHeader(`${STAFF_COOKIE}=${bad}`), null, bad)
  }
  assert.equal(staffFromCookieHeader(`other=1; ${STAFF_COOKIE}=%; third=2`), null)
})

test('a patch of the oracle settings is refused by shape, not by luck', () => {
  assert.ok('error' in parseOraclePatch(null))
  assert.ok('error' in parseOraclePatch('everything'))
  assert.ok('error' in parseOraclePatch({ provider: 'nobody-ships-this' }))
  assert.ok('error' in parseOraclePatch({ model: 42 }))
  assert.ok('error' in parseOraclePatch({ questionsPerHour: 'many' }))
  assert.ok('error' in parseOraclePatch({ slowModeSeconds: 'поменьше' }))
  assert.ok('error' in parseOraclePatch({ defaultMode: 'shout' }))
  // Адрес, на который уедет ключ инстанса, обязан быть адресом.
  assert.ok('error' in parseOraclePatch({ baseUrl: 'evil.example' }))

  const good = parseOraclePatch({ model: 'gpt-4o-mini', questionsPerHour: 5, baseUrl: '' })
  assert.ok('patch' in good)
  assert.equal(good.patch.model, 'gpt-4o-mini')
  // Пустая строка — это «перестань переопределять», а не отказ.
  assert.equal(good.patch.baseUrl, '')
})
