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
