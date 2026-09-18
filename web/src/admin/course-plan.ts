/**
 * Строки «по плану» в курсе — что с ними делает панель.
 *
 * Завести план можно было только скриптом из таблицы (scripts/course-from-sheet.mts)
 * или запросом к API: экран курса строки плана показывал, умел убрать и
 * переставить, но не умел ни завести новую, ни поправить опечатку в теме, ни
 * поставить на её место состоявшееся занятие. Последнее — и есть жизнь такой
 * строки («строка плана заменяется семинаром»), а без него занятие уезжало в
 * конец курса, и его тянули стрелками через весь семестр.
 *
 * Отдельно от экрана, как panel.ts, и по той же причине: это решения о том,
 * какая строка на какой позиции окажется, и ошибку в них видно только на
 * странице курса, которую уже открыл весь поток.
 */
import {
  MAX_COURSE_NAME,
  MAX_PLANNED_WHEN,
  type CourseItem,
  type CourseItemPlanned,
} from '@shared/publish'

/**
 * Строка плана из набранного — или ничего, если темы нет.
 *
 * Обрезка та же, что у сервера (routes/courses.ts · str): обрезать по-своему
 * значило бы показать после сохранения не то, что набрали.
 */
export function plannedRow(name: string, when: string): CourseItemPlanned | null {
  const topic = name.trim().slice(0, MAX_COURSE_NAME)
  if (!topic) return null
  return { kind: 'planned', name: topic, when: when.trim().slice(0, MAX_PLANNED_WHEN) }
}

/** Правится строка, которая была вот такой и стояла вот здесь. */
export interface PlannedTarget {
  at: number
  was: CourseItemPlanned
}

/**
 * Та ли это ещё строка.
 *
 * Правка держит номер строки, а номер — не имя: пока поле открыто, курс могли
 * переставить (стрелки, 409 с чужой перестановкой), и на том же месте теперь
 * другая неделя. Записать правку по номеру значило бы переименовать ЧУЖУЮ
 * тему — молча и на странице, которую читает весь поток.
 */
function stillThere(items: CourseItem[], target: PlannedTarget): boolean {
  const now = items[target.at]
  return now?.kind === 'planned' && now.name === target.was.name && now.when === target.was.when
}

/**
 * Состав после добавления или правки строки плана.
 *
 * Новая встаёт в конец: план заводят по порядку недель, и конец списка — это
 * следующая неделя. `null` — правимой строки на этом месте больше нет.
 */
export function putPlanned(
  items: CourseItem[],
  row: CourseItemPlanned,
  target: PlannedTarget | null,
): CourseItem[] | null {
  if (!target) return [...items, row]
  if (!stillThere(items, target)) return null
  return items.map((item, i) => (i === target.at ? row : item))
}

/**
 * Занятие на место строки плана — позиция в расписании остаётся.
 *
 * Тема строки уходит вместе с ней: у занятия своё имя, и страница курса
 * показывает его. Занятие, которое уже стоит в курсе, второй раз не ставится —
 * две строки одной комнаты на странице курса читаются как две разные недели.
 */
export function seatSeminar(
  items: CourseItem[],
  target: PlannedTarget,
  seminar: { id: string; name: string },
): CourseItem[] | null {
  if (!stillThere(items, target)) return null
  if (items.some((item) => item.kind === 'seminar' && item.sessionId === seminar.id)) return null
  return items.map(
    (item, i): CourseItem =>
      i === target.at
        ? { kind: 'seminar', sessionId: seminar.id, name: seminar.name, publication: null }
        : item,
  )
}

/**
 * Сколько строк в каком состоянии.
 *
 * Список курсов считал только занятия — «2 опубликовано · 1 ещё нет», — и курс
 * с планом на весь семестр выглядел там курсом из трёх строк.
 */
export function courseTally(items: CourseItem[]): {
  published: number
  waiting: number
  planned: number
} {
  let published = 0
  let waiting = 0
  let planned = 0
  for (const item of items) {
    if (item.kind === 'planned') planned += 1
    else if (item.kind === 'seminar') {
      if (item.publication) published += 1
      else waiting += 1
    }
  }
  return { published, waiting, planned }
}
