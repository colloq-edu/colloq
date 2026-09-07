/**
 * Чем показывать запись вывода — картинкой, разметкой или текстом.
 *
 * Вынесено из CellOutputs ради одной строчки: набор растровых типов больше не
 * второй литерал, а тот самый `BLOB_MIMES`, которым публикация решает, что
 * выносить в отдельные записи. Комментарий рядом с прежним списком обещал, что
 * наборы совпадают («и это не совпадение»), но связаны они ничем не были:
 * добавленный в `BLOB_MIMES` тип на опубликованной странице приезжал бы
 * адресом и рисовался, а в живой комнате приезжал бы base64 и переставал
 * рисоваться вовсе — `pickMime` его бы не выбрал.
 */
import { BLOB_MIMES } from '@shared/publish'
import type { CellOutput } from '@shared/notebook'

/**
 * Растровые картинки — те, что показывает `<img>`.
 *
 * Порядок — порядок `BLOB_MIMES`, и он же становится началом `MIME_ORDER`:
 * набор перечислен там буквами и по нему же строится `content-type` ответа с
 * блобом, так что список ровно один на продукт.
 */
export const IMG_MIMES: readonly string[] = [...BLOB_MIMES]

/*
 * Preference order for a rich result. The second list is what we can show
 * before the sanitizer exists: a data URI needs no sanitizing, and text/plain
 * goes out as text — SVG and HTML wait, because rendering either of them
 * unsanitized is not a trade worth one frame.
 */
const MIME_ORDER = [...IMG_MIMES, 'image/svg+xml', 'text/html', 'text/plain']
const MIME_ORDER_PLAIN = [...IMG_MIMES, 'text/plain']

export function pickMime(data: Record<string, string>, rich: boolean): string | null {
  for (const mime of rich ? MIME_ORDER : MIME_ORDER_PLAIN) if (data[mime]) return mime
  return Object.keys(data).find((mime) => mime.startsWith('text/')) ?? null
}

/**
 * Не само содержимое, а адрес, по которому оно лежит.
 *
 * Третий случай после base64 и data-URI: на опубликованной странице крупные
 * картинки вынесены в отдельные записи, и в наборе стоит
 * `/api/p/<pub>/blob/<хэш>`.
 *
 * Узнаётся по `/api/`, а не по одной косой черте: base64 любого JPEG
 * начинается с «/9j/» — так кодируется SOI FF D8 FF, — и по косой черте
 * фотография с CV-семинара уходила в src сырым payload'ом, то есть битым
 * значком у всей комнаты. PNG спасала только своя первая буква.
 */
export function isAddress(payload: string): boolean {
  return payload.startsWith('/api/')
}

/**
 * Показывать ли эту запись картинкой.
 *
 * Не только по mime. Соседние ветки отдают значение как разметку (SVG, HTML)
 * или как текст, поэтому адрес, попавший в любую из них, напечатался бы
 * строкой «/api/p/…/blob/…» на месте графика. Что именно публикация выносит
 * в записи, решает сервер, и список там может вырасти — а картинкой, взятой
 * по адресу, показывается что угодно из вынесенного.
 */
export function asImage(mime: string, payload: string): boolean {
  return IMG_MIMES.includes(mime) || isAddress(payload)
}

/** Kernels send bare base64; a few libraries send a full data URI already. */
export function imageSrc(mime: string, payload: string): string {
  if (payload.startsWith('data:') || isAddress(payload)) return payload
  return `data:${mime};base64,${payload.replace(/\s/g, '')}`
}

/**
 * Картинку не режем.
 *
 * Порог считан по строкам текста, а картинка не строки: у обрезанного
 * графика под кромкой остаются нижняя ось и подписи, и кнопка обещает «Show
 * more» — как будто ниже ещё вывод, а не остаток той же картинки. Сетка из
 * make_grid и retina-фигура выше 460 пикселей на семинаре — обычное дело.
 * Таблица и текст схлопываются по-прежнему: у них ниже кромки правда лежит
 * продолжение.
 */
export function isPicture(output: CellOutput, rich: boolean): boolean {
  if (output.kind !== 'data') return false
  const mime = pickMime(output.data, rich)
  return mime !== null && (IMG_MIMES.includes(mime) || mime === 'image/svg+xml')
}
