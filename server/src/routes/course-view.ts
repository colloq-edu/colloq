/**
 * Курс, каким его видят снаружи, — в одном месте.
 *
 * Сборка «курс с живыми именами» была написана дважды: здесь (для панели и для
 * `/api/c/:id`) и в publish/export.ts (для выгрузки на сайт). Делали они одно и
 * то же, но по-разному — выгрузка подставляла `session?.name ?? item.name` и
 * перечитывала публикацию, а маршрут при пропавшей комнате возвращал строку как
 * есть, вместе с устаревшей ссылкой на чтение. То есть сервер и сайт показывали
 * РАЗНЫЕ курсы, и следующая правка правил надгробий попала бы в одну копию из
 * двух.
 *
 * Здесь же и путь наверх со страницы публикации: `courseOfPublication` тоже
 * существовал в двух экземплярах.
 */
import type { Course, CourseItem, PublicCourseView } from '@shared/publish'
import { getSession } from '../db.js'
import { getPublication, listCourses, publicationOf, stepCount } from '../publish/store.js'
import type { Publication } from '../publish/store.js'

/**
 * Строки курса с живыми именами и живыми ссылками на чтение.
 *
 * Имя семинара могли поменять после добавления, страницу — снять или вернуть,
 * а комнату — удалить. Записанное в курсе остаётся адресом, всё остальное
 * спрашивается заново.
 */
export function freshCourseItems(items: CourseItem[]): CourseItem[] {
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
    /*
     * Комнаты может не быть вовсе: удаление ставит надгробие, но если запись
     * состава в этот момент не прошла (гонка в entombSeminar), строка семинара
     * остаётся сиротой. Имя тогда — то, под которым её записали в курс, а
     * чтение спрашивается всё равно: оно живёт своими строками и комнаты не
     * требует.
     */
    const session = getSession(item.sessionId)
    const pub = publicationOf(item.sessionId)
    return {
      kind: 'seminar',
      sessionId: item.sessionId,
      name: session?.name ?? item.name,
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

/**
 * Курс для публичной страницы — и для выгрузки, это одна и та же страница.
 *
 * Идентификатор комнаты наружу не уходит: восемь его символов — это всё право
 * писать в неё.
 */
export function publicCourseView(course: Course): PublicCourseView {
  return {
    id: course.id,
    slug: course.slug,
    name: course.name,
    blurb: course.blurb,
    items: freshCourseItems(course.items).map((item) =>
      item.kind === 'seminar' ? { ...item, sessionId: '' } : item,
    ),
  }
}

/**
 * «В каком курсе этот семинар» — индексом, а не перебором всех курсов.
 *
 * Спрашивают это на входе в комнату (`GET /api/sessions/:id`) и на публичной
 * странице шага — то есть до пятисот раз в первую минуту пары и на каждое
 * обновление вкладки. Ответ собирался перебором: `listCourses()` читает все
 * курсы семестра, разбирает JSON состава у каждого и ищет строку линейно.
 *
 * Индекс живёт пять секунд, и это ровно то, чего он стоит: состав курса правят
 * с панели раз в неделю, а видеть правку через пять секунд — не то же самое,
 * что видеть её через пять минут. Инвалидации по записи здесь нет намеренно:
 * курсы правит publish/store.ts, и просить его звать нас обратно значило бы
 * завести вторую связь между модулями ради задержки, которую никто не заметит.
 *
 * Ключи с приставкой: `s:` — комната, `p:` — страница из надгробия. Восемь
 * символов у тех и других из одного алфавита, и общий ключ однажды показал бы
 * семинару чужой курс.
 */
const INDEX_TTL_MS = 5_000

let index: { at: number; byHandle: Map<string, Course> } | null = null

function courseIndex(): Map<string, Course> {
  const now = Date.now()
  if (index && now - index.at < INDEX_TTL_MS) return index.byHandle
  const byHandle = new Map<string, Course>()
  // Порядок тот же, что был у перебора (`listCourses` — свежие сверху), и
  // первый победивший тоже: семинар, попавший в два курса, показывает тот же
  // из них, что и раньше.
  for (const course of listCourses()) {
    for (const item of course.items) {
      const key =
        item.kind === 'seminar'
          ? `s:${item.sessionId}`
          : item.kind === 'gone' && item.publication
            ? `p:${item.publication.id}`
            : null
      if (key && !byHandle.has(key)) byHandle.set(key, course)
    }
  }
  index = { at: now, byHandle }
  return byHandle
}

/** Курс, в котором состоит комната, — подсказка на экране входа. */
export function courseOfSeminar(sessionId: string): Course | null {
  return courseIndex().get(`s:${sessionId}`) ?? null
}

/**
 * Курс, в котором состоит публикация, — путь наверх со страницы шага.
 *
 * У осиротевшей страницы комнаты нет, и по `sessionId` курс не найдётся:
 * обратно её держит надгробие, и только оно связывает её с курсом.
 *
 * Со списком курсов на руках (выгрузка сайта строит его один раз на все
 * страницы) ищется в нём; без него — индексом выше.
 */
export function courseOfPublication(
  pub: Pick<Publication, 'id' | 'sessionId'>,
  courses?: Course[],
): Course | null {
  if (!courses) {
    const where = courseIndex()
    const byRoom = pub.sessionId !== null ? where.get(`s:${pub.sessionId}`) : undefined
    return byRoom ?? where.get(`p:${pub.id}`) ?? null
  }
  return (
    courses.find((course) =>
      course.items.some((item) =>
        item.kind === 'seminar'
          ? pub.sessionId !== null && item.sessionId === pub.sessionId
          : item.kind === 'gone' && item.publication?.id === pub.id,
      ),
    ) ?? null
  )
}
