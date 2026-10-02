/**
 * Colloq's addresses — all there are, and how to read them.
 *
 * The parsing lives here, not in App's markup, for the same reason
 * `admin/entry.ts` lies next to it: a regex that quietly stopped matching will
 * not break the build — it will drop a tablet with a live key in its address
 * bar onto the sign-in screen, and that can only be noticed by hand. Here it
 * is checked by tests.
 *
 * There is still no router: there are exactly as many pages as there are
 * functions below, and a seminar link must stay an ordinary address that the
 * teacher pastes into a chat.
 */

/** Which of the room's screens is open. */
export type RoomMode = 'room' | 'screen' | 'pult' | 'council'

export interface RoomRoute {
  id: string
  mode: RoomMode
  /** The key from a console link: the tablet trades it for a normal sign-in. */
  handoffKey: string | null
  /**
   * The council console's cell — only for the `council` mode, `null` for the
   * rest.
   *
   * The council console is opened BY CELL: a notebook can have several council
   * cells, and a window without the cell name would not know whose stack to
   * show. Hence a separate segment in the address rather than a flag: the
   * window survives a reload and must return to the same cell after it.
   */
  cellId: string | null
}

export interface PublicRoute {
  id: string
  /** The material in the address (`/p/<page>/seminar`); `null` — the page's first notebook. */
  key: string | null
  /**
   * A 0.12 step address, `/p/<page>/<digits>`. Steps are gone; App replaces
   * the address with the page's own, so a link pasted into a chat last year
   * still opens the class.
   */
  legacy: boolean
}

/*
 * `/s/:id` — the room, `/s/:id/screen` — its projection on the lecture-hall
 * projector, `/s/:id/pult` — the lecture console in the teacher's hands,
 * `/s/:id/council/:cell` — the council console for one cell, in a separate
 * 900×700 window.
 *
 * One address for four screens: the projection and both consoles are the same
 * room with the same person, not separate pages. Hence the tail in the same
 * expression rather than three regexes: the id stays the same, and moving
 * between them does NOT rebuild the session — the sockets, the document and
 * presence stay in place.
 *
 * An address rather than a button, because both are opened on ANOTHER
 * machine: the projection on the one plugged into the projector, the console
 * on a tablet. The projection link is bookmarked on the department laptop and
 * comes back by itself after a reload; a key link leads to the console.
 *
 * THE KEY IS A TAIL TO ANY SCREEN, not a fifth screen.
 *
 * While `/t/<key>` stood in one alternation with `pult` and `council/:cell`, a
 * link with a key could lead to exactly one place — and `App` appended that
 * place by hand ("after the exchange — to the lecture console"). The council
 * console is opened BY CELL, and a `/s/:id/council/:cell/t/<key>` link did not
 * exist in the product at all: a teacher who copied the window's address gave
 * the phone an address without sign-in. As a group of its own the key stops
 * competing with the screen: it says WHO to sign in as, the screen says
 * WHERE, and these two questions no longer share one place.
 *
 * The key's alphabet is the same the server signs it with
 * (`signHandoffToken`): base64url with dots. That the alphabets match is
 * checked by a test, because they can drift apart silently.
 */
const SESSION_PATH =
  /^\/s\/([A-Za-z0-9_-]{1,64})(?:\/(screen|pult)|\/council\/([A-Za-z0-9_-]{1,64}))?(?:\/t\/([A-Za-z0-9_.-]{8,512}))?\/?$/
/*
 * Two public pages: a course and a published seminar.
 *
 * Their own prefixes and their own ids, separate from `/s/`, and this is not
 * tidiness in naming: the room's eight characters are the whole right to
 * write into it. A link given to the class "for reading" must not open the
 * live notebook for them, so a publication has an address of its own, and the
 * room id is not part of it.
 */
const COURSE_PATH = /^\/c\/([A-Za-z0-9_-]{1,64})\/?$/
/*
 * A class page and, optionally, one of its materials: `/p/ml-strong-04/seminar`.
 *
 * The tail is a material key, the same alphabet as MATERIAL_KEY_RE in
 * shared/materials.ts (lowercase Latin, digits, hyphens, at most forty) and
 * always with a letter, which is what tells it from a 0.12 step number. The
 * expression is spelled out here rather than imported: routes.ts sits in the
 * entry chunk, and shared/materials.ts would drag its vocabulary (and its
 * server words) into the first paint of every room. A test keeps the two
 * spellings in step.
 *
 * An all-digit tail is a step address from 0.12 (`/p/<id>/3184`); a minus or
 * any other shape is no address at all, as before.
 */
const PUBLIC_PATH = /^\/p\/([A-Za-z0-9_-]{1,64})(?:\/([a-z0-9-]{1,40}))?\/?$/
export const MATERIAL_TAIL_RE = /^(?=[a-z0-9-]*[a-z])[a-z0-9-]{1,40}$/
/*
 * Competitions: `/k` — the list, `/k/<slug>` — a page, `/k/t/<key>` — sign-in.
 *
 * The key as a TAIL AFTER `t`, not a bare `/k/<key>`, and this is not style: a
 * competition's address is also the second segment, and `K7Q-M2X-9FD` would
 * have to be told from `rohlik` by the shape of the string. As long as the
 * shapes do not clash, that works; the day a teacher creates a competition
 * with a nine-letter address, the sign-in link will silently open someone
 * else's task. So `t` is a reserved address (`shared/competitions.ts` ·
 * RESERVED_SLUGS), and there is never a competition by that name.
 *
 * The page's tabs (`submissions`, `leaderboard`) and the projector — with the
 * same expression: it is the same page with the same person, and switching
 * tabs need not rebuild the screen. The address letters are the same as for
 * courses and publications (`shared/publish.ts` · slugOk): lower case, digits
 * and a hyphen.
 *
 * The key's alphabet is the one the server prints it in: three groups of
 * three characters from `ENTRANT_KEY_ALPHABET`, with or without hyphens. The
 * server itself normalises spaces and lower case, so they pass here too.
 */
const COMPETITIONS_PATH =
  /^\/k(?:\/t\/([A-Za-z0-9 -]{9,16})|\/([a-z0-9-]{1,64})(?:\/(submissions|leaderboard|dependencies)(\/screen)?)?)?\/?$/

/** Which of the competition pages is open. */
export type CompetitionView = 'list' | 'task' | 'submissions' | 'leaderboard' | 'dependencies' | 'screen'

export interface CompetitionRoute {
  /** The competition's address; `null` — the general `/k` list. */
  slug: string | null
  view: CompetitionView
  /** The key from the sign-in link: the page trades it for a cookie. */
  signInKey: string | null
}

/** The room and which of its three screens it was opened with. */
export function readRoomRoute(path: string): RoomRoute | null {
  const match = SESSION_PATH.exec(path)
  if (!match) return null
  const tail = match[2]
  const cellId = match[3] ?? null
  return {
    id: match[1],
    mode: cellId !== null ? 'council' : tail === 'screen' ? 'screen' : tail === 'pult' ? 'pult' : 'room',
    handoffKey: match[4] ?? null,
    cellId,
  }
}

/**
 * The same screen but without the key — where to drop the tablet after the
 * exchange.
 *
 * The one place where the mode becomes an address again: `App` erases the key
 * from the bar right after the exchange (it is single-use and lives minutes,
 * while an address outlives both the tab and a screenshot), and it must drop
 * the person WHERE THE LINK LED.
 *
 * A bare `/s/:id/t/<key>` is a lecture console link issued before the key
 * learned to be a tail to a screen: it leads to `/s/:id/pult`, because this
 * link opens a tablet in order to LEAD, not to watch the room in a second
 * window. Links live ten minutes, so this case is about those issued a minute
 * ago, and it also remains the honest answer "console".
 */
export function handoffLanding(route: Pick<RoomRoute, 'id' | 'mode' | 'cellId'>): string {
  const base = `/s/${route.id}`
  if (route.mode === 'council' && route.cellId !== null) return `${base}/council/${route.cellId}`
  if (route.mode === 'screen') return `${base}/screen`
  return `${base}/pult`
}

/** A course's public page. */
export function readCourseId(path: string): string | null {
  return COURSE_PATH.exec(path)?.[1] ?? null
}

/** A class page, with or without a material, or a 0.12 step address to replace. */
export function readPublicRoute(path: string): PublicRoute | null {
  const match = PUBLIC_PATH.exec(path)
  if (!match) return null
  const tail = match[2]
  if (tail === undefined) return { id: match[1], key: null, legacy: false }
  if (/^\d+$/.test(tail)) return { id: match[1], key: null, legacy: true }
  return MATERIAL_TAIL_RE.test(tail) ? { id: match[1], key: tail, legacy: false } : null
}

/**
 * The competition pages — and sign-in by a key link.
 *
 * Returned for a bare `/k` too: the competitions list is a page like the
 * others, and telling it apart by a failed parse would be an extra branch in
 * `App`.
 */
export function readCompetitionRoute(path: string): CompetitionRoute | null {
  const match = COMPETITIONS_PATH.exec(path)
  if (!match) return null
  const key = match[1] ?? null
  const slug = match[2] ?? null
  const tail = match[3]
  const screen = match[4] !== undefined
  if (screen && tail === 'dependencies') return null
  const view: CompetitionView = slug === null
    ? 'list'
    : screen
      ? 'screen'
      : tail === 'submissions'
        ? 'submissions'
        : tail === 'dependencies'
          ? 'dependencies'
          : tail === 'leaderboard'
            ? 'leaderboard'
            : 'task'
  return { slug, view, signInKey: key }
}

/**
 * Where to drop the person after trading the key for a sign-in.
 *
 * The key lives in the browser's address bar exactly until the server's first
 * answer: an address outlives both the tab and the screenshot a student will
 * send a classmate — "look at my place". Exactly the same rule, and for the
 * same reason, as for the console link (`handoffLanding` above).
 */
export const COMPETITIONS_LANDING = '/k'

/** The teacher panel: it parses its own sub-addresses itself. */
export function isAdminPath(path: string): boolean {
  return path === '/admin' || path.startsWith('/admin/')
}
