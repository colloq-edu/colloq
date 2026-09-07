/**
 * Строка палитры команд и правило, по которому её находят.
 *
 * Отдельно от компонента, потому что ломается молча именно отбор: человек
 * печатает «03 imp», ждёт третью ячейку с импортами — и не получает ничего,
 * если слова ищутся одной подстрокой; или получает её восьмой, если «Run all»
 * не оказывается выше «Остановить выполнение» на запросе «run». Ни то ни другое
 * не видно ни в одном типе.
 */

export interface PaletteItem {
  /** Уникальный ключ строки. */
  id: string
  /** Раздел: «Ячейки», «Файлы», «Комната». Рисуется заголовком группы. */
  group: string
  /** Что человек читает. */
  label: string
  /** Правая колонка: номер ячейки, сочетание клавиш, состояние. */
  hint?: string
  /** Слова, по которым строка ищется помимо `label`. */
  keywords?: string
  run: () => void
}

/**
 * Отбор — по словам, а не по одной подстроке.
 *
 * Человек печатает то, что помнит, и помнит обрывками: «03 imp», «файл mod»,
 * «оракул». Каждое слово должно найтись где-нибудь в строке — в подписи,
 * подсказке, ключевых словах или названии раздела, — а порядок слов значения не
 * имеет.
 *
 * Порядок ответа: сперва те, чья подпись НАЧИНАЕТСЯ с первого слова, потом те,
 * где оно внутри подписи, потом остальные (нашлись по подсказке или разделу).
 * Внутри разряда — исходный порядок: он смысловой (ячейки идут по тетради,
 * действия — по важности), и пересортировывать его нечем.
 */
export function matchItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...items]
  const scored: { item: PaletteItem; rank: number; at: number }[] = []
  items.forEach((item, at) => {
    const hay =
      `${item.label} ${item.hint ?? ''} ${item.keywords ?? ''} ${item.group}`.toLowerCase()
    if (!words.every((word) => hay.includes(word))) return
    const head = item.label.toLowerCase()
    scored.push({ item, at, rank: head.startsWith(words[0]) ? 0 : head.includes(words[0]) ? 1 : 2 })
  })
  scored.sort((a, b) => a.rank - b.rank || a.at - b.at)
  return scored.map((entry) => entry.item)
}

/**
 * Заголовок раздела — только там, где раздел сменился.
 *
 * После отбора группы перемешиваются, и печатать «Ячейки» над каждой строкой
 * значит нарисовать список, в котором вдвое больше заголовков, чем строк.
 */
export function groupHeads(items: readonly PaletteItem[]): (string | null)[] {
  let last: string | null = null
  return items.map((item) => {
    const head = item.group === last ? null : item.group
    last = item.group
    return head
  })
}
