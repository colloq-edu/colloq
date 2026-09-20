import { tr } from '@shared/i18n'
/**
 * Курсы и публикации: и то, что делает преподаватель, и то, что читает студент.
 *
 * Публичная половина не спрашивает ничего — ни имени, ни входа, — и потому
 * отдаёт только то, что уже собрано в `publication_steps`. Никакого
 * разворачивания документа Yjs на публичном запросе: это многомегабайтная
 * работа в том же процессе, который в эту минуту ведёт занятие, и без всякого
 * ограничения частоты.
 */
import { Router, type NextFunction, type Request, type Response } from 'express'
import { ownerOnly, requireStaff, currentStaff } from '../admin/auth.js'
import { getSession, renameSession } from '../db.js'
import { visitSessionDoc } from './doc-visit.js'
import {
  spillContentType,
  MAX_COURSE_BLURB,
  MAX_COURSE_NAME,
  MAX_PLANNED_WHEN,
  MAX_STEPS,
  MAX_STEP_LABEL,
  PUBLICATION_NOT_FOUND,
  STEP_NOT_FOUND,
  slugOk,
  type CourseItem,
  type PublicCell,
  type PublicSeminar,
  type SkippedStep,
} from '@shared/publish'
import { courseOfPublication, freshCourseItems, publicCourseView } from './course-view.js'
import { SESSION_MISSING } from '@shared/protocol'
import { candidatesForAsync } from '../publish/candidates.js'
import { newBlobBag, pageOfDoc, pagesAtAsync } from '../publish/build.js'
import { notebookOfStep } from '../publish/notebook.js'
import {
  addressHolder,
  createCourse,
  deleteCourse,
  deletePublication,
  getCourse,
  findCourse,
  findPublication,
  formerSlugs,
  getPublication,
  listCourses,
  listPublications,
  publicationOf,
  readBlob,
  readStep,
  releaseFormerSlug,
  renameCourse,
  setCourseItems,
  setCourseSlug,
  setPublicationSlug,
  setPublicationState,
  stepCount,
  stepHeadings,
  writePublication,
  type BuiltStep,
} from '../publish/store.js'

const str = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : ''

function bad(res: Response, message: string): void {
  res.status(400).json({ error: message })
}

/**
 * Публичный ответ, который не изменился, — 304 и ни одного чтения базы.
 *
 * Метку версии ставим сами, а не отдаём на откуп ETag'у Express: тот считает
 * хэш ПО СОБРАННОМУ телу, то есть после того, как страница уже прочитана и
 * разобрана, — экономится трафик и не экономится работа. Здесь наоборот:
 * `revision` публикации известен по одной индексированной строке, и всё
 * тяжёлое стоит после этой проверки.
 *
 * `max-age` небольшой и без `immutable`: адрес у страницы постоянный, а
 * содержимое переиздают — вечный кэш означал бы разбор недельной давности у
 * того, кто открыл ссылку до переиздания.
 */
const PUBLIC_MAX_AGE_S = 300

function fresh(req: Request, res: Response, tag: string): boolean {
  const etag = `W/"${tag}"`
  res.setHeader('etag', etag)
  res.setHeader('cache-control', `public, max-age=${PUBLIC_MAX_AGE_S}`)
  // Заголовок может нести список меток и `W/` перед каждой — сравниваем по
  // словам, а не строкой целиком.
  const asked = req.headers['if-none-match']
  if (typeof asked !== 'string') return false
  const matched = asked
    .split(',')
    .some((one) => one.trim() === '*' || one.trim() === etag || one.trim() === `"${tag}"`)
  if (!matched) return false
  res.status(304).end()
  return true
}

/**
 * Отклонённое обещание — в обработчик ошибок, а не в пустоту.
 *
 * Express 4 не знает про async: брошенное после первого `await` не доходит до
 * error-middleware вовсе, а запрос не отвечает никогда. Та же обёртка, что в
 * routes/admin-import.ts, и по той же причине.
 */
const wrap =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next)
  }

/**
 * Курс с живыми именами семинаров — тот же, что уходит в выгрузку сайта.
 * Одна функция на оба места: routes/course-view.ts.
 */
const freshItems = freshCourseItems

export function courseRoutes(): Router {
  const router = Router()

  /* ------------------------------------------------------------ панель */

  router.get('/api/admin/courses', requireStaff, (_req, res) => {
    res.json({
      courses: listCourses().map((course) => ({
        ...course,
        items: freshItems(course.items),
        // Прежние имена — вместе с курсом: отказ «этот адрес — прежнее имя
        // такого-то курса» отсылает в его настройки, и там должно быть что
        // показать и что отпустить.
        former: formerSlugs('course', course.id),
      })),
    })
  })

  router.post('/api/admin/courses', requireStaff, (req, res) => {
    const name = str(req.body?.name, MAX_COURSE_NAME)
    if (!name) return bad(res, tr("server.aCourseNeedsAName.42dad0"))
    const teacher = currentStaff(req)
    res.json({
      course: createCourse(
        name,
        str(req.body?.blurb, MAX_COURSE_BLURB) || null,
        teacher?.name ?? null,
      ),
    })
  })

  router.get('/api/admin/courses/:id', requireStaff, (req, res) => {
    const course = getCourse(req.params.id)
    if (!course) return res.status(404).json({ error: tr("server.courseNotFound.0429ec") })
    res.json({
      course: {
        ...course,
        items: freshItems(course.items),
        former: formerSlugs('course', course.id),
      },
    })
  })

  router.patch('/api/admin/courses/:id', requireStaff, (req, res) => {
    const course = getCourse(req.params.id)
    if (!course) return res.status(404).json({ error: tr("server.courseNotFound.0429ec") })
    const blurb =
      req.body?.blurb === undefined ? course.blurb : str(req.body.blurb, MAX_COURSE_BLURB) || null
    res.json({
      course: renameCourse(course.id, str(req.body?.name, MAX_COURSE_NAME) || course.name, blurb),
    })
  })

  /**
   * Состав и порядок — целиком, со сравнением версии.
   *
   * Несовпадение — не ошибка, а гонка: кто-то переставил курс, пока этот экран
   * держал его старым. Ответ 409 несёт список таким, какой он сейчас, чтобы
   * экран показал правду, а не спорил с ней.
   */
  router.put('/api/admin/courses/:id/items', requireStaff, (req, res) => {
    const course = getCourse(req.params.id)
    if (!course) return res.status(404).json({ error: tr("server.courseNotFound.0429ec") })
    const incoming: unknown = req.body?.items
    if (!Array.isArray(incoming)) return bad(res, tr("server.itemsMustBeAnArray.399a2e"))

    const items: CourseItem[] = []
    for (const raw of incoming as Record<string, unknown>[]) {
      if (raw?.kind === 'planned') {
        /*
         * Строка плана без темы — отказ словами, а не пропажа.
         *
         * Раньше такая строка выбрасывалась молча и ответ был 200: пока строки
         * плана заводил только скрипт из таблицы, пустых тем он не присылал.
         * Теперь их набирают руками в панели, и «Добавить» с пустой темой
         * отвечало бы успехом, после которого строки нет, — нумерация
         * остальных недель при этом уже не та, что в расписании.
         */
        const name = str(raw.name, MAX_COURSE_NAME)
        if (!name) return bad(res, tr('server.course.plannedNeedsTopic'))
        items.push({ kind: 'planned', name, when: str(raw.when, MAX_PLANNED_WHEN) })
        continue
      }
      if (raw?.kind === 'gone') {
        /*
         * Ссылка на оставшееся чтение переживает перестановку строк.
         *
         * Не прислали — берём из того, что уже записано: экран, который про эту
         * ссылку ничего не знает, иначе стирал бы её первым же сохранением
         * курса, и надгробие снова становилось тупиком.
         */
        const name = str(raw.name, MAX_COURSE_NAME)
        const at = Number(raw.at) || Date.now()
        const sent = raw.publication as { id?: unknown } | null | undefined
        const known = course.items.find((i) => i.kind === 'gone' && i.name === name && i.at === at)
        const id =
          typeof sent?.id === 'string'
            ? sent.id
            : (known?.kind === 'gone' && known.publication?.id) || null
        const pub = id ? getPublication(id) : null
        items.push({
          kind: 'gone',
          name,
          at,
          publication: pub ? { id: pub.id, slug: pub.slug } : null,
        })
        continue
      }
      const sessionId = str(raw?.sessionId, 64)
      const session = sessionId ? getSession(sessionId) : null
      if (!session) continue
      items.push({
        kind: 'seminar',
        sessionId,
        name: session.name,
        publication: null,
      })
    }

    const rev = Number(req.body?.rev)
    const updated = Number.isFinite(rev) ? setCourseItems(course.id, rev, items) : null
    if (!updated) {
      const now = getCourse(course.id)!
      return res.status(409).json({
        error: tr("server.thisCourseHasAlreadyBeenChanged.70c236"),
        course: { ...now, items: freshItems(now.items) },
      })
    }
    res.json({ course: { ...updated, items: freshItems(updated.items) } })
  })

  /**
   * Стереть курс — владельцем, и только его.
   *
   * Курс — единственный адрес, который раздают потоку целиком (`/c/slug`), и
   * после удаления он отвечает 404 всем, кому его называли: и тем, кто в
   * запросе, и тем, кого в нём нет. Это ровно та черта, по которой удаление
   * семинара и «стереть страницу» уже владельческие («takes work away from
   * people who are not in the request»), а курс жил без неё — любой
   * преподаватель, одним запросом, без подтверждения и без обратного хода.
   *
   * И отсутствующий курс — 404, а не бодрое `{ok:true}`: «удалил» про то, чего
   * не было, — это неправда в ответе.
   */
  router.delete('/api/admin/courses/:id', ownerOnly('delete a course'), (req, res) => {
    if (!getCourse(req.params.id)) return res.status(404).json({ error: tr("server.courseNotFound.0429ec") })
    deleteCourse(req.params.id)
    res.json({ ok: true })
  })

  /**
   * Имя в адресе — курсу или публикации.
   *
   * Отдельным маршрутом, а не полем в PATCH: занятое имя — это отказ, о
   * котором надо сказать словами, а не пропажа среди трёх других полей,
   * сохранившихся успешно.
   */
  router.put('/api/admin/slug/:kind/:id', requireStaff, (req, res) => {
    const raw = req.body?.slug
    const slug = typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : null
    if (slug !== null && !slugOk(slug)) {
      return bad(res, tr("server.useLowercaseLatinLettersDigitsAndHyphens.f004a4"))
    }
    const course = req.params.kind === 'course'
    const target = course ? getCourse(req.params.id) : getPublication(req.params.id)
    if (!target) return res.status(404).json({ error: tr("server.notFound.094b76") })

    const outcome = course ? setCourseSlug(target.id, slug) : setPublicationSlug(target.id, slug)
    if (outcome === 'taken') {
      /*
       * Отказ называет держателя, и это не вежливость.
       *
       * «Адрес «ml-2025» уже занят» — тупик: чаще всего его держит ПРЕЖНЕЕ имя
       * другого курса (тот переименовали, а старое имя осталось адресом ради
       * розданной ссылки), и в списке курсов такой строки не видно вовсе.
       * Преподаватель ищет то, чего нет, и заканчивает адресом с цифрой на
       * конце.
       *
       * Держатель едет отдельным полем, а не только внутри фразы: панель по
       * нему решает, показывать ли «Отпустить прежний адрес» у того же поля
       * (web/src/lib/adminApi.ts · addressHolderOf), а разбирать русский текст
       * ей нечем. `null` значит «занято, а кем — сказать не могу»: экран тогда
       * повторяет фразу и ничего не предлагает.
       *
       * И потому же во фразе больше нет совета идти в настройки чужого курса:
       * отпускают прямо здесь, в двух сантиметрах от неё.
       */
      const holder = addressHolder(course ? 'course' : 'publication', slug!)
      const what = course ? tr("server.course.7c69f0") : tr("server.page.356bb7")
      const whose = course ? tr("server.course.91f120") : tr("server.page.3360a3")
      return res.status(409).json({
        error: !holder
          ? tr("server.theAddressIsAlreadyInUse.795904", { p0: String(slug) })
          : holder.former
            ? tr("server.theAddressIsAFormerNameOf.a5a2ca", { p0: String(slug), p1: whose, p2: holder.name })
            : tr("server.theAddressIsUsedByThe.3ffa25", { p0: String(slug), p1: what, p2: holder.name }),
        holder,
      })
    }
    res.json({ slug })
  })

  /**
   * Отпустить своё прежнее имя.
   *
   * Прежний адрес держится вечно и не зря: ссылка с ним записана в чате группы.
   * Но курс «ml-2025», переименованный в «ml-2025-fall», держал «ml-2025» и для
   * курса следующего года — навсегда, и освободить его было нечем, кроме
   * удаления курса-владельца.
   *
   * Отпускает только владелец и только прежнее: живое имя снимается сменой
   * имени, чужое не трогается вовсе (publish/store.ts · releaseFormerSlug), и
   * 404 здесь означает ровно это — такого прежнего имени у вас нет.
   */
  router.delete('/api/admin/slug/:kind/:id/former/:slug', requireStaff, (req, res) => {
    const kind = req.params.kind === 'course' ? 'course' : 'publication'
    if (!releaseFormerSlug(kind, req.params.id, req.params.slug.toLowerCase())) {
      return res.status(404).json({ error: tr("server.notFound.094b76") })
    }
    res.json({ ok: true })
  })

  /* -------------------------------------------------------- публикация */

  /**
   * Из чего можно собрать шаги — и что уже опубликовано.
   *
   * Кандидаты считаются с уступкой цикла событий (`candidatesForAsync`), а не
   * одним синхронным проходом: на комнате с семестром истории это секунды в том
   * самом процессе, который в эту минуту держит сокеты занятия. Результат тот
   * же — уступка не меняет ни одного поля, — а пара рядом продолжает идти.
   */
  router.get(
    '/api/admin/seminars/:id/publish',
    requireStaff,
    wrap(async (req: Request, res: Response) => {
      const session = getSession(req.params.id)
      if (!session) {
        res.status(404).json({ error: SESSION_MISSING })
        return
      }
      const pub = publicationOf(session.id)
      res.json({
        title: session.name,
        candidates: await candidatesForAsync(session.id),
        publication: pub
          ? { ...pub, steps: stepHeadings(pub.id), former: formerSlugs('publication', pub.id) }
          : null,
      })
    }),
  )

  router.post(
    '/api/admin/seminars/:id/publish',
    requireStaff,
    wrap(async (req: Request, res: Response) => {
      const session = getSession(req.params.id)
      if (!session) {
        res.status(404).json({ error: SESSION_MISSING })
        return
      }

      const asked: unknown = req.body?.steps
      if (!Array.isArray(asked)) return bad(res, tr("server.stepsMustBeAnArray.62b083"))
      if (asked.length > MAX_STEPS) return bad(res, tr("server.noMoreThanSteps.63addd", { p0: MAX_STEPS }))

      /*
       * Что просили — и что из этого шагом не станет.
       *
       * Выпавший момент раньше исчезал молча: преподаватель отмечал семь, а на
       * странице оказывалось шесть. Причины по природе разные — про запрос
       * («без имени», «уже есть в списке») и про занятие («в тетради пусто»,
       * «запись не читается»), — и все они уезжают в ответ (shared/publish.ts ·
       * SkippedStep), чтобы панель могла назвать пропавший момент.
       */
      const wanted: { seq: number; label: string; at: number }[] = []
      const skipped: SkippedStep[] = []
      const seen = new Set<number>()
      for (const raw of asked as Record<string, unknown>[]) {
        const label = str(raw?.label, MAX_STEP_LABEL)
        const seq = Number(raw?.seq)
        /*
         * Адрес шага — номер версии из ленты: целое и больше нуля. Ноль занят
         * последней страницей (ниже), дробное и отрицательное не адресуют
         * ничего. Это не «выпавший момент», а неверный запрос, и отвечать на
         * него надо словами, а не молчанием и не пятисоткой из транзакции.
         */
        if (!Number.isInteger(seq) || seq <= 0) {
          return bad(res, tr("server.chooseAVersionForTheStepA.ec311c"))
        }
        // Безымянный шаг не публикуется: рельса из «Снимок №14» — это не
        // названные моменты, а признание, что назвать их забыли.
        if (!label) {
          skipped.push({ seq, label: '', reason: 'unnamed' })
          continue
        }
        if (seen.has(seq)) {
          skipped.push({ seq, label, reason: 'duplicate' })
          continue
        }
        seen.add(seq)
        wanted.push({ seq, label, at: Number(raw?.at) || Date.now() })
      }

      /*
       * Все шаги — одним проходом истории, а не по проходу на шаг.
       *
       * Каждый шаг разворачивался своим Y.Doc от ближайшего кейфрейма
       * (`buildPageAt`): тетрадь с картинками — мегабайты на шаг, а шагов до
       * сорока, то есть до сорока полных повторов истории подряд. Теперь
       * история проигрывается ОДИН раз на всю публикацию, а к состоянию
       * предыдущего шага доприменяются только строки между ним и следующим
       * (publish/replay.ts, `pagesAtAsync`).
       *
       * Уступка цикла событий никуда не делась — она внутри прохода, между
       * шагами: проекция страницы (хэш каждой картинки, base64 в байты) осталась
       * своя на каждый шаг, а в том же процессе у коллеги идёт пара. Проход сам
       * идёт по возрастанию `seq` и сам отбрасывает повторы; в ответ шаги
       * раскладываются в том порядке, в каком их назвали, потому что порядок
       * рельсы выбирает преподаватель, а не арифметика.
       */
      const blobs = newBlobBag()
      const built = new Map<number, PublicCell[]>()
      for (const [seq, page] of await pagesAtAsync(session.id, [...seen], blobs)) {
        if (page.ok) built.set(seq, page.cells)
        else {
          const named = wanted.find((step) => step.seq === seq)
          skipped.push({ seq, label: named?.label ?? '', reason: page.reason })
        }
      }

      const steps: BuiltStep[] = []
      for (const step of wanted) {
        const cells = built.get(step.seq)
        if (cells) steps.push({ ...step, cells })
      }

      /*
       * Последняя страница — тетрадь как она есть сейчас, и она есть всегда.
       * Публикация без неё была бы рассказом о занятии, обрывающимся на середине;
       * `seq: 0` — её постоянный адрес, свободный по построению (AUTOINCREMENT
       * начинается с единицы).
       *
       * И документ архивной комнаты не остаётся после этого в памяти: публикуют
       * вечером, комнату при этом никто не открывал (routes/doc-visit.ts).
       */
      steps.push({
        seq: 0,
        label: str(req.body?.finalLabel, MAX_STEP_LABEL) || tr("server.notebookAtPublication.33f04f"),
        at: Date.now(),
        cells: visitSessionDoc(session.id, (doc) => pageOfDoc(doc, blobs)),
      })

      const teacher = currentStaff(req)
      const publication = writePublication({
        sessionId: session.id,
        title: session.name,
        by: teacher?.name ?? null,
        steps,
        blobs: blobs.all(),
      })
      res.json({
        publication: { ...publication, steps: stepHeadings(publication.id) },
        skipped,
      })
    }),
  )

  /** Снять страницу. Ссылка остаётся и говорит, что её сняли. */
  router.delete('/api/admin/seminars/:id/publish', requireStaff, (req, res) => {
    const pub = publicationOf(req.params.id)
    if (!pub) return res.status(404).json({ error: tr("server.notPublished.61a0a5") })
    setPublicationState(pub.id, 'withdrawn')
    res.json({ ok: true })
  })

  router.post('/api/admin/seminars/:id/publish/restore', requireStaff, (req, res) => {
    const pub = publicationOf(req.params.id)
    if (!pub) return res.status(404).json({ error: tr("server.notPublished.61a0a5") })
    setPublicationState(pub.id, 'published')
    res.json({ ok: true })
  })

  /**
   * Страницы, ключом которым служит их собственный адрес.
   *
   * Удаление семинара по умолчанию оставляет чтение и обнуляет `session_id` —
   * и все маршруты выше, ключуемые идентификатором комнаты, начинают отвечать
   * 404. Страница при этом жива: отдаётся сервером и выкладывается на сайт
   * каждым `make site`. Снять её было нечем, а на ней мог остаться чужой
   * персональный вывод.
   */
  router.get('/api/admin/publications', requireStaff, (_req, res) => {
    res.json({
      publications: listPublications().map((pub) => ({
        ...pub,
        steps: stepCount(pub.id),
        orphaned: pub.sessionId === null,
      })),
    })
  })

  router.delete('/api/admin/publications/:id', requireStaff, (req, res) => {
    const pub = getPublication(req.params.id)
    if (!pub) return res.status(404).json({ error: PUBLICATION_NOT_FOUND })
    setPublicationState(pub.id, 'withdrawn')
    res.json({ ok: true })
  })

  router.post('/api/admin/publications/:id/restore', requireStaff, (req, res) => {
    const pub = getPublication(req.params.id)
    if (!pub) return res.status(404).json({ error: PUBLICATION_NOT_FOUND })
    setPublicationState(pub.id, 'published')
    res.json({ ok: true })
  })

  /**
   * Совсем: строки страницы стираются, надгробие в курсе теряет ссылку.
   *
   * Владельцем, как и удаление семинара: снять страницу — это одно нажатие и
   * обратимо, а стереть её нечем отменить.
   */
  router.delete('/api/admin/publications/:id/forever', ownerOnly('delete a page'), (req, res) => {
    const pub = getPublication(req.params.id)
    if (!pub) return res.status(404).json({ error: PUBLICATION_NOT_FOUND })
    deletePublication(pub.id)
    res.json({ ok: true })
  })

  /* ---------------------------------------------------------- публично */

  router.get('/api/c/:id', (req, res) => {
    // По имени или по идентификатору: ссылка, розданная до того, как курсу
    // дали имя, обязана работать и после.
    const course = findCourse(req.params.id)
    if (!course) return res.status(404).json({ error: tr("server.courseNotFound.0429ec") })
    res.json({ course: publicCourseView(course) })
  })

  /**
   * Страница семинара — с меткой версии, потому что её открывают потоком.
   *
   * Публикация неизменяема между переизданиями: `revision` растёт при каждой
   * записи, а состояние (снятая/живая) меняется отдельным нажатием — вдвоём
   * они и есть версия ответа. Пятьсот человек, открывающих ссылку на разборе
   * в одну минуту, при совпавшей метке получают 304 и не стоят ни строки
   * базы; пять минут `max-age` — про то, что читают эти страницы подряд,
   * листая шаги, а меняются они раз в неделю.
   *
   * Заголовок ставится ДО чтения шагов, и в этом весь смысл: `stepHeadings`
   * читает таблицу шагов, и отвечать 304 после неё значило бы не сэкономить
   * ничего.
   */
  router.get('/api/p/:id', (req, res) => {
    const pub = findPublication(req.params.id)
    if (!pub) return res.status(404).json({ error: PUBLICATION_NOT_FOUND })
    if (fresh(req, res, `${pub.id}.${pub.revision}.${pub.state}`)) return
    // У осиротевшей страницы комнаты нет, и по `sessionId` курс не найдётся:
    // обратно её держит надгробие. Путь наверх должен оставаться и у неё.
    const course = courseOfPublication(pub)
    const seminar: PublicSeminar = {
      id: pub.id,
      slug: pub.slug,
      title: pub.title,
      state: pub.state,
      publishedAt: pub.publishedAt,
      course: course ? { id: course.id, name: course.name } : null,
      steps: pub.state === 'published' ? stepHeadings(pub.id) : [],
      orphaned: pub.sessionId === null,
    }
    res.json({ seminar })
  })

  router.get('/api/p/:id/step/:seq', (req, res) => {
    const pub = findPublication(req.params.id)
    if (!pub || pub.state !== 'published') {
      return res.status(404).json({ error: PUBLICATION_NOT_FOUND })
    }
    const asked = req.params.seq === 'first' ? null : Number(req.params.seq)
    if (asked !== null && !Number.isFinite(asked)) return bad(res, tr("server.badStep.8811c6"))
    /*
     * Шаг — самое тяжёлое, что отдаёт публичная половина: страница целиком,
     * со всеми текстовыми выводами. И самое неизменное: пока `revision` тот
     * же, это байт в байт тот же шаг.
     */
    if (fresh(req, res, `${pub.id}.${pub.revision}.${req.params.seq}`)) return
    const step = readStep(pub.id, asked)
    if (!step) return res.status(404).json({ error: STEP_NOT_FOUND })
    res.json({ step })
  })

  /**
   * Тетрадь файлом .ipynb.
   *
   * Единственный способ унести код с собой целиком: в самой комнате экспорта
   * нет вовсе, а выделить мышью через несколько ячеек нельзя — каждая из них
   * отдельный редактор. Отдаётся тот шаг, который назвали в `?step=`; без
   * номера — последний, то есть тетрадь на момент публикации.
   *
   * Выводы в файл не кладутся. Notebook без них открывается везде и весит
   * килобайты; с ними это мегабайты base64 в файле, который студент несёт к
   * себе, чтобы запустить заново, — и первым делом всё равно нажмёт «Run».
   */
  router.get('/api/p/:id/notebook.ipynb', (req, res) => {
    const pub = findPublication(req.params.id)
    if (!pub || pub.state !== 'published') return res.status(404).end()
    /*
     * Шаг, на котором стоит читатель, — если он про него сказал.
     *
     * Без `?step=` отдаётся последний, то есть тетрадь на момент публикации:
     * так эта ссылка работала всегда, и так подписана страница. Незнакомый
     * номер — тоже последний шаг, а не 404: скачивание не то место, где
     * человеку объясняют про адреса, и файл в руках лучше пустого отказа.
     */
    const wanted = Number(req.query.step)
    const body = notebookOfStep(pub.id, Number.isInteger(wanted) ? wanted : null)
    if (body.length === 0) return res.status(404).end()
    const name = pub.title.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'notebook'
    res.setHeader('content-type', 'application/x-ipynb+json; charset=utf-8')
    res.setHeader(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(name)}.ipynb`,
    )
    res.send(body)
  })

  /**
   * Крупные куски выводов — по хэшу содержимого.
   *
   * Хэш и есть версия, поэтому кэш вечный: страницу открывают с телефона, а
   * график на полмегабайта не должен приезжать дважды.
   *
   * Тип берётся не из записи, а из белого списка: mime вывода приходит из
   * документа комнаты, то есть от кого угодно, а `content-type` решает, чем
   * ответ будет при переходе по прямой ссылке. `image/svg+xml` — это документ,
   * и скрипт внутри него исполнился бы на origin инстанса, с печеньем того,
   * кто ссылку открыл. Такое и всё незнакомое уходит вложением, которое
   * браузер не показывает; `sandbox` — на случай, если его всё-таки откроют.
   */
  router.get('/api/p/:id/blob/:hash', (req, res) => {
    const pub = findPublication(req.params.id)
    if (!pub || pub.state !== 'published') return res.status(404).end()
    const blob = readBlob(pub.id, req.params.hash)
    if (!blob) return res.status(404).end()
    /*
     * Тип — из белого списка, и не обязательно тот, что записан в строке:
     * фигура plotly отдаётся `application/json`. Документом ни то ни другое не
     * становится, а `application/vnd.plotly.v1+json` в заголовке ничего не
     * добавляет и в чужих руках читается хуже.
     */
    const type = spillContentType(blob.mime)
    res.setHeader('content-type', type ?? 'application/octet-stream')
    res.setHeader('content-disposition', type ? 'inline' : 'attachment; filename="output.bin"')
    res.setHeader('content-security-policy', "sandbox; default-src 'none'")
    res.setHeader('cache-control', 'public, max-age=31536000, immutable')
    res.send(blob.body)
  })

  return router
}
