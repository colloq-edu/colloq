/**
 * What «Завершить занятие» does for the class page.
 *
 * The goal is that the teacher types nothing per class: after the first
 * publish of a course's room, pressing the bell is all it takes. So when a
 * class finishes, from the room or from the panel:
 *
 *   1. its course row gets the day, if it has none (the instance-zone day of
 *      the finish), so the course page can place it;
 *   2. a room in a course with no page yet asks its host to pick materials
 *      ('offer');
 *   3. a page whose pick says «Обновлять страницу при каждом «Завершить
 *      занятие»» is rebuilt from that pick, but only once nothing is
 *      computing: cells queued before the bell keep running after it
 *      (control.ts · class:finish), and their outputs are what the page is
 *      for. The wait is capped at two minutes; a cell that runs longer does
 *      not hold the page hostage.
 *
 * A rebuild never publishes something nobody confirmed: a new secret-like
 * string or student name in a cell or a picked file stops it ('held'), and
 * the page stays as it was until the teacher looks. Resuming the class never
 * touches the page; a class resumed, a page withdrawn or a refresh switched
 * off while the rebuild waits is left alone, and a host shown the spinner
 * hears 'cancelled'.
 */
import { isClassDay } from '@shared/class-day'
import { tr } from '@shared/i18n'
import type { ControlServerMessage, PageAfterClass } from '@shared/protocol'
import { publicationAddress, type PublishCheck } from '@shared/publish'
import { recordAdminEvent } from '../admin/audit-log.js'
import { finishedAt } from '../db.js'
import { sessionComputing } from '../kernel/index.js'
import { courseOfSeminar, courseRows, forgetCourseIndex } from '../routes/course-view.js'
import { instanceToday } from '../time-zone.js'
import { refreshPage } from './materials.js'
import { publicationOf, rewriteCourseRows } from './store.js'

export type PageFrame = Extract<ControlServerMessage, { t: 'page' }>

export interface ClassEndDeps {
  /** Whether a cell or an attempt is running or queued in any notebook of the room. */
  computing: (sessionId: string) => boolean
  /** Tell the room's teacher consoles. */
  tell: (sessionId: string, frame: PageFrame) => void
  sleep: (ms: number) => Promise<void>
  maxWaitMs: number
  pollMs: number
}

/*
 * The consoles are reached through control.ts, which imports this module to
 * call it; it hands its sender over at load instead of being imported back.
 */
let teller: ClassEndDeps['tell'] = () => {}

export function setPageTeller(tell: ClassEndDeps['tell']): void {
  teller = tell
}

const DEFAULTS: ClassEndDeps = {
  computing: sessionComputing,
  tell: (sessionId, frame) => teller(sessionId, frame),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
  maxWaitMs: 120_000,
  pollMs: 1_000,
}

/** What the panel says in its toast when the class was finished from there. */
export type AfterClass = Extract<PageAfterClass, 'offer' | 'waiting'> | 'refreshing' | null

const pending = new Map<string, Promise<void>>()

/** The rebuild a finish queued, while it waits or runs: for tests and for a second press. */
export function pendingRefresh(sessionId: string): Promise<void> | undefined {
  return pending.get(sessionId)
}

/**
 * Fill the course row's day with the finish day when it has none.
 *
 * Through `rewriteCourseRows`, which re-reads the course and applies the
 * change again when someone saved it in the same instant, so a teacher
 * reordering the course while another presses the bell loses neither.
 */
export function stampClassDay(sessionId: string): void {
  const day = instanceToday(finishedAt(sessionId) ?? Date.now())
  let touched = false
  rewriteCourseRows((item) => {
    if (item.kind !== 'seminar' || item.sessionId !== sessionId || isClassDay(item.day)) return null
    touched = true
    return { ...item, day }
  })
  if (touched) forgetCourseIndex()
}

/** The finish happened: date the row, then offer a page or refresh the one there is. */
export function afterClassFinished(
  sessionId: string,
  deps: Partial<ClassEndDeps> = {},
): AfterClass {
  // The class is already finished when this runs; nothing here may undo or break that.
  try {
    return pageAfterClass(sessionId, { ...DEFAULTS, ...deps })
  } catch (err) {
    console.error(`[pages] the page of ${sessionId} was left alone after class:`, err)
    return null
  }
}

function pageAfterClass(sessionId: string, use: ClassEndDeps): AfterClass {
  try {
    stampClassDay(sessionId)
  } catch (err) {
    console.error(`[pages] the day of ${sessionId} was not stamped:`, err)
  }
  const pub = publicationOf(sessionId)
  if (!pub) {
    const course = courseOfSeminar(sessionId)
    const row = course
      ? courseRows(course).find((r) => r.item.kind === 'seminar' && r.item.sessionId === sessionId)
      : undefined
    if (!course || !row) return null
    use.tell(sessionId, {
      t: 'page',
      state: 'offer',
      course: { name: course.name, n: row.n, title: row.title, day: row.day },
    })
    return 'offer'
  }
  if (pub.state !== 'published' || !pub.selection?.autoRefresh) return null
  if (pending.has(sessionId)) return 'waiting'
  const waiting = use.computing(sessionId)
  if (waiting) use.tell(sessionId, { t: 'page', state: 'waiting', address: publicationAddress(pub) })
  const run = refreshWhenQuiet(sessionId, use, waiting).finally(() => pending.delete(sessionId))
  pending.set(sessionId, run)
  return waiting ? 'waiting' : 'refreshing'
}

function heldReason(check: PublishCheck): string {
  const where = check.where
  if (check.kind === 'secret') return tr('server.page.heldSecret', { where })
  if (check.kind === 'name') return tr('server.page.heldName', { where })
  return tr('server.page.heldRoomId', { where })
}

/**
 * Whether the rebuild the bell queued is still wanted, after the wait.
 *
 * Two minutes is long enough for the teacher to resume the class, or to spot
 * a key or a student's name and press «Снять страницу», or to switch the
 * refresh off. A rebuild then would put the withdrawn page back.
 */
function stillWanted(sessionId: string): boolean {
  if (finishedAt(sessionId) === null) return false
  const pub = publicationOf(sessionId)
  return pub !== null && pub.state === 'published' && pub.selection?.autoRefresh === true
}

async function refreshWhenQuiet(
  sessionId: string,
  use: ClassEndDeps,
  told: boolean,
): Promise<void> {
  // Counted in polls rather than by the clock, so a test's instant sleep cannot spin forever.
  for (let waited = 0; use.computing(sessionId) && waited < use.maxWaitMs; waited += use.pollMs) {
    await use.sleep(use.pollMs)
  }
  // The spinner the host was shown must close, or it promises a refresh for the rest of the class.
  const cancel = () => {
    if (told) use.tell(sessionId, { t: 'page', state: 'cancelled' })
  }
  if (!stillWanted(sessionId)) return cancel()
  let frame: PageFrame
  try {
    // `auto` makes the queued job look again just before it builds (materials.ts · refreshPage).
    const result = await refreshPage(sessionId, { by: null, auto: true })
    if (!result.ok && result.skipped) return cancel()
    if (result.ok) {
      const { publication, page } = result
      recordAdminEvent({
        actor: null,
        action: 'publication.published',
        target: { type: 'publication', id: publication.id, label: publication.title },
        detail: {
          room: sessionId,
          materials: page.materials.length,
          revision: publication.revision,
          trigger: 'finish',
        },
      })
      frame = { t: 'page', state: 'updated', address: page.address, materials: page.materials.length }
    } else {
      const pub = publicationOf(sessionId)
      const address = pub ? publicationAddress(pub) : undefined
      frame =
        result.status === 409 && result.checks?.length
          ? { t: 'page', state: 'held', address, reason: heldReason(result.checks[0]) }
          : { t: 'page', state: 'failed', address, reason: result.error }
    }
  } catch (err) {
    console.error(`[pages] the page of ${sessionId} was not refreshed after class:`, err)
    frame = { t: 'page', state: 'failed', reason: tr('server.page.buildFailed') }
  }
  use.tell(sessionId, frame)
}
