/**
 * Отступ в редакторах Colloq: сколько его и что делает Tab.
 *
 * Общее на два редактора — ячейку тетради и файл, — потому что код между ними
 * ездит копированием, а разъехавшиеся отступы видно только ядру: половина
 * функции на четырёх пробелах, половина на двух, и IndentationError в месте,
 * которое глазами не отличить. Одна из двух правок уже расходилась: Tab был
 * привязан в файле и не был в ячейке.
 *
 * Чистое — здесь, привязка к клавише — в компонентах: CodeMirror у обоих
 * подгружается лениво, и статический импорт отсюда утащил бы его в общий
 * бандл (см. importCodeMirror в CodeEditor.svelte).
 */
import type { Command, KeyBinding } from '@codemirror/view'
import type { EditorSelection as Selection } from '@codemirror/state'

/**
 * Отступ — четыре пробела.
 *
 * Не два (умолчание CodeMirror) и не табы: в тетради пишут Python, а в нём
 * смешанные отступы — это TabError, и правит его не тот, кто их смешал.
 */
export const INDENT = '    '

/** Ширина отступа в колонках. */
export const INDENT_WIDTH = INDENT.length

/**
 * В какой колонке стоит курсор, если перед ним на строке этот текст.
 *
 * Таб считается не за знак, а до следующей отметки: своих табов редакторы не
 * ставят, но вставить чужой текст в ячейку никто не мешает.
 */
export function columnOf(before: string, tabSize: number): number {
  let column = 0
  for (const ch of before) {
    column = ch === '\t' ? column + tabSize - (column % tabSize) : column + 1
  }
  return column
}

/**
 * Что вставляет Tab, нажатый без выделения.
 *
 * НЕ «четыре пробела всегда» и не сдвиг строки целиком: отступ добивается до
 * следующей отметки, как в любом редакторе с мягким табом. Курсор в середине
 * `return  1` получает столько пробелов, чтобы встать на отметку, а не столько,
 * чтобы уехала вся строка вместе с уже написанным.
 *
 * Сдвиг СТРОК остаётся у выделения (indentMore) и у Shift-Tab (indentLess) —
 * это разные жесты, и путать их нельзя: первым набирают, вторым перестраивают
 * уже написанное.
 */
export function tabInsert(before: string, tabSize: number): string {
  const column = columnOf(before, tabSize)
  return ' '.repeat(INDENT_WIDTH - (column % INDENT_WIDTH))
}

/**
 * Tab и Shift-Tab для CodeMirror — одни и те же в ячейке и в файле.
 *
 * Части CodeMirror приходят параметрами, а не импортом: см. заголовок файла.
 */
export function tabKey(cm: {
  EditorSelection: typeof Selection
  indentMore: Command
  indentLess: Command
}): KeyBinding {
  return {
    key: 'Tab',
    run: (view) => {
      const { state } = view
      /* Ячейку под замком (лекция, чужая попытка, законченное занятие) Tab не
         правит — и не держит: нажатие достаётся браузеру, и фокус уходит
         дальше, как и должен уходить из нередактируемого текста. */
      if (state.readOnly) return false
      // Выделение — это про строки целиком, даже если оно внутри одной.
      if (state.selection.ranges.some((range) => !range.empty)) return cm.indentMore(view)
      view.dispatch(
        state.changeByRange((range) => {
          const line = state.doc.lineAt(range.from)
          const insert = tabInsert(line.text.slice(0, range.from - line.from), state.tabSize)
          return {
            changes: { from: range.from, insert },
            range: cm.EditorSelection.cursor(range.from + insert.length),
          }
        }),
        { userEvent: 'input.indent', scrollIntoView: true },
      )
      return true
    },
    shift: cm.indentLess,
  }
}
