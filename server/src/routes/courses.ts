/**
 * Курсы и публикации: и то, что делает преподаватель, и то, что читает студент.
 *
 * Публичная половина не спрашивает ничего — ни имени, ни входа, — и потому
 * отдаёт только то, что уже собрано в `publication_steps`. Никакого
 * разворачивания документа Yjs на публичном запросе: это многомегабайтная
 * работа в том же процессе, который в эту минуту ведёт занятие, и без всякого
 * ограничения частоты.
 */
import { Router, type Request, type Response } from 'express'
import { ownerOnly, requireStaff, currentStaff } from '../admin/auth.js'
import { getSession, renameSession } from '../db.js'
import { getSessionDoc } from '../collab/index.js'
import {
  BLOB_MIMES,
  MAX_COURSE_BLURB,
  MAX_COURSE_NAME,
  MAX_STEPS,
  MAX_STEP_LABEL,
  slugOk,
  type CourseItem,
  type PublicCourseView,
  type PublicSeminar,
} from '@shared/publish'
import { candidatesFor } from '../publish/candidates.js'
import { newBlobBag, pageAt, pageOfDoc } from '../publish/build.js'
import { notebookOf } from '../publish/notebook.js'
import {
  createCourse,
  deleteCourse,
  deletePublication,
  getCourse,
  findCourse,
  findPublication,
  getPublication,
  listCourses,
  listPublications,
  publicationOf,
  readBlob,
  readStep,
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

/** Курс с живыми именами семинаров: имя могли поменять после добавления. */
function freshItems(items: CourseItem[]): CourseItem[] {
  return items.map((item): CourseItem => {
    /*
     * У надгробия ссылка на оставшееся чтение — но страницу могли снять уже
     * после удаления комнаты, и тогда вести на неё некуда.
     */
    if (item.kind === 'gone') {
      if (!item.publication) return item
      const pub = getPublication(item.publication.id)
      return pub && pub.state === 'published'
        ? { ...item, publication: { id: pub.id, slug: pub.slug } }
        : { kind: 'gone', name: item.name, at: item.at, publication: null }
    }
    if (item.kind !== 'seminar') return item
    const session = getSession(item.sessionId)
    if (!session) return item
    const pub = publicationOf(item.sessionId)
    return {
      kind: 'seminar',
      sessionId: item.sessionId,
      name: session.name,
      publication:
        pub && pub.state === 'published'
          ? {
              id: pub.id,
              slug: pub.slug,
              publishedAt: pub.publishedAt,
              steps: stepCount(pub.id),
            }
          : null,
    }
  })
}

export function courseRoutes(): Router {
  const router = Router()

  /* ------------------------------------------------------------ панель */

  router.get('/api/admin/courses', requireStaff, (_req, res) => {
    res.json({
      courses: listCourses().map((course) => ({
        ...course,
        items: freshItems(course.items),
      })),
    })
  })

  router.post('/api/admin/courses', requireStaff, (req, res) => {
    const name = str(req.body?.name, MAX_COURSE_NAME)
    if (!name) return bad(res, 'a course needs a name')
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
    if (!course) return res.status(404).json({ error: 'course not found' })
    res.json({ course: { ...course, items: freshItems(course.items) } })
  })

  router.patch('/api/admin/courses/:id', requireStaff, (req, res) => {
    const course = getCourse(req.params.id)
    if (!course) return res.status(404).json({ error: 'course not found' })
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
    if (!course) return res.status(404).json({ error: 'course not found' })
    const incoming: unknown = req.body?.items
    if (!Array.isArray(incoming)) return bad(res, 'items must be an array')

    const items: CourseItem[] = []
    for (const raw of incoming as Record<string, unknown>[]) {
      if (raw?.kind === 'planned') {
        const name = str(raw.name, MAX_COURSE_NAME)
        if (name) items.push({ kind: 'planned', name, when: str(raw.when, 40) })
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
        error: 'этот курс уже изменили',
        course: { ...now, items: freshItems(now.items) },
      })
    }
    res.json({ course: { ...updated, items: freshItems(updated.items) } })
  })

  router.delete('/api/admin/courses/:id', requireStaff, (req, res) => {
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
      return bad(res, 'Только строчные латинские буквы, цифры и дефис — адрес диктуют вслух.')
    }
    const course = req.params.kind === 'course'
    const target = course ? getCourse(req.params.id) : getPublication(req.params.id)
    if (!target) return res.status(404).json({ error: 'not found' })

    const outcome = course ? setCourseSlug(target.id, slug) : setPublicationSlug(target.id, slug)
    if (outcome === 'taken') {
      return res.status(409).json({ error: `Адрес «${slug}» уже занят.` })
    }
    res.json({ slug })
  })

  /* -------------------------------------------------------- публикация */

  /** Из чего можно собрать шаги — и что уже опубликовано. */
  router.get('/api/admin/seminars/:id/publish', requireStaff, (req, res) => {
    const session = getSession(req.params.id)
    if (!session) return res.status(404).json({ error: 'session not found' })
    const pub = publicationOf(session.id)
    res.json({
      title: session.name,
      candidates: candidatesFor(session.id),
      publication: pub ? { ...pub, steps: stepHeadings(pub.id) } : null,
    })
  })

  router.post('/api/admin/seminars/:id/publish', requireStaff, (req, res) => {
    const session = getSession(req.params.id)
    if (!session) return res.status(404).json({ error: 'session not found' })

    const asked: unknown = req.body?.steps
    if (!Array.isArray(asked)) return bad(res, 'steps must be an array')
    if (asked.length > MAX_STEPS) return bad(res, `не больше ${MAX_STEPS} шагов`)

    const blobs = newBlobBag()
    const steps: BuiltStep[] = []
    for (const raw of asked as Record<string, unknown>[]) {
      const label = str(raw?.label, MAX_STEP_LABEL)
      // Безымянный шаг не публикуется: рельса из «Снимок №14» — это не
      // названные моменты, а признание, что назвать их забыли.
      if (!label) continue
      const seq = Number(raw?.seq)
      if (!Number.isFinite(seq)) continue
      const cells = pageAt(session.id, seq, blobs)
      // Версия, которая не разворачивается в тетрадь, шагом быть не может.
      if (!cells) continue
      steps.push({ seq, label, at: Number(raw?.at) || Date.now(), cells })
    }

    /*
     * Последняя страница — тетрадь как она есть сейчас, и она есть всегда.
     * Публикация без неё была бы рассказом о занятии, обрывающимся на середине;
     * `seq: 0` — её постоянный адрес, свободный по построению (AUTOINCREMENT
     * начинается с единицы).
     */
    const { doc } = getSessionDoc(session.id)
    steps.push({
      seq: 0,
      label: str(req.body?.finalLabel, MAX_STEP_LABEL) || 'Тетрадь на момент публикации',
      at: Date.now(),
      cells: pageOfDoc(doc, blobs),
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
    })
  })

  /** Снять страницу. Ссылка остаётся и говорит, что её сняли. */
  router.delete('/api/admin/seminars/:id/publish', requireStaff, (req, res) => {
    const pub = publicationOf(req.params.id)
    if (!pub) return res.status(404).json({ error: 'not published' })
    setPublicationState(pub.id, 'withdrawn')
    res.json({ ok: true })
  })

  router.post('/api/admin/seminars/:id/publish/restore', requireStaff, (req, res) => {
    const pub = publicationOf(req.params.id)
    if (!pub) return res.status(404).json({ error: 'not published' })
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
    if (!pub) return res.status(404).json({ error: 'publication not found' })
    setPublicationState(pub.id, 'withdrawn')
    res.json({ ok: true })
  })

  router.post('/api/admin/publications/:id/restore', requireStaff, (req, res) => {
    const pub = getPublication(req.params.id)
    if (!pub) return res.status(404).json({ error: 'publication not found' })
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
    if (!pub) return res.status(404).json({ error: 'publication not found' })
    deletePublication(pub.id)
    res.json({ ok: true })
  })

  /* ---------------------------------------------------------- публично */

  router.get('/api/c/:id', (req, res) => {
    // По имени или по идентификатору: ссылка, розданная до того, как курсу
    // дали имя, обязана работать и после.
    const course = findCourse(req.params.id)
    if (!course) return res.status(404).json({ error: 'course not found' })
    const view: PublicCourseView = {
      id: course.id,
      slug: course.slug,
      name: course.name,
      blurb: course.blurb,
      items: freshItems(course.items).map((item) =>
        item.kind === 'seminar'
          ? {
              kind: 'seminar',
              // Идентификатор комнаты наружу не уходит: восемь его символов —
              // это всё право писать в неё.
              sessionId: '',
              name: item.name,
              publication: item.publication,
            }
          : item,
      ),
    }
    res.json({ course: view })
  })

  router.get('/api/p/:id', (req, res) => {
    const pub = findPublication(req.params.id)
    if (!pub) return res.status(404).json({ error: 'publication not found' })
    // У осиротевшей страницы комнаты нет, и по `sessionId` курс не найдётся:
    // обратно её держит надгробие. Путь наверх должен оставаться и у неё.
    const course = listCourses().find((c) =>
      c.items.some((i) =>
        i.kind === 'seminar'
          ? pub.sessionId !== null && i.sessionId === pub.sessionId
          : i.kind === 'gone' && i.publication?.id === pub.id,
      ),
    )
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
      return res.status(404).json({ error: 'publication not found' })
    }
    const asked = req.params.seq === 'first' ? null : Number(req.params.seq)
    if (asked !== null && !Number.isFinite(asked)) return bad(res, 'bad step')
    const step = readStep(pub.id, asked)
    if (!step) return res.status(404).json({ error: 'step not found' })
    res.json({ step })
  })

  /**
   * Тетрадь файлом .ipynb.
   *
   * Единственный способ унести код с собой целиком: в самой комнате экспорта
   * нет вовсе, а выделить мышью через несколько ячеек нельзя — каждая из них
   * отдельный редактор. Отдаётся последний шаг, то есть тетрадь на момент
   * публикации.
   *
   * Выводы в файл не кладутся. Notebook без них открывается везде и весит
   * килобайты; с ними это мегабайты base64 в файле, который студент несёт к
   * себе, чтобы запустить заново, — и первым делом всё равно нажмёт «Run».
   */
  router.get('/api/p/:id/notebook.ipynb', (req, res) => {
    const pub = findPublication(req.params.id)
    if (!pub || pub.state !== 'published') return res.status(404).end()
    const body = notebookOf(pub.id)
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
    const known = BLOB_MIMES.has(blob.mime)
    res.setHeader('content-type', known ? blob.mime : 'application/octet-stream')
    res.setHeader('content-disposition', known ? 'inline' : 'attachment; filename="output.bin"')
    res.setHeader('content-security-policy', "sandbox; default-src 'none'")
    res.setHeader('cache-control', 'public, max-age=31536000, immutable')
    res.send(blob.body)
  })

  return router
}
