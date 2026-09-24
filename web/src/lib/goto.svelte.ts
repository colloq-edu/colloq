/**
 * Go to definition: ask, get there, and if there is nowhere to go — say so.
 *
 * The gesture lives in the editor (components/notebook/CodeEditor.svelte), the
 * lookup on the server (server/src/definitions.ts), and between them stands
 * this: one module that knows what to do with the answer. This work cannot be
 * kept in the editor — it is about the cell's text and knows nothing about
 * tabs or neighbouring notebooks; keeping it in the room screen would tie the
 * code editor to the layout of the whole workspace.
 *
 * LANDING is not an event but a state, and that is a load-bearing decision.
 * The cell being led to may not be built yet: the notebook builds `CellView`
 * only near the screen and puts a 240 px placeholder in place of distant ones
 * (Notebook.svelte · data-cell-deferred). An event sent to such a cell has
 * nobody listening — it goes nowhere, and the jump silently fails to arrive.
 * The mark lies here and waits: a cell built a frame after the scroll reads it
 * by itself and highlights the line, as if it had been waiting for it.
 */

import { tr } from '@shared/i18n'
import type { DefinitionHit, DefinitionMiss } from '@shared/protocol'
import { reveal, revealCell } from './reveal'
import type { SessionState } from './session.svelte'

/** Where to look inside the document one was led to. */
export interface Landing {
  /** The line, counting from one. */
  line: number
  /** The column, counting from zero. */
  column: number
  /**
   * The jump number.
   *
   * Without it a second jump TO THE SAME line is invisible: the fields are the
   * same, the `$derived` value does not change, and the highlight does not
   * blink. And a repeated jump is common: the person went off to read, came
   * back and clicked again.
   */
  seq: number
}

let seq = 0
let inCell = $state<(Landing & { cellId: string }) | null>(null)
let inFile = $state<(Landing & { path: string }) | null>(null)
let stale: ReturnType<typeof setTimeout> | null = null

/**
 * How long the mark waits for its document — and why it stops waiting at all.
 *
 * Virtualisation is what makes it wait: the cell being led to is built a frame
 * after the scroll, and an event sent before that would have nobody
 * listening. But the mark is a state, and if left hanging it fires AGAIN on
 * every new build of that same cell: half an hour later the person scrolls
 * past it, and the caret jumps inside by itself and takes focus away from
 * where they were working. Four seconds is surely more than a frame and
 * surely less than attention to a jump lasts.
 */
const WAITS_MS = 4000

function expire(): void {
  if (stale !== null) clearTimeout(stale)
  stale = setTimeout(() => {
    stale = null
    inCell = null
    inFile = null
  }, WAITS_MS)
}

/** The mark for this cell — or nothing. Read from a `$derived` in CellView. */
export function landingInCell(cellId: string): Landing | null {
  const now = inCell
  return now && now.cellId === cellId ? now : null
}

/** The same for a file: read where the file editor is built. */
export function landingInFile(path: string): Landing | null {
  const now = inFile
  return now && now.path === path ? now : null
}

/**
 * Clear the marks.
 *
 * Called when the person placed the caret themselves or started typing: the
 * highlight means "this is where I brought you", and after the very first
 * movement of one's own it turns into a puzzling bar in the middle of the
 * code.
 */
export function clearLanding(): void {
  if (stale !== null) clearTimeout(stale)
  stale = null
  inCell = null
  inFile = null
}

/** The words that explain "nowhere to go". */
function words(miss: DefinitionMiss): string | null {
  switch (miss.why) {
    /*
     * There was no name under the pointer — so there was no underline either,
     * and the person made no gesture: they clicked with the modifier held on a
     * space or on a string. There is nothing to say here, and nothing should
     * be said.
     */
    case 'nothing':
      return null
    case 'unknown':
      return tr('room.goto.unknown', { name: miss.name })
    case 'outside':
      /*
       * They clicked on the module name itself — we talk about the module, not
       * about a name in it. Otherwise it comes out as "pandas comes from
       * pandas": formally true, and it reads as a glitch.
       */
      return miss.name === miss.module
        ? tr('room.goto.outsideModule', { module: miss.module })
        : tr('room.goto.outside', { name: miss.name, module: miss.module })
    case 'opaque':
      /*
       * An empty `owner` — a chain off an EXPRESSION: `df[["a"]].head`,
       * `f(x).head`. There is no name there to talk about at all, and nothing
       * to call it by.
       */
      return miss.owner
        ? tr('room.goto.opaque', { owner: miss.owner })
        : tr('room.goto.opaqueThing')
  }
}

/** Bring the person to where this is defined. */
function land(session: SessionState, hit: DefinitionHit): void {
  seq += 1
  const landing = { line: hit.line, column: hit.column, seq }
  if (hit.where === 'cell' && hit.cellId) {
    inFile = null
    inCell = { ...landing, cellId: hit.cellId }
    /*
     * The screen is moved by `revealCell`, not by the editor itself.
     *
     * A cell has no scroller of its own (`.cm-scroller { overflow: visible }` in
     * CodeEditor.svelte), so `EditorView.scrollIntoView` would go up through
     * the ancestors and move `<main>` — that is, cut off the notebook's smooth
     * travel halfway: the browser treats a `scrollTop` edit in the middle of a
     * scroll as outside interference (Notebook.svelte · steering). The notebook
     * carries the cell, and the editor only highlights the line.
     */
    expire()
    revealCell(session, hit.cellId)
    return
  }
  if (hit.where === 'file' && hit.path) {
    inCell = null
    inFile = { ...landing, path: hit.path }
    expire()
    // Only the room screen knows the tabs — so the request to open the file goes there.
    reveal({ where: 'file', path: hit.path })
  }
}

/**
 * Ask where what is under the pointer is defined, and go there.
 *
 * `from` — where the question comes from: a cell id or a file path. By it the
 * server computes both the search order (one's own notebook before others)
 * and relative imports (`from . import util` — next to THIS file).
 */
export async function jumpToDefinition(
  session: SessionState,
  code: string,
  cursor: number,
  from: { cellId?: string; path?: string },
): Promise<void> {
  const reply = await session.define(code, cursor, from.cellId, from.path)
  /*
   * No answer at all — the socket is closed or the server did not make it in
   * time. Silence is legitimate here, and the whole room already says the same:
   * a "no connection" line is already hanging nearby, and a second toast about
   * the same thing would add nothing.
   */
  if (!reply) return
  if (reply.hit) {
    land(session, reply.hit)
    return
  }
  const said = reply.miss ? words(reply.miss) : null
  if (said) session.showError(said)
}
