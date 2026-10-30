import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { colloqTheme } from '@/components/notebook/cm-theme'

/**
 * The contest editor's styling: the cell's colours, so a `def` in a solution
 * is the same `def` as in a notebook, plus what a fixed-height source box
 * needs — the whole height, a scroller of its own, and a line-number gutter
 * set off by a line (Paper «19 · Контесты», K1: the gutter on the surface
 * colour, the code on the canvas).
 */
const surface = EditorView.theme({
  '&': {
    height: '100%',
  },
  '.cm-scroller': {
    overflow: 'auto',
    paddingTop: '8px',
    paddingBottom: '24px',
  },
  '.cm-gutters': {
    backgroundColor: 'rgb(var(--surface))',
    borderRight: '1px solid rgb(var(--line))',
    color: 'rgb(var(--faint))',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 10px 0 12px',
    minWidth: '40px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'rgb(var(--muted))',
    fontWeight: '600',
  },
  '&:not(.cm-focused) .cm-activeLine': {
    backgroundColor: 'transparent !important',
  },
  '&.cm-focused .cm-activeLine': {
    backgroundColor: 'rgb(var(--surface) / 0.7)',
  },
})

export const sourceTheme: Extension = [colloqTheme, surface]
