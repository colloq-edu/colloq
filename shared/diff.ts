/**
 * Line diff, longest-common-subsequence.
 *
 * One implementation for both ends. The history panel draws it from what the
 * server computed; the oracle's proposed edit is drawn in the browser before
 * anything is written. If those two disagreed about what changed, the same
 * change would look like two different changes depending on where you read it.
 *
 * The alternative, a character diff, reads worse for code: a changed argument
 * shows as a scatter of insertions inside a line instead of as the line that
 * changed.
 *
 * Ячейки короткие — десятки строк, — и на них квадратичная таблица стоит
 * ничего. Но в ячейку попадает и лог на пятнадцать тысяч строк, а сравнение
 * считается синхронно в обработчике запроса истории: замер на этом коде —
 * десять тысяч строк против десяти тысяч дают секунды блокировки и сотни
 * мегабайт кучи, то есть стоит весь инстанс, пока кто-то листает ленту.
 * Поэтому здесь две страховки. Общие начало и конец отрезаются заранее, так
 * что правка одной строки в длинном логе и остаётся сравнением одной строки.
 * А на то, что осталось, стоит потолок площади: выше него разница
 * показывается как замена куска целиком — грубее, но за один проход.
 */

export type DiffKind = 'same' | 'added' | 'removed'

export interface DiffLine {
  kind: DiffKind
  text: string
}

/**
 * Площадь таблицы, выше которой построчное сравнение не считается.
 *
 * Четыре миллиона клеток — это десятки миллисекунд и шестнадцать мегабайт
 * (Int32Array, а не массив чисел, ровно ради второго числа). Столько
 * обработчик запроса потратить может; всё, что больше, — уже не сравнение
 * ячейки, а сравнение двух логов, и его никто не читает построчно.
 */
const MAX_TABLE = 4_000_000

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.length === 0 ? [] : before.split('\n')
  const b = after.length === 0 ? [] : after.split('\n')

  // Общее начало и общий конец совпадают построчно — таблица на них не нужна.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }

  const out: DiffLine[] = []
  for (let i = 0; i < head; i++) out.push({ kind: 'same', text: a[i] })
  for (const line of middle(a.slice(head, a.length - tail), b.slice(head, b.length - tail))) {
    out.push(line)
  }
  for (let i = a.length - tail; i < a.length; i++) out.push({ kind: 'same', text: a[i] })
  return out
}

/** The part that actually differs, by longest common subsequence. */
function middle(a: string[], b: string[]): DiffLine[] {
  const out: DiffLine[] = []
  if (a.length === 0 || b.length === 0 || (a.length + 1) * (b.length + 1) > MAX_TABLE) {
    for (const text of a) out.push({ kind: 'removed', text })
    for (const text of b) out.push({ kind: 'added', text })
    return out
  }

  const table = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: 'removed', text: a[i] })
      i++
    } else {
      out.push({ kind: 'added', text: b[j] })
      j++
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++] })
  while (j < b.length) out.push({ kind: 'added', text: b[j++] })
  return out
}

/** How much a proposal actually changes, for a one-line summary beside it. */
export function diffCounts(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'added') added++
    else if (line.kind === 'removed') removed++
  }
  return { added, removed }
}
