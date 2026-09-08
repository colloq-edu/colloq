import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { colloqTheme } from '@/components/notebook/cm-theme'

/**
 * Одежда редактора файла: та же, что у ячейки, плюс то, чего у ячейки нет.
 *
 * Цвета токенов, всплывающие подсказки, поиск и скобки — всё общее, и это не
 * экономия, а требование: `def` в файле обязан быть тем же `def`, что в ячейке
 * под ним, иначе экран распадается на два продукта.
 *
 * Своего здесь ровно три вещи, и все три — про то, что файл занимает колонку
 * целиком: поле с номерами строк, полоса поиска, которая в ячейке не бывает, и
 * запас по краям, без которого последняя строка прилипает к нижнему краю, а
 * плашка с именем соседа срезается о верхний.
 */
const surface = EditorView.theme({
  '&': {
    height: '100%',
  },
  '.cm-scroller': {
    // Тот же шрифт, что и в ячейках: он задан в index.css для .cm-editor и
    // сюда доезжает сам. Здесь — только то, что относится к колонке.
    paddingBottom: '40vh',
    /*
     * Четырнадцать пикселей сверху — ровно высота плашки с именем соседа.
     *
     * Плашка висит НАД строкой, а скроллер файла — настоящий и обязан резать:
     * это окно в длинный файл. Без запаса каретка на ПЕРВОЙ строке теряла
     * десять пикселей из четырнадцати, то есть имя было срезано по горизонту.
     * В ячейке этот же запас не нужен: там ничего не режется вовсе
     * (CodeEditor.svelte · .cm-scroller).
     */
    paddingTop: '14px',
  },
  /*
   * Поле номеров отделено линией, а не воздухом.
   *
   * В ячейке номеров нет вовсе: там код длиной в экран, и номер строки нечему
   * помогать. В файле на триста строк номер — это то, чем показывают друг другу
   * место вслух посреди семинара, и он должен читаться, не притворяясь кодом.
   */
  '.cm-gutters': {
    backgroundColor: 'transparent',
    borderRight: '1px solid rgb(var(--line-soft))',
    color: 'rgb(var(--faint))',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 10px 0 16px',
    minWidth: '44px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'rgb(var(--muted))',
    fontWeight: '600',
  },
  '.cm-foldGutter .cm-gutterElement': {
    padding: '0 4px',
    color: 'rgb(var(--faint))',
  },
  // Строка под курсором подсвечивается только в том редакторе, где курсор и
  // есть. Тот же довод, что и в ячейках, — но здесь редактор один, и правило
  // работает против одного случая: файл, открытый рядом с набором в терминале.
  '&:not(.cm-focused) .cm-activeLine': {
    backgroundColor: 'transparent !important',
  },
  '&.cm-focused .cm-activeLine': {
    backgroundColor: 'rgb(var(--surface) / 0.7)',
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: '1px solid rgb(var(--line))',
  },
  '.cm-panel.cm-search': {
    padding: '6px 12px',
    fontFamily: 'inherit',
    fontSize: '12px',
  },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
    fontFamily: 'inherit',
    fontSize: '12px',
  },
  '.cm-panel.cm-search input': {
    backgroundColor: 'rgb(var(--canvas))',
    border: '1px solid rgb(var(--line))',
    color: 'rgb(var(--ink))',
    padding: '3px 6px',
  },
  '.cm-panel.cm-search button': {
    backgroundColor: 'rgb(var(--canvas))',
    backgroundImage: 'none',
    border: '1px solid rgb(var(--line))',
    color: 'rgb(var(--muted))',
    padding: '3px 8px',
  },
})

export const fileTheme: Extension = [colloqTheme, surface]
