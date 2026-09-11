import type { Locale } from '@shared/i18n-types'

/**
 * Какая часть продукта говорит — и, значит, какой словарь ей нужен.
 *
 * Словарь был один на всех и вёз оба языка сразу: 351 КБ исходника (74 КБ по
 * проводу) перед ЛЮБЫМ экраном, из которых комнате принадлежит четверть.
 * Теперь область и язык выбираются здесь, а состав каждой области перечислен
 * импортами в lib/messages/<область>-<язык>.ts — оттуда же его читает плагин
 * сборки, который и режет каталоги до одного языка.
 */
export type MessageArea = 'room' | 'admin' | 'reader'

/*
 * Перечислено руками и целиком, потому что `import('./messages/' + name)`
 * сборщик разобрать не может: он либо утащит в сборку весь каталог, либо не
 * найдёт ничего. Шесть строк — цена того, чтобы Rollup видел ровно шесть
 * кусков и назвал их предсказуемо (на эти имена смотрит firstPaint).
 */
const MODULES: Record<string, () => Promise<unknown>> = {
  'room-ru': () => import('./messages/room-ru'),
  'room-en': () => import('./messages/room-en'),
  'admin-ru': () => import('./messages/admin-ru'),
  'admin-en': () => import('./messages/admin-en'),
  'reader-ru': () => import('./messages/reader-ru'),
  'reader-en': () => import('./messages/reader-en'),
}

const loading = new Map<string, Promise<unknown>>()
const shown = new Set<MessageArea>()

/** Словарь одной области на одном языке — один раз за вкладку. */
export function loadAreaMessages(area: MessageArea, locale: Locale): Promise<unknown> {
  shown.add(area)
  const name = `${area}-${locale}`
  const known = loading.get(name)
  if (known) return known
  const started = MODULES[name]().catch((cause: unknown) => {
    // Отказ не кешируется: «Обновить страницу» внизу экрана должно работать.
    if (loading.get(name) === started) loading.delete(name)
    throw cause
  })
  loading.set(name, started)
  return started
}

/** Catalog registration precedes module evaluation, including top-level tr(). */
export async function loadLocalizedScreen<T>(
  screen: () => Promise<T>,
  area: MessageArea,
  locale: Locale,
  messages: (area: MessageArea, locale: Locale) => Promise<unknown> = loadAreaMessages,
): Promise<T> {
  await messages(area, locale)
  return screen()
}

/**
 * Язык сменили — доложить его словарь тем экранам, что уже открыты.
 *
 * До этого момента `translate` отдаёт прежний язык, а не голый ключ: увидеть
 * полсекунды старую надпись лучше, чем `room.ui.862` посреди формы.
 */
export async function reloadAreaMessages(locale: Locale): Promise<void> {
  await Promise.all([...shown].map((area) => loadAreaMessages(area, locale)))
}
