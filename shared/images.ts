/**
 * Картинки внутри текстовой ячейки — тем же приёмом, что и картинки вывода.
 *
 * У вывода эта задача решена давно: график matplotlib уезжает на полку рядом с
 * комнатой, а в документе остаётся ссылка на полторы сотни байт
 * (server/src/blobs.ts · `shared/notebook.ts · OutputBlob`). У ЗАМЕТКИ она
 * решена не была, и это стоило дороже: тетрадь лекции, где условия задач
 * нарисованы картинками, приезжает в комнату файлом .ipynb, а в файле картинка
 * лежит прямо в тексте ячейки — `![](data:image/png;base64,…)` или вложением
 * nbformat (`attachments`). Замер на живой комнате: документ на 10.5 МБ, из
 * которых 9.4 МБ — base64 в исходниках markdown-ячеек. Этот документ едет
 * ЦЕЛИКОМ каждому вошедшему, и студент на медленном канале не догонял комнату
 * никогда.
 *
 * Здесь — только разбор текста, без диска и без сети: и браузер, и сервер
 * должны одинаково понимать, где в заметке картинка и как она названа.
 *
 * ФОРМА ССЫЛКИ — `attachment:<sha256>.<ext>`, и это намеренно форма самого
 * nbformat, а не наш адрес. Во-первых, файл на диске остаётся тетрадью, которую
 * откроет Jupyter: выгрузка кладёт рядом `attachments` с теми же именами (см.
 * server/src/notebook-images.ts). Во-вторых, адрес комнаты (`/api/sessions/<id>/
 * blobs/<sha>`) в тексте ячейки жить не может: тетрадь переезжает между
 * комнатами, а полка у каждой своя — ссылка пережила бы переезд битой.
 *
 * ТОЛЬКО MARKDOWN. В коде `data:image/png;base64,…` — это строка, которую
 * написал человек, и подменять её ссылкой значило бы молча переписать чужую
 * программу. Поэтому всё, что здесь есть, зовут только для текстовых ячеек.
 */

import { normalizePath } from './paths.js'

/**
 * Картинки меньше этого в документе и остаются.
 *
 * Тот же порог, что у вывода (`BLOB_FROM_CHARS` в server/src/kernel/outputs.ts):
 * иконка на пару килобайт дешевле в документе, чем второй запрос за ней.
 */
export const INLINE_IMAGE_FROM_CHARS = 16 * 1024

/** Кусок текста, который надо заменить. */
export interface TextEdit {
  start: number
  end: number
  text: string
}

/** Картинка, лежащая в тексте своим содержимым. */
export interface InlineImage {
  /** Границы всего `data:…;base64,…` в исходнике. */
  start: number
  end: number
  mime: string
  base64: string
}

/*
 * Пробелы внутри base64 не ловим НАРОЧНО.
 *
 * В тексте ячейки картинка стоит одной строкой — так её пишут и Jupyter, и
 * редакторы; а перенос строки посреди адреса означал бы, что дальше идёт уже
 * не адрес, и жадный разбор съел бы соседний абзац.
 */
const DATA_URI = /data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})/g

/**
 * Ссылки `attachment:<имя>` — в том виде, в каком их пишет nbformat.
 *
 * Имя вложения — это имя файла, который человек перетащил в ячейку, и оно
 * бывает каким угодно: «схема.png», «Рис 1.png». Поэтому не список разрешённых
 * букв (на нём ломались все кириллические имена), а список тех, на которых имя
 * заведомо кончилось: скобка markdown, кавычка атрибута, пробел.
 */
const ATTACHMENT_REF = /attachment:([^\s)\]"'<>]+)/g

/** Расширение файла по типу содержимого — для имени вложения. */
export function extForMime(mime: string): string {
  const known: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  }
  return known[mime] ?? 'bin'
}

/** Имя вложения по хэшу его содержимого. Оно же — имя записи на полке. */
export function attachmentName(sha: string, mime: string): string {
  return `${sha}.${extForMime(mime)}`
}

/** Хэш из имени вложения — или `null`, если имя не наше. */
export function shaOfAttachment(name: string): string | null {
  const sha = /^([0-9a-f]{64})\.[A-Za-z0-9]+$/.exec(name)
  return sha ? sha[1] : null
}

/**
 * Картинки, лежащие в тексте содержимым.
 *
 * `minChars` — про длину base64, а не про вес картинки: решение принимается до
 * раскодирования, потому что раскодировать мегабайт ради решения «а стоит ли» —
 * это и есть та работа, от которой уходим.
 */
export function findInlineImages(source: string, minChars = 0): InlineImage[] {
  const found: InlineImage[] = []
  for (const match of source.matchAll(DATA_URI)) {
    const base64 = match[2]
    if (base64.length < minChars) continue
    const start = match.index ?? 0
    found.push({ start, end: start + match[0].length, mime: match[1], base64 })
  }
  return found
}

/** Имена вложений, на которые ссылается текст. */
export function findAttachmentRefs(source: string): { start: number; end: number; name: string }[] {
  const found: { start: number; end: number; name: string }[] = []
  for (const match of source.matchAll(ATTACHMENT_REF)) {
    const start = match.index ?? 0
    found.push({ start, end: start + match[0].length, name: match[1] })
  }
  return found
}

/**
 * Применить замены разом.
 *
 * С конца: замена меняет длину строки, и правка, посчитанная по исходнику,
 * поехала бы после первой же предыдущей.
 */
export function applyEdits(source: string, edits: readonly TextEdit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start)
  let out = source
  for (const edit of ordered) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return out
}

/**
 * Картинка, лежащая ФАЙЛОМ в папке семинара: `![схема](assets/fig01.png)`.
 *
 * Третий способ положить картинку в заметку, и до сих пор единственный
 * неработавший. Два первых сюда приезжают из .ipynb и уходят на полку —
 * `data:` в тексте и вложение nbformat (см. шапку файла). А этот из .ipynb не
 * приезжает вовсе: в файле тетради его и нет, есть путь к соседнему файлу,
 * который Jupyter читает с диска рядом с ноутбуком.
 *
 * В комнате такой путь оставался как написан, и браузер разрешал его
 * относительно адреса страницы: `/s/<комната>/assets/fig01.png`. Там стоит
 * приложение, и на любой путь оно отвечает своим `index.html` — то есть 200 и
 * `text/html`. Картинка не рисовалась, а в сети не было даже 404: успех,
 * который нечем показать.
 *
 * Путь НЕ переписывается в тексте ячейки — в отличие от полки. Полка получает
 * ссылку `attachment:<sha>` потому, что содержимое переехало и старой ссылки
 * больше нет; здесь же файл как лежал рядом с тетрадью, так и лежит, и `.ipynb`
 * с `assets/fig01.png` внутри обязан открыться в Jupyter ровно так же. Адрес
 * подставляется только на время показа.
 */
export interface WorkspaceImage {
  /** Границы ПУТИ в исходнике — без скобок, кавычек и самого `![…]`. */
  start: number
  end: number
  /** Он же, приведённый к канону `shared/paths`. */
  path: string
}

/*
 * Две записи картинки, и обе нужны: `![…](путь)` из markdown и `<img src="…">`
 * из разметки, которую заметка теперь рисует. В обеих скобка захватывает то,
 * что стоит ПЕРЕД путём, — так его начало считается сложением длин, а не
 * поиском подстроки: `![assets/x.png](assets/x.png)` иначе нашёл бы первое
 * вхождение, то есть подпись вместо адреса.
 */
const MD_IMAGE = /(!\[[^\]]*\]\(\s*)([^)\s]+)/g
const IMG_SRC = /(<img\b[^<>]*?\bsrc\s*=\s*)("[^"]*"|'[^']*'|[^\s"'<>]+)/gi

/** Адрес, за которым идут не к нам: другая схема, корень сайта, якорь. */
const NOT_A_FILE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/|\/|#)/

/**
 * Путь к файлу семинара — или `null`, если это вообще не он.
 *
 * `./` в начале снимается, а `..` не прощается: первое — та же самая папка
 * записанная иначе (так пишет половина ноутбуков), второе — выход из неё, и
 * канон `shared/paths` отвергает его целиком.
 */
export function workspacePathOf(raw: string): string | null {
  if (!raw || NOT_A_FILE.test(raw)) return null
  let value = raw.replace(/^(?:\.\/)+/, '')
  // Пробел в имени файла в markdown пишут как `%20`; в атрибуте — пробелом.
  try {
    value = decodeURIComponent(value)
  } catch {
    /* Не разбирается — значит это не экранирование, а сам текст. */
  }
  return normalizePath(value) || null
}

export function findWorkspaceImages(source: string): WorkspaceImage[] {
  const found: WorkspaceImage[] = []
  const add = (start: number, raw: string): void => {
    const path = workspacePathOf(raw)
    if (path) found.push({ start, end: start + raw.length, path })
  }
  for (const match of source.matchAll(MD_IMAGE)) {
    add((match.index ?? 0) + match[1].length, match[2])
  }
  for (const match of source.matchAll(IMG_SRC)) {
    const value = match[2]
    const quoted = value.startsWith('"') || value.startsWith("'")
    const at = (match.index ?? 0) + match[1].length + (quoted ? 1 : 0)
    add(at, quoted ? value.slice(1, -1) : value)
  }
  return found
}
