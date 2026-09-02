/**
 * Formatting the room's code with black.
 *
 * A seminar notebook is written live, on a projector, by several people at
 * once — which is exactly the situation where code drifts into four different
 * spacing habits within one file. One button that puts it all in one shape is
 * worth more here than in a repository, because the reader is a room rather
 * than a reviewer, and they are reading it in real time.
 *
 * Two decisions carry this file.
 *
 * **A broken cell must not stop the others.** Half a seminar's cells are not
 * valid Python at the moment somebody presses the button: a cell being typed, a
 * cell holding `%matplotlib inline`, a cell that is `!pip install`. black
 * refuses all of those, and the naive implementation — one black run over the
 * concatenation — would refuse the whole notebook because of one line somebody
 * is still writing. So every cell is formatted on its own, inside its own
 * try/except, and a cell black cannot parse is simply left exactly as it was.
 *
 * **It runs in the room's own kernel, silently.** black is a Python tool and
 * the Python that matters is the one the seminar is running — the same version,
 * the same environment. Running it as a normal cell would put an execution
 * count and an output on somebody's screen, so it goes through Jupyter's silent
 * path: no count, no broadcast, no trace in the document.
 */
import * as Y from 'yjs'
import { cellsAt, getCells, type YCell } from '@shared/notebook'
import { getSessionDoc } from '../collab/index.js'

/** Marks writes as ours, so persistence and peers can tell them from typing. */
const ORIGIN = 'format'

/** black's default is 88. A projector at the back of a lecture hall is not. */
export const LINE_LENGTH = 100

export interface FormatOutcome {
  /** Cells whose text actually changed. */
  changed: number
  /** Cells black refused — a magic, a shell line, or code mid-sentence. */
  skipped: number
  /**
   * Ячейки, которые правили, пока работал black; они входят и в `skipped`.
   *
   * Отдельным числом, потому что причина у них другая, и сказать про них надо
   * другое: их не «оставили как были», их не тронули, чтобы не стереть
   * набранное.
   */
  edited: number
  /** Cells that were already in shape. */
  unchanged: number
  error: string | null
}

/**
 * The program that does the work, on the kernel side.
 *
 * The sources travel as base64 rather than being interpolated into the snippet:
 * a seminar's code contains quotes, backslashes and triple-quoted strings, and
 * every one of them is a way for string-building to produce Python that means
 * something other than what was typed.
 */
function program(sources: string[]): string {
  const payload = Buffer.from(JSON.stringify(sources), 'utf8').toString('base64')
  return [
    'import json as _json, base64 as _b64',
    `_cells = _json.loads(_b64.b64decode("${payload}").decode("utf-8"))`,
    '_out = []',
    'try:',
    '    import black as _black',
    `    _mode = _black.Mode(line_length=${LINE_LENGTH})`,
    'except Exception as _e:',
    '    print(_json.dumps({"error": "black is not installed in this environment"}))',
    '    _mode = None',
    'if _mode is not None:',
    '    for _src in _cells:',
    '        try:',
    // format_str keeps the trailing newline it adds; a notebook cell does not
    // want one, and leaving it in would mark every cell as changed forever.
    '            _out.append(_black.format_str(_src, mode=_mode).rstrip("\\n"))',
    '        except Exception:',
    // Not valid Python right now — a magic, a shell escape, or a line being
    // typed. Leaving it alone is the whole point of formatting cell by cell.
    '            _out.append(None)',
    '    print(_json.dumps({"formatted": _out}))',
  ].join('\n')
}

interface KernelLike {
  execute(
    code: string,
    handlers: {
      onExecuteInput(execCount: number): void
      onStream(name: 'stdout' | 'stderr', text: string): void
      onData(mimebundle: Record<string, string>, execCount: number | null): void
      onError(ename: string, evalue: string, traceback: string[]): void
      onClear(wait: boolean): void
    },
    opts?: { silent?: boolean },
  ): Promise<'ok' | 'error' | 'abort'>
}

/**
 * Run black over every code cell of a room and write back what changed.
 *
 * Only cells whose text is actually different are touched. Rewriting a cell
 * with identical text would still be an edit as far as the shared document is
 * concerned: it would move everybody's cursor and mark the notebook dirty for
 * a change nobody made.
 */
export async function formatNotebook(
  sessionId: string,
  kernel: KernelLike,
  book?: string,
): Promise<FormatOutcome> {
  const { doc } = getSessionDoc(sessionId)
  // Форматируют ту тетрадь, в тулбаре которой нажали, а не всю комнату:
  // переписать чужой лист по нажатию в своём — не то, что обещает кнопка.
  const cells = (book ? cellsAt(doc, book) : null) ?? getCells(doc)

  const targets: { cell: YCell; text: string }[] = []
  for (const cell of cells.toArray()) {
    if (cell.get('type') !== 'code') continue
    const source = cell.get('source') as Y.Text | undefined
    const text = source?.toString() ?? ''
    if (text.trim().length === 0) continue
    targets.push({ cell, text })
  }
  if (targets.length === 0) {
    return { changed: 0, skipped: 0, edited: 0, unchanged: 0, error: null }
  }

  let out = ''
  const status = await kernel.execute(
    program(targets.map((t) => t.text)),
    {
      onExecuteInput: () => {},
      onStream: (_name, text) => (out += text),
      onData: () => {},
      onError: () => {},
      onClear: () => {},
    },
    { silent: true },
  )
  if (status !== 'ok') {
    return {
      changed: 0,
      skipped: 0,
      edited: 0,
      unchanged: 0,
      error: 'The kernel could not run the formatter.',
    }
  }

  let parsed: { formatted?: (string | null)[]; error?: string }
  try {
    // The kernel prints one JSON line; anything else on stdout is not ours.
    const line = out.split('\n').reverse().find((l) => l.trim().startsWith('{')) ?? ''
    parsed = JSON.parse(line) as { formatted?: (string | null)[]; error?: string }
  } catch {
    const error = 'The formatter did not answer.'
    return { changed: 0, skipped: 0, edited: 0, unchanged: 0, error }
  }
  if (parsed.error) return { changed: 0, skipped: 0, edited: 0, unchanged: 0, error: parsed.error }
  const formatted = parsed.formatted ?? []

  let changed = 0
  let skipped = 0
  let edited = 0
  let unchanged = 0

  doc.transact(() => {
    targets.forEach((target, i) => {
      const next = formatted[i]
      if (typeof next !== 'string') {
        skipped += 1
        return
      }
      if (next === target.text) {
        unchanged += 1
        return
      }
      const source = target.cell.get('source') as Y.Text | undefined
      if (!source) return
      /*
       * Текст перечитывается здесь, внутри той же транзакции, что и замена.
       *
       * Между снимком и этой строкой — круг до ядра: если оно занято ячейкой,
       * запрос стоит в его очереди до конца этой ячейки. Всё, что за это время
       * напечатали в форматируемые ячейки, лежит уже здесь, а замена целиком
       * стёрла бы его без следа — чужой origin `format` под Ctrl+Z у автора не
       * отменяется. Ячейку, которая разошлась со снимком, не трогаем: пусть
       * останется неотформатированной, но написанной.
       */
      if (source.toString() !== target.text) {
        skipped += 1
        edited += 1
        return
      }
      /*
       * Replace wholesale rather than diff. A character-level diff would keep
       * other people's cursors in place, which sounds better — but black moves
       * whole lines, so the "smart" result is a cursor that has quietly landed
       * somewhere else in the code. One clean replacement is honest about the
       * fact that the cell was rewritten.
       */
      source.delete(0, source.length)
      source.insert(0, next)
      changed += 1
    })
  }, ORIGIN)

  return { changed, skipped, edited, unchanged, error: null }
}
