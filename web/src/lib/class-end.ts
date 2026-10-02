/**
 * The class page after «Завершить занятие», as the room shows it to the
 * teacher: the one question the bell asks, and the lines about the automatic
 * refresh (server/src/publish/class-end.ts sends the frames).
 *
 * Pure decisions, apart from the screen, so the rule "who is asked, and when"
 * can be read and tested in one place.
 */
import { formatDay } from '@shared/class-day'
import { getLocale } from '@shared/i18n'
import type { ControlServerMessage } from '@shared/protocol'

export type PageFrame = Extract<ControlServerMessage, { t: 'page' }>

/** The last word about the class page, stamped when it came. */
export type PageNews = PageFrame & { at: number }

/**
 * Where a teacher manages a class's page: the panel's «Страница занятия»
 * screen. `from=room` gives that screen its way back.
 */
export function pagePickerPath(sessionId: string): string {
  return `/admin/publish/${encodeURIComponent(sessionId)}?from=room`
}

/** «04 · Лики и хаки данных · вс, 4 окт»: the course row a class sits in. */
export function rowLine(row: PageFrame['course'], locale: string = getLocale()): string {
  if (!row) return ''
  const n = row.n !== null ? String(row.n).padStart(2, '0') : null
  const day = row.day ? formatDay(row.day, locale) : null
  return [n, row.title, day].filter(Boolean).join(' · ')
}

export interface OfferContext {
  /** The viewer is the room's teacher. */
  host: boolean
  /** The room itself, not the console, the projector or a council window. */
  inRoom: boolean
  finished: boolean
  /** The room already has a page. */
  published: boolean
  /** The course the room sits in, as the room's own info knows it. */
  course: string | null
  /** The stamp of the offer the teacher answered «Не сейчас» to. */
  dismissed: number
}

/**
 * The offer to pick materials, or `null`.
 *
 * Asked once per bell, of the teacher in the room itself (on the console or
 * the projector a dialog is a plate the hall reads), and only while it is
 * still true: the class is over, the room sits in a course, and it has no
 * page yet. The server sends the frame only in that case; the room checks
 * again because the frame may be read a minute later, after «Продолжить
 * занятие» or a publish from another tab.
 */
export function offerOf(
  news: PageNews | null,
  ctx: OfferContext,
): { course: string; line: string } | null {
  if (!news || news.state !== 'offer' || news.at === ctx.dismissed) return null
  if (!ctx.host || !ctx.inRoom || !ctx.finished || ctx.published) return null
  const course = news.course?.name ?? ctx.course
  return course ? { course, line: rowLine(news.course) } : null
}

/**
 * The line about the automatic refresh, or `null`: every state but the
 * offer (and a 'cancelled', which only takes a 'waiting' back), for the
 * teacher, until closed.
 */
export function pageLineOf(
  news: PageNews | null,
  ctx: { host: boolean; closed: number },
): PageNews | null {
  if (!news || news.state === 'offer' || news.state === 'cancelled') return null
  if (news.at === ctx.closed || !ctx.host) return null
  return news
}
