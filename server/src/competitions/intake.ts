/**
 * Разбор того, что преподаватель кладёт в соревнование: таблицы и тетради.
 *
 * Чистые функции над байтами, без диска и без базы. Здесь они потому, что обе
 * двери — открытые данные и ответы — показывают про файл одно и то же («397
 * строк · id, orders»), и считать это двумя копиями значило бы однажды
 * посчитать строки ответов иначе, чем строки теста: деление на публичную и
 * приватную часть опирается ровно на это число.
 */

/** Что видно про CSV в карточке файла. */
export interface CsvShape {
  /** Строк ДАННЫХ, без шапки. Именно это число делится на две части. */
  rows: number
  columns: string[]
}

/** Нулевой байт в начале — верный признак, что таблицу сюда положили по ошибке. */
const SNIFF = 8192

/**
 * Пересчитать строки и прочитать шапку.
 *
 * Кавычки учитываются: в честном CSV перевод строки внутри `"..."` — часть
 * значения, и наивный `split('\n')` насчитал бы по такому файлу вдвое больше
 * строк, чем есть. Ошибка тихая: доля публичной части считается от этого
 * числа, и «119 из 397» превратилось бы в «238 из 794» без единого отказа.
 *
 * `null` — это не таблица: пусто или двоичное.
 */
export function csvShape(bytes: Uint8Array): CsvShape | null {
  if (bytes.length === 0) return null
  const sniff = Math.min(bytes.length, SNIFF)
  for (let i = 0; i < sniff; i++) if (bytes[i] === 0) return null

  const QUOTE = 0x22
  const LF = 0x0a
  const CR = 0x0d
  let inQuote = false
  let records = 0
  let headerEnd = -1
  /** Есть ли в текущей записи хоть один байт: хвостовой перевод строки — не запись. */
  let started = false

  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]
    if (byte === QUOTE) {
      // Удвоенная кавычка внутри значения — экранированная, а не конец поля.
      if (inQuote && bytes[i + 1] === QUOTE) {
        i += 1
        started = true
        continue
      }
      inQuote = !inQuote
      started = true
      continue
    }
    if (!inQuote && byte === LF) {
      // Пустая строка — не строка: `pandas.read_csv` их пропускает, и число
      // под именем файла обязано совпадать с тем, что увидит тетрадь.
      if (started) {
        if (headerEnd < 0) headerEnd = bytes[i - 1] === CR ? i - 1 : i
        else records += 1
      }
      started = false
      continue
    }
    if (byte !== CR) started = true
  }
  // Последняя строка без перевода в конце — тоже строка.
  if (started) {
    if (headerEnd < 0) headerEnd = bytes.length
    else records += 1
  }
  if (headerEnd < 0) return null

  return {
    rows: records,
    columns: splitRecord(Buffer.from(bytes.subarray(0, headerEnd)).toString('utf8')),
  }
}

/** Шапка одной строкой: `id, orders` — ровно так она подписана в макете. */
export function columnsLine(columns: readonly string[]): string {
  return columns.join(', ')
}

/**
 * Разобрать запись CSV на поля.
 *
 * Отдельно от счёта строк: там нужен один проход по байтам всего файла, здесь —
 * одна короткая строка, и склеивать их значило бы держать в памяти разбор
 * двухсот мегабайт ради шапки.
 */
function splitRecord(line: string): string[] {
  const out: string[] = []
  let field = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        field += '"'
        i += 1
        continue
      }
      inQuote = !inQuote
      continue
    }
    if (ch === ',' && !inQuote) {
      out.push(field.trim())
      field = ''
      continue
    }
    field += ch
  }
  out.push(field.trim())
  // Единственное поле без запятых — это не таблица, а просто строка; пусть так
  // и выглядит, чем притворяться колонкой с пустым именем.
  return out.length === 1 && out[0] === '' ? [] : out
}

/**
 * Сколько ячеек в тетради; `null` — это не тетрадь.
 *
 * Проверяется здесь, а не в контейнере: файл, который `nbformat` не разберёт,
 * занял бы место в очереди, поднял контейнер и вернулся через минуту с
 * «упала тетрадь» — при том, что участник просто перетащил не тот файл.
 */
export function notebookCells(bytes: Uint8Array): number | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return null
  }
  const cells = (parsed as { cells?: unknown } | null)?.cells
  if (!Array.isArray(cells)) return null
  return cells.length
}

/**
 * Имя файла без пути.
 *
 * Браузер кладёт в форму то, что дала файловая система того, кто перетаскивал:
 * `C:\Users\...\train.csv` из старых сборок Windows и `data/train.csv` из
 * перетаскивания папки. Дальше это имя едет в `data/` контейнера, и участник
 * пишет его в своей тетради — так что сегмент пути в нём это не уязвимость
 * (её ловит якорная файловая система), а файл, которого никто не сможет
 * прочитать.
 */
export function baseName(raw: string): string {
  const cut = String(raw ?? '')
    .split(/[\\/]/)
    .pop()
  return (cut ?? '').trim()
}
