/**
 * The link card: what a messenger shows under a room's address.
 *
 * Telegram, WhatsApp, iMessage and the rest do not run scripts: they read the
 * `<head>` of the first response and take `og:*` from it. The built
 * index.html has none of this in its head, because it is one for all
 * addresses, and only the server knows the class name. So the server has to
 * fill it in, at the very moment it serves the page.
 *
 * A room has its own image, with the class name, drawn on the server
 * (og-card.ts, route /og/rooms/<id>.png); so do a competition
 * (/og/competitions/<slug>.png), the competitions list (/og/competitions.png)
 * and a course (/og/courses/<handle>.png). Other pages share a common one,
 * from web/public/og/colloq.png.
 */
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { tr } from '@shared/i18n'
import type { Locale } from '@shared/i18n'
import { createHash } from 'node:crypto'
import { config } from './config.js'
import { getSession } from './db.js'
import type { SessionInfo } from '@shared/protocol'
import type { PageExtras } from './frontend-html.js'
import { CARD_HEIGHT, CARD_WIDTH, type CompetitionCard, type CompetitionsCard, type CourseCard } from './og-card.js'
import { findCompetition, listCompetitionEntrants } from './competitions/store.js'
import { findCourse } from './publish/store.js'
import { instanceTimeZone } from './time-zone.js'

/** The common card: an export from Paper (artboard "Превью · colloq.ru"), kept in web/public. */
const IMAGE = 'og/colloq.png'
const IMAGE_WIDTH = CARD_WIDTH
const IMAGE_HEIGHT = CARD_HEIGHT

/** A room's address: `/s/<id>` and everything under it. */
const ROOM_PATH = /^\/s\/([A-Za-z0-9_-]+)(?:\/|$)/
/** The competitions list, a competition's page and its tabs (web/src/lib/routes.ts); never the key link `/k/t/<key>`. */
const COMPETITIONS_PATH = /^\/k\/?$/
const COMPETITION_PATH = /^\/k\/([a-z0-9-]{1,64})(?:\/(?:submissions|leaderboard|dependencies)(?:\/screen)?)?\/?$/
/** A course's public page. */
const COURSE_PATH = /^\/c\/([A-Za-z0-9_-]{1,64})\/?$/

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/*
 * The image version, from the file's mtime, one stat per process.
 *
 * Messengers cache previews by image address for a long time; without a
 * version a new splash would reach the chats weeks later. Only a deploy
 * changes the file, and a deploy restarts the process, so there is no point
 * asking the disk on every request.
 */
const imageVersions = new Map<string, Promise<string | null>>()

function imageVersion(staticDir: string): Promise<string | null> {
  const known = imageVersions.get(staticDir)
  if (known) return known
  const version = stat(path.join(staticDir, IMAGE))
    .then((info) => Math.floor(info.mtimeMs).toString(36))
    .catch(() => null)
  imageVersions.set(staticDir, version)
  return version
}

/** For tests: forget that the disk was already looked at. */
export function forgetImageVersions(): void {
  imageVersions.clear()
}

const OG_LOCALE: Record<Locale, string> = { ru: 'ru_RU', en: 'en_US' }

/**
 * The room image version, from the name and date: a messenger caches by
 * address, and a renamed class would otherwise show under its old name.
 */
export function roomImageVersion(session: Pick<SessionInfo, 'name' | 'createdAt'>): string {
  return createHash('sha1').update(`${session.createdAt}\u0000${session.name}`).digest('base64url').slice(0, 10)
}

/** The host in a card's corner: the public address without the scheme. */
export function cardHost(): string {
  return config.publicUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

/** A card's image version: everything it is drawn from, so a messenger never keeps an old one. */
function cardVersion(card: object): string {
  return createHash('sha1').update(JSON.stringify(card)).digest('base64url').slice(0, 10)
}

/**
 * The card of a competition on `/k`, or null: a draft does not exist there
 * (routes/competitions.ts · publicCompetitionOf), and a card in a chat is not
 * the place to reveal one.
 */
export function competitionCardOf(slug: string, language: Locale, now = Date.now()): { card: CompetitionCard; slug: string } | null {
  const competition = findCompetition(slug)
  if (!competition || competition.state === 'draft') return null
  const over = competition.state === 'finished' || (competition.deadlineAt !== null && competition.deadlineAt <= now)
  const phase = over ? 'finished' : competition.startsAt !== null && competition.startsAt > now ? 'upcoming' : 'live'
  return {
    slug: competition.slug,
    card: {
      title: competition.title,
      blurb: competition.blurb,
      phase,
      startsAt: competition.startsAt,
      deadlineAt: competition.deadlineAt,
      metricName: competition.metric.name,
      metricDirection: competition.metric.direction,
      entrants: listCompetitionEntrants(competition.id).length,
      perDay: competition.limits.perDay,
      host: cardHost(),
      language,
      timeZone: instanceTimeZone(),
    },
  }
}

/** A course's card: its name, its blurb and the first of its classes, the way its page lists them. */
export function courseCardOf(handle: string, language: Locale): { card: CourseCard; handle: string } | null {
  const course = findCourse(handle)
  if (!course) return null
  return {
    handle: course.slug ?? course.id,
    card: {
      name: course.name,
      blurb: course.blurb,
      lessons: course.items.slice(0, 4).map((item) => item.name),
      total: course.items.length,
      host: cardHost(),
      language,
    },
  }
}

export function competitionsCardOf(language: Locale): CompetitionsCard {
  return { host: cardHost(), language }
}

function roomImage(origin: string, session: SessionInfo): string {
  return `${origin}/og/rooms/${session.id}.png?v=${roomImageVersion(session)}`
}

async function genericImage(origin: string, staticDir: string): Promise<string | null> {
  const version = await imageVersion(staticDir)
  return version === null ? null : `${origin}/${IMAGE}?v=${version}`
}

/**
 * The title and tags for the page at this path.
 *
 * A room with a known name gets its own name; everything else gets the common
 * Colloq card, the same as the landing page's. An unknown room deliberately
 * looks like any other page: a card in a chat is not the place to reveal
 * whether such an address exists.
 */
export async function linkPreview(
  requestPath: string,
  language: Locale,
  staticDir: string,
): Promise<PageExtras> {
  const room = ROOM_PATH.exec(requestPath)
  const session = room ? getSession(room[1]) : null
  const siteName = 'Colloq'
  const origin = config.publicUrl.replace(/\/+$/, '')
  // A competition, the competitions list and a course have their own cards
  // too (og-card.ts); an unknown or draft one looks like any other page.
  const competitionSlug = session ? null : COMPETITION_PATH.exec(requestPath)?.[1] ?? null
  const competition = competitionSlug ? competitionCardOf(competitionSlug, language) : null
  const competitions = !session && COMPETITIONS_PATH.test(requestPath)
  const courseHandle = session || competition ? null : COURSE_PATH.exec(requestPath)?.[1] ?? null
  const course = courseHandle ? courseCardOf(courseHandle, language) : null
  const own = Boolean(session || competition || course || competitions)
  const title = session
    ? `${session.name} · ${siteName}`
    : competition
      ? `${competition.card.title} · ${siteName}`
      : course
        ? `${course.card.name} · ${siteName}`
        : competitions
          ? tr('server.linkPreview.competitionsTitle')
          : tr('server.linkPreview.title')
  const description = session
    ? tr('server.linkPreview.roomDescription')
    : competition
      ? competition.card.blurb.trim() || tr('server.linkPreview.competitionDescription')
      : course
        ? course.card.blurb?.trim() || tr('server.linkPreview.courseDescription')
        : competitions
          ? tr('server.linkPreview.competitionsDescription')
          : tr('server.linkPreview.description')
  const image = session
    ? roomImage(origin, session)
    : competition
      ? `${origin}/og/competitions/${competition.slug}.png?v=${cardVersion(competition.card)}`
      : course
        ? `${origin}/og/courses/${course.handle}.png?v=${cardVersion(course.card)}`
        : competitions
          ? `${origin}/og/competitions.png?v=${cardVersion(competitionsCardOf(language))}`
          : await genericImage(origin, staticDir)

  const tags: Array<[string, string]> = [
    ['og:type', 'website'],
    ['og:locale', OG_LOCALE[language] ?? OG_LOCALE.ru],
    ['og:site_name', siteName],
    ['og:title', title],
    ['og:description', description],
  ]
  /*
   * Only a room has its own address. Other pages (and an unknown room) have
   * the common card, and without an address in it it is one for everyone: the
   * messenger takes the link it was sent, and the server builds and compresses
   * the page once rather than once per path.
   */
  if (own) tags.push(['og:url', `${origin}${requestPath}`])
  if (image !== null) {
    tags.push(
      ['og:image', image],
      ['og:image:width', String(IMAGE_WIDTH)],
      ['og:image:height', String(IMAGE_HEIGHT)],
      ['og:image:alt', tr('server.linkPreview.imageAlt')],
    )
  }
  const head =
    tags
      .map(([property, content]) => `<meta property="${property}" content="${escapeHtml(content)}">`)
      .join('') +
    `<meta name="description" content="${escapeHtml(description)}">` +
    `<meta name="twitter:card" content="${image !== null ? 'summary_large_image' : 'summary'}">`
  // The tab title changes only for a page with its own card: other pages keep
  // the one in the build, and a deploy is free to rewrite it.
  return { title: own ? title : undefined, head }
}
