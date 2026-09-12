/**
 * Карточка ссылки: что мессенджер покажет под адресом комнаты.
 *
 * Telegram, WhatsApp, iMessage и остальные не исполняют скрипты — они читают
 * `<head>` первого ответа и берут оттуда `og:*`. У собранного index.html в
 * голове ничего этого нет, потому что он один на все адреса, а имя занятия
 * знает только сервер. Значит, и подставлять его должен сервер — в тот самый
 * момент, когда отдаёт страницу.
 *
 * Картинка у комнаты своя — с именем занятия, рисуется на сервере
 * (og-card.ts, маршрут /og/rooms/<id>.png); у остальных страниц общая, из
 * web/public/og/colloq.png.
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
import { CARD_HEIGHT, CARD_WIDTH } from './og-card.js'

/** Общая карточка — экспорт из Paper («Превью · colloq.ru»), лежит в web/public. */
const IMAGE = 'og/colloq.png'
const IMAGE_WIDTH = CARD_WIDTH
const IMAGE_HEIGHT = CARD_HEIGHT

/** Адрес комнаты: `/s/<id>` и всё, что под ним. */
const ROOM_PATH = /^\/s\/([A-Za-z0-9_-]+)(?:\/|$)/

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/*
 * Версия картинки — из mtime файла, один stat на процесс.
 *
 * Мессенджеры кэшируют превью по адресу картинки надолго; без версии новая
 * заставка доехала бы до чатов через недели. Файл меняет только выкладка, а
 * выкладка перезапускает процесс — значит, спрашивать диск на каждый запрос
 * незачем.
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

/** Для тестов: забыть, что уже смотрели на диск. */
export function forgetImageVersions(): void {
  imageVersions.clear()
}

const OG_LOCALE: Record<Locale, string> = { ru: 'ru_RU', en: 'en_US' }

/**
 * Версия картинки комнаты — от имени и даты: мессенджер кэширует по адресу,
 * и переименованное занятие иначе показывалось бы под старым именем.
 */
export function roomImageVersion(session: Pick<SessionInfo, 'name' | 'createdAt'>): string {
  return createHash('sha1').update(`${session.createdAt}\u0000${session.name}`).digest('base64url').slice(0, 10)
}

function roomImage(origin: string, session: SessionInfo): string {
  return `${origin}/og/rooms/${session.id}.png?v=${roomImageVersion(session)}`
}

async function genericImage(origin: string, staticDir: string): Promise<string | null> {
  const version = await imageVersion(staticDir)
  return version === null ? null : `${origin}/${IMAGE}?v=${version}`
}

/**
 * Заголовок и теги для страницы по этому пути.
 *
 * Комната с известным именем получает своё имя; всё остальное — общую
 * карточку Colloq, ту же, что у лендинга. Неизвестная комната нарочно не
 * отличается от любой другой страницы: карточка в чате — не место сообщать,
 * есть ли такой адрес.
 */
export async function linkPreview(
  requestPath: string,
  language: Locale,
  staticDir: string,
): Promise<PageExtras> {
  const room = ROOM_PATH.exec(requestPath)
  const session = room ? getSession(room[1]) : null
  const siteName = 'Colloq'
  const title = session ? `${session.name} · ${siteName}` : tr('server.linkPreview.title')
  const description = session
    ? tr('server.linkPreview.roomDescription')
    : tr('server.linkPreview.description')
  const origin = config.publicUrl.replace(/\/+$/, '')
  const image = session ? roomImage(origin, session) : await genericImage(origin, staticDir)

  const tags: Array<[string, string]> = [
    ['og:type', 'website'],
    ['og:locale', OG_LOCALE[language] ?? OG_LOCALE.ru],
    ['og:site_name', siteName],
    ['og:title', title],
    ['og:description', description],
  ]
  /*
   * Свой адрес — только у комнаты. У остальных страниц (и у неизвестной
   * комнаты) карточка общая, и без адреса в ней она одна на всех: мессенджер
   * возьмёт ту ссылку, которую ему прислали, а сервер соберёт и сожмёт страницу
   * один раз, а не по разу на каждый путь.
   */
  if (session) tags.push(['og:url', `${origin}${requestPath}`])
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
  // Заголовок вкладки меняется только комнате: у остальных страниц он тот,
  // что стоит в сборке, и выкладка вправе его переписать.
  return { title: session ? title : undefined, head }
}
