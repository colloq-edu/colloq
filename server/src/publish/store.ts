/**
 * Курсы и публикации: запросы к ним.
 *
 * СХЕМА этих таблиц — `courses`, `publications`, `publication_steps`,
 * `publication_blobs` — не здесь, а в `db.ts`, вместе с миграциями, и владелец
 * у неё один: `sessions` уже правят два файла (`db.ts` добавляет столбцы
 * окружения и правил, `admin-instance.ts` — автора и архивацию), и третий
 * владелец ровно так схему и расползает. Встречная запись стоит там же, рядом
 * с `CREATE TABLE`.
 *
 * Здесь — запросы к этим таблицам и одна собственная, `publish_addresses`:
 * прежние имена в адресах, о которых больше не знает никто. Шапка обещала
 * «здесь свои таблицы и никто больше в них не пишет» — про таблицы, которых
 * этот модуль не создаёт; читать её так значило считать, что столбец можно
 * добавить отсюда.
 */
import { randomBytes } from 'node:crypto'
import { db } from '../db.js'
import {
  MAX_COURSE_BLURB,
  MAX_COURSE_NAME,
  MAX_STEP_LABEL,
  type AddressHolder,
  type AddressKind,
  type Course,
  type CourseItem,
  type PublicCell,
  type PublicationState,
  type StepHeading,
} from '@shared/publish'

/* ------------------------------------------------------------------- имена */

/**
 * Восемь символов из алфавита, который читают вслух.
 *
 * Тот же приём, что у семинара, и намеренно ДРУГОЙ идентификатор: знание
 * восьми символов комнаты — это всё право писать в неё, так что публичный
 * адрес обязан быть своим. Иначе ссылка, которую дали классу «на почитать»,
 * открывала бы им же живую комнату с правом печатать.
 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

function newId(): string {
  const bytes = randomBytes(8)
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

const clip = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : ''

/* ----------------------------------------------------------------- адреса */

/**
 * Адреса, по которым страницу уже кому-то дали.
 *
 * Имя в адресе можно поменять, а розданную ссылку — нет: она записана в чате
 * группы, в чьих-то закладках и на доске. Адрес по идентификатору переживает
 * появление имени сам собой (`WHERE id = ? OR slug = ?`), а прежнее имя
 * помнить негде — после переименования оно превращалось в 404 и на сайте, и на
 * живом сервере.
 *
 * Снятие страницы адрес не отменяет: ссылка обязана сказать «её сняли», а не
 * «такой страницы здесь нет». Адреса забываются вместе со строкой — в
 * `deleteCourse` и `deletePublication`, когда указывать больше некуда.
 *
 * Единственная таблица публикаций, заведённая здесь, а не в `db.ts`: про неё
 * не знает больше ни один модуль — ни столбца наружу, ни запроса со стороны,
 * — и держать её схему отдельно от единственных запросов к ней было бы дальше
 * от кода, чем от порядка. Всё остальное — в `db.ts`, см. шапку файла.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS publish_addresses (
    kind  TEXT NOT NULL,
    slug  TEXT NOT NULL,
    owner TEXT NOT NULL,
    at    INTEGER NOT NULL,
    PRIMARY KEY (kind, slug)
  )
`)

const rememberAddress = db.prepare(
  'INSERT OR REPLACE INTO publish_addresses (kind, slug, owner, at) VALUES (?, ?, ?, ?)',
)
const forgetAddress = db.prepare('DELETE FROM publish_addresses WHERE kind = ? AND slug = ?')
const forgetAddressesOf = db.prepare('DELETE FROM publish_addresses WHERE kind = ? AND owner = ?')
const selectAddressOwner = db.prepare(
  'SELECT owner FROM publish_addresses WHERE kind = ? AND slug = ?',
)
const selectAddresses = db.prepare(
  'SELECT slug FROM publish_addresses WHERE kind = ? AND owner = ? ORDER BY at',
)

/**
 * Имя сменили: старое остаётся адресом, а новое перестаёт быть чьим-то старым.
 *
 * Живое имя всегда главнее прежнего — иначе по одному адресу лежали бы и
 * страница, и указатель на чужую.
 */
function moveAddress(kind: AddressKind, id: string, was: string | null, now: string | null): void {
  if (was === now) return
  if (was) rememberAddress.run(kind, was, id, Date.now())
  if (now) forgetAddress.run(kind, now)
}

/** Кому принадлежал этот адрес раньше. */
function addressOwner(kind: AddressKind, slug: string): string | null {
  const row = selectAddressOwner.get(kind, slug) as { owner: string } | undefined
  return row ? row.owner : null
}

/** Прежние имена — по ним выгрузка кладёт указатели на нынешний адрес. */
export function formerSlugs(kind: AddressKind, id: string): string[] {
  return (selectAddresses.all(kind, id) as { slug: string }[]).map((row) => row.slug)
}

/**
 * Кто держит этот адрес — чтобы отказ назвал держателя по имени.
 *
 * «Адрес «ml-2025» уже занят» — это тупик: курса с таким адресом в списке нет
 * (его переименовали в «ml-2025-fall»), и преподаватель ищет то, чего не видно.
 * Здесь видно и кем, и как: `former` значит, что имя держит не живой адрес, а
 * память о розданной ссылке — и такое имя владелец может отпустить сам.
 *
 * Сама запись — `AddressHolder` из `@shared/publish`, и копии у неё здесь нет
 * намеренно: ровно это уезжает в теле отказа 409, и панель по нему решает,
 * показывать ли «Отпустить прежний адрес». Второе объявление разъехалось бы с
 * первой же правкой поля.
 */
export function addressHolder(kind: AddressKind, slug: string): AddressHolder | null {
  const found = kind === 'course' ? findCourse(slug) : findPublication(slug)
  if (!found) return null
  const live = found.slug === slug
  const name = kind === 'course' ? (found as Course).name : (found as Publication).title
  return { kind, id: found.id, name, former: !live }
}

/**
 * Отпустить своё прежнее имя.
 *
 * Прежний адрес держится вечно и не зря: ссылка с ним записана в чате группы.
 * Но курс «ml-2025», переименованный в «ml-2025-fall», держал «ml-2025» и для
 * курса следующего года — навсегда, и освободить его было нечем, кроме удаления
 * курса-владельца. Отпускает только владелец и только прежнее имя: живое
 * снимается сменой имени, чужое не трогается вовсе.
 *
 * Цена названа вслух: указатель по этому адресу с выгрузки исчезнет, и старая
 * ссылка станет 404. Это решение владельца, а не побочный эффект.
 */
export function releaseFormerSlug(kind: AddressKind, id: string, slug: string): boolean {
  if (addressOwner(kind, slug) !== id) return false
  forgetAddress.run(kind, slug)
  return true
}

/* ------------------------------------------------------------------ курсы */

interface CourseRow {
  id: string
  slug: string | null
  name: string
  blurb: string | null
  created_at: number
  created_by: string | null
  items: string
  rev: number
}

function toCourse(row: CourseRow): Course {
  let items: CourseItem[] = []
  try {
    const parsed: unknown = JSON.parse(row.items)
    if (Array.isArray(parsed)) items = parsed as CourseItem[]
  } catch {
    // Испорченная строка — курс без семинаров, а не курс, который не читается.
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    blurb: row.blurb,
    createdAt: row.created_at,
    createdBy: row.created_by,
    items,
    rev: row.rev,
  }
}

const insertCourse = db.prepare(`
  INSERT INTO courses (id, name, blurb, created_at, created_by, items, rev)
  VALUES (?, ?, ?, ?, ?, '[]', 0)
`)
const selectCourse = db.prepare('SELECT * FROM courses WHERE id = ?')
/*
 * По имени ИЛИ по идентификатору — одним запросом.
 *
 * Обещание постоянного адреса: ссылка, розданная с восьмисимвольным id, обязана
 * работать и после того, как курсу дали человеческое имя. Ломать её ради
 * красоты нового адреса — ровно то, чего этот раздел не должен делать никогда.
 */
const selectCourseByAny = db.prepare('SELECT * FROM courses WHERE id = ? OR slug = ? LIMIT 1')
const updateCourseSlug = db.prepare('UPDATE courses SET slug = ? WHERE id = ?')
const selectCourses = db.prepare('SELECT * FROM courses ORDER BY created_at DESC')
const updateCourseMeta = db.prepare('UPDATE courses SET name = ?, blurb = ? WHERE id = ?')
const updateCourseItems = db.prepare(
  'UPDATE courses SET items = ?, rev = rev + 1 WHERE id = ? AND rev = ?',
)
const deleteCourseRow = db.prepare('DELETE FROM courses WHERE id = ?')

export function createCourse(name: string, blurb: string | null, by: string | null): Course {
  const id = newId()
  insertCourse.run(
    id,
    clip(name, MAX_COURSE_NAME),
    clip(blurb, MAX_COURSE_BLURB) || null,
    Date.now(),
    by,
  )
  return getCourse(id)!
}

export function getCourse(id: string): Course | null {
  const row = selectCourse.get(id) as CourseRow | undefined
  return row ? toCourse(row) : null
}

/** Курс по адресу — имени или идентификатору. Оба ведут в одно место. */
export function findCourse(handle: string): Course | null {
  const row = selectCourseByAny.get(handle, handle) as CourseRow | undefined
  if (row) return toCourse(row)
  // И по прежнему имени: ссылку, розданную под ним, переименование не отменяет.
  const was = addressOwner('course', handle)
  return was ? getCourse(was) : null
}

/**
 * Назначить курсу имя в адресе.
 *
 * `null` снимает имя; занятое чужим — отказ, а не молчаливая перезапись: два
 * курса по одному адресу означают, что один из них исчез для тех, кому его уже
 * дали.
 */
export function setCourseSlug(id: string, slug: string | null): 'ok' | 'taken' {
  const current = getCourse(id)
  if (slug !== null) {
    const owner = findCourse(slug)
    if (owner && owner.id !== id) return 'taken'
  }
  updateCourseSlug.run(slug, id)
  moveAddress('course', id, current?.slug ?? null, slug)
  return 'ok'
}

export function listCourses(): Course[] {
  return (selectCourses.all() as CourseRow[]).map(toCourse)
}

export function renameCourse(id: string, name: string, blurb: string | null): Course | null {
  const current = getCourse(id)
  if (!current) return null
  updateCourseMeta.run(
    clip(name, MAX_COURSE_NAME) || current.name,
    blurb === null ? null : clip(blurb, MAX_COURSE_BLURB) || null,
    id,
  )
  return getCourse(id)
}

/**
 * Переписать состав и порядок курса, если его не меняли под нами.
 *
 * Сравнение-и-обмен, а не последняя-запись-побеждает: права преподавателя на
 * инстансе общие, экран семинаров перечитывается сам, и двое, переставляющие
 * один курс в одну минуту, иначе молча теряют порядок друг друга. Несовпадение
 * возвращает `null`, и экран показывает список таким, какой он сейчас.
 */
export function setCourseItems(id: string, rev: number, items: CourseItem[]): Course | null {
  const res = updateCourseItems.run(JSON.stringify(items), id, rev)
  return res.changes === 1 ? getCourse(id) : null
}

export function deleteCourse(id: string): void {
  deleteCourseRow.run(id)
  // Адреса удалённого курса освобождаются: указывать им больше некуда.
  forgetAddressesOf.run('course', id)
}

/**
 * Убрать семинар из всех курсов, оставив надгробие.
 *
 * Строка остаётся с именем и датой: курс, из которого молча пропала четвёртая
 * неделя, сломан для того, кто на ней сидел, а нумерация остальных уезжает и
 * перестаёт совпадать с расписанием.
 *
 * И с ссылкой на чтение, если его оставили. Удаление комнаты по умолчанию
 * сохраняет страницу — ссылку у студентов не отозвать, — но `session_id` у неё
 * при этом обнуляется, и надгробие без этой ссылки становилось тупиком:
 * страница открывается по прямому адресу, а с курса до неё не дойти. Ссылку
 * кладёт в строку `orphanPublication`, пока связь ещё есть; если её там нет,
 * ищем сами — семинар могли похоронить и при живой странице.
 */
export function entombSeminar(sessionId: string, name: string): void {
  const live = publicationOf(sessionId)
  for (const course of listCourses()) {
    let touched = false
    const items = course.items.map((item) => {
      if (item.kind !== 'seminar' || item.sessionId !== sessionId) return item
      touched = true
      const link = item.publication ?? live
      return {
        kind: 'gone' as const,
        name,
        at: Date.now(),
        publication: link ? { id: link.id, slug: link.slug } : null,
      }
    })
    if (touched) setCourseItems(course.id, course.rev, items)
  }
}

/**
 * Убрать из надгробий ссылку на страницу, которой больше нет.
 *
 * Публикацию можно удалить совсем — и тогда строка курса, обещающая «страница
 * осталась», обещает 404.
 */
export function forgetPublicationInCourses(pubId: string): void {
  for (const course of listCourses()) {
    let touched = false
    const items = course.items.map((item) => {
      if (item.kind !== 'gone' || item.publication?.id !== pubId) return item
      touched = true
      return { kind: 'gone' as const, name: item.name, at: item.at, publication: null }
    })
    if (touched) setCourseItems(course.id, course.rev, items)
  }
}

/* ------------------------------------------------------------- публикации */

interface PublicationRow {
  id: string
  slug: string | null
  session_id: string | null
  title: string
  state: string
  published_at: number
  published_by: string | null
  revision: number
  orphaned_at: number | null
}

export interface Publication {
  id: string
  slug: string | null
  sessionId: string | null
  title: string
  state: PublicationState
  publishedAt: number
  publishedBy: string | null
  revision: number
  orphanedAt: number | null
}

function toPublication(row: PublicationRow): Publication {
  return {
    id: row.id,
    slug: row.slug,
    sessionId: row.session_id,
    title: row.title,
    state: row.state === 'withdrawn' ? 'withdrawn' : 'published',
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    revision: row.revision,
    orphanedAt: row.orphaned_at,
  }
}

const selectPub = db.prepare('SELECT * FROM publications WHERE id = ?')
const selectPubByAny = db.prepare('SELECT * FROM publications WHERE id = ? OR slug = ? LIMIT 1')
const updatePubSlug = db.prepare('UPDATE publications SET slug = ? WHERE id = ?')
const selectPubForSession = db.prepare('SELECT * FROM publications WHERE session_id = ?')
const selectPubs = db.prepare('SELECT * FROM publications ORDER BY published_at DESC')
const insertPub = db.prepare(`
  INSERT INTO publications (id, session_id, title, state, published_at, published_by, revision)
  VALUES (@id, @session_id, @title, 'published', @published_at, @published_by, 1)
`)
const bumpPub = db.prepare(`
  UPDATE publications
  SET title = ?, state = 'published', published_at = ?, published_by = ?, revision = revision + 1
  WHERE id = ?
`)
const setPubState = db.prepare('UPDATE publications SET state = ? WHERE id = ?')
const orphanPub = db.prepare(
  'UPDATE publications SET session_id = NULL, orphaned_at = ? WHERE session_id = ?',
)
const deletePubRow = db.prepare('DELETE FROM publications WHERE id = ?')

const clearSteps = db.prepare('DELETE FROM publication_steps WHERE pub = ?')
const insertStep = db.prepare(`
  INSERT INTO publication_steps (pub, seq, ord, label, at, page)
  VALUES (@pub, @seq, @ord, @label, @at, @page)
`)
/*
 * Заголовки без самой страницы.
 *
 * `page` — это все текстовые выводы шага целиком: лог обучения, трейсбеки,
 * таблицы в text/html. Читать и разбирать их ради одного числа приходилось на
 * каждый публичный запрос курса, в том самом процессе, который в эту минуту
 * ведёт занятие. Длину массива считает SQLite; `json_valid` — на случай строки,
 * записанной не нами: испорченная страница должна дать ноль, а не ошибку
 * запроса.
 */
const selectHeadings = db.prepare(`
  SELECT seq, label, at,
         CASE WHEN json_valid(page) THEN json_array_length(page) ELSE 0 END AS cell_count
  FROM publication_steps WHERE pub = ? ORDER BY ord
`)
const countSteps = db.prepare('SELECT COUNT(*) AS n FROM publication_steps WHERE pub = ?')
const selectStep = db.prepare(
  'SELECT seq, label, at, page FROM publication_steps WHERE pub = ? AND seq = ?',
)
const selectFirstStep = db.prepare(
  'SELECT seq, label, at, page FROM publication_steps WHERE pub = ? ORDER BY ord LIMIT 1',
)

const clearBlobs = db.prepare('DELETE FROM publication_blobs WHERE pub = ?')
const insertBlob = db.prepare(
  'INSERT OR IGNORE INTO publication_blobs (pub, hash, mime, body) VALUES (?, ?, ?, ?)',
)
const selectBlob = db.prepare('SELECT mime, body FROM publication_blobs WHERE pub = ? AND hash = ?')

export function getPublication(id: string): Publication | null {
  const row = selectPub.get(id) as PublicationRow | undefined
  return row ? toPublication(row) : null
}

/** Публикация по адресу — имени, идентификатору или прежнему имени. */
export function findPublication(handle: string): Publication | null {
  const row = selectPubByAny.get(handle, handle) as PublicationRow | undefined
  if (row) return toPublication(row)
  const was = addressOwner('publication', handle)
  return was ? getPublication(was) : null
}

export function setPublicationSlug(id: string, slug: string | null): 'ok' | 'taken' {
  const current = getPublication(id)
  if (slug !== null) {
    const owner = findPublication(slug)
    if (owner && owner.id !== id) return 'taken'
  }
  updatePubSlug.run(slug, id)
  moveAddress('publication', id, current?.slug ?? null, slug)
  return 'ok'
}

export function publicationOf(sessionId: string): Publication | null {
  const row = selectPubForSession.get(sessionId) as PublicationRow | undefined
  return row ? toPublication(row) : null
}

/**
 * Все страницы, включая те, за которыми уже нет комнаты.
 *
 * Осиротевшая публикация не находится больше ни по одному адресу панели:
 * семинара нет, а маршруты снятия ключуются его идентификатором. Без этого
 * списка снять такую страницу можно было только правкой базы руками.
 */
export function listPublications(): Publication[] {
  return (selectPubs.all() as PublicationRow[]).map(toPublication)
}

export interface BuiltStep {
  seq: number
  label: string
  at: number
  cells: PublicCell[]
}

/**
 * Записать публикацию целиком: шаги и крупные куски выводов.
 *
 * Одной транзакцией, и старые шаги стираются: публикация — это снимок, а не
 * накопление. Адрес при этом сохраняется — студент, у которого ссылка с
 * прошлой недели, попадает туда же.
 */
export function writePublication(input: {
  sessionId: string
  title: string
  by: string | null
  steps: BuiltStep[]
  blobs: { hash: string; mime: string; body: Buffer }[]
}): Publication {
  const existing = publicationOf(input.sessionId)
  const id = existing?.id ?? newId()
  const now = Date.now()
  /*
   * Один момент — одна строка: `publication_steps` ключуется парой (pub, seq),
   * и два шага с одним `seq` роняли всю транзакцию SQLITE_CONSTRAINT'ом, то
   * есть пятисоткой без единого слова о причине. Побеждает последний: `seq: 0`
   * — постоянный адрес последней страницы, и её маршрут дописывает в конец,
   * поверх всего, что могло прийти под тем же номером снаружи.
   */
  const lastAt = new Map(input.steps.map((step, index) => [step.seq, index]))
  const steps = input.steps.filter((step, index) => lastAt.get(step.seq) === index)

  db.transaction(() => {
    if (existing) bumpPub.run(input.title, now, input.by, id)
    else
      insertPub.run({
        id,
        session_id: input.sessionId,
        title: input.title,
        published_at: now,
        published_by: input.by,
      })
    clearSteps.run(id)
    clearBlobs.run(id)
    steps.forEach((step, index) => {
      insertStep.run({
        pub: id,
        seq: step.seq,
        ord: index,
        label: clip(step.label, MAX_STEP_LABEL),
        at: step.at,
        page: JSON.stringify(step.cells),
      })
    })
    for (const blob of input.blobs) insertBlob.run(id, blob.hash, blob.mime, blob.body)
  })()
  // Рельса этой страницы известна прямо здесь: шаги только что собраны, и их
  // ячейки посчитаны. Порядок тот же, что у `ORDER BY ord` — порядок записи.
  keepRail(
    id,
    steps.map((step) => ({
      seq: step.seq,
      label: clip(step.label, MAX_STEP_LABEL),
      at: step.at,
      cellCount: step.cells.length,
    })),
  )

  return getPublication(id)!
}

export function setPublicationState(id: string, state: PublicationState): void {
  setPubState.run(state, id)
}

/**
 * Семинар удалили, а чтение решили оставить.
 *
 * Ссылка на страницу перекладывается в строки курсов ДО того, как связь с
 * комнатой исчезнет: `session_id` сейчас обнулится, и найти страницу по
 * семинару станет нечем. Дальше строку заменит надгробие, и ссылка останется
 * в нём — иначе курс, единственный адрес, который дают классу, ведёт в тупик.
 */
export function orphanPublication(sessionId: string): void {
  const pub = publicationOf(sessionId)
  if (pub) {
    for (const course of listCourses()) {
      let touched = false
      const items = course.items.map((item) => {
        if (item.kind !== 'seminar' || item.sessionId !== sessionId) return item
        touched = true
        return {
          ...item,
          publication: {
            id: pub.id,
            slug: pub.slug,
            publishedAt: pub.publishedAt,
            steps: stepCount(pub.id),
          },
        }
      })
      if (touched) setCourseItems(course.id, course.rev, items)
    }
  }
  orphanPub.run(Date.now(), sessionId)
}

/** Семинар удалили вместе с чтением. */
export function deletePublication(id: string): void {
  db.transaction(() => {
    clearSteps.run(id)
    clearBlobs.run(id)
    deletePubRow.run(id)
    forgetAddressesOf.run('publication', id)
  })()
  forgetRail(id)
  // Надгробие в курсе обещало «страница осталась» — теперь не осталась.
  forgetPublicationInCourses(id)
}

interface StepRow {
  seq: number
  label: string
  at: number
  page: string
}

interface HeadingRow {
  seq: number
  label: string
  at: number
  cell_count: number
}

function parsePage(row: StepRow): PublicCell[] {
  try {
    const parsed: unknown = JSON.parse(row.page)
    return Array.isArray(parsed) ? (parsed as PublicCell[]) : []
  } catch {
    return []
  }
}

/**
 * Рельса шагов — из памяти, а не разбором страниц на каждый публичный запрос.
 *
 * Числа ячеек считает SQLite (`json_array_length` в `selectHeadings`), и стоит
 * это разбора ПОЛНОГО текста каждой страницы: страница — это все текстовые
 * выводы шага, лог обучения на мегабайты. Спрашивают рельсу на каждом открытии
 * публичной страницы, то есть до пятисот раз в первую минуту разбора, — и
 * каждый раз заново, ради сорока маленьких чисел.
 *
 * Кэш здесь надёжнее любого времени жизни: шаги публикации меняются ровно
 * двумя способами, и оба в этом файле — переиздание (`writePublication`) и
 * стирание (`deletePublication`). Снятие страницы шагов не трогает.
 *
 * Переиздание рельсу не сбрасывает, а КЛАДЁТ: шаги в этот момент собраны и
 * лежат в памяти, считать их ячейки второй раз, да ещё разбором текста, не за
 * чем. Так разбор остаётся ровно один — первое чтение страницы, изданной до
 * запуска процесса.
 *
 * Столбцом `cell_count` он не стоил бы и того и переживал бы перезапуск, но
 * схему публикаций держит db.ts («владелец схемы один»), и заводить второго
 * владельца ради одного числа — та самая цена, о которой там сказано.
 */
const RAILS_KEPT = 200
const rails = new Map<string, StepHeading[]>()

function forgetRail(pub: string): void {
  rails.delete(pub)
}

function keepRail(pub: string, rail: StepHeading[]): void {
  // Страниц за семестр — десятки; потолок здесь на случай инстанса, живущего
  // годами, и выселяет он самую давнюю запись, а не всю память разом.
  if (!rails.has(pub) && rails.size >= RAILS_KEPT) {
    const oldest = rails.keys().next()
    if (!oldest.done) rails.delete(oldest.value)
  }
  rails.set(pub, rail)
}

export function stepHeadings(pub: string): StepHeading[] {
  const known = rails.get(pub)
  // Копией: массив общий, а уезжает он в тела ответов, где его никто не обязан
  // считать чужим.
  if (known) return [...known]
  const built = (selectHeadings.all(pub) as HeadingRow[]).map((row) => ({
    seq: row.seq,
    label: row.label,
    at: row.at,
    cellCount: row.cell_count,
  }))
  keepRail(pub, built)
  return [...built]
}

/** Сколько шагов — там, где нужно только число. */
export function stepCount(pub: string): number {
  return Number((countSteps.get(pub) as { n: number }).n)
}

export function readStep(pub: string, seq: number | null): BuiltStep | null {
  const row = (seq === null ? selectFirstStep.get(pub) : selectStep.get(pub, seq)) as
    | StepRow
    | undefined
  if (!row) return null
  return { seq: row.seq, label: row.label, at: row.at, cells: parsePage(row) }
}

export function readBlob(pub: string, hash: string): { mime: string; body: Buffer } | null {
  const row = selectBlob.get(pub, hash) as { mime: string; body: Buffer } | undefined
  return row ? { mime: row.mime, body: row.body } : null
}
