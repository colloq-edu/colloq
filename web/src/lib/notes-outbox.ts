/**
 * This device's speaker-note edits the server has not confirmed yet, per
 * document and page: the notes' outbox. SessionState wires it to the control
 * socket; this is the bookkeeping, kept apart so it can be checked on its own.
 *
 * Three jobs, each the cure for a way an edit was lost.
 *
 *  · It is what the editors show. The server's map is a step behind this
 *    device: offline, or with an echo still on its way, a slide turned away
 *    from and back to opened on the server's older text, and the next
 *    keystroke saved "old text + keystroke" over what had been typed there.
 *
 *  · It is the notes' queue, in place of the control queue. An edit is a
 *    page's whole text, and the control queue holds sixteen messages and
 *    drops the oldest: a deck annotated offline past its sixteenth slide lost
 *    the first ones. Here every page keeps its latest text, however many.
 *
 *  · It is resent on every reconnect. An edit written into a socket that
 *    died a moment later may never have reached the server, and nothing else
 *    would ever send it again.
 *
 * An edit goes only when the server echoes the very text it holds, and only
 * once every text of that page sent before it on this socket has come back:
 * the server handles one socket's messages in order and echoes every edit it
 * accepts to the device that made it (control.ts · notes:set). So a late echo
 * of an older text, the first "A" of A → AB → A, settles nothing, and a text
 * this device never sent is another device's edit, which an unconfirmed one
 * here keeps outranking until its own echo lands.
 */

interface Edit {
  /** The latest text, trimmed as the server stores and echoes it. */
  text: string
  /** Texts sent on the current socket and not echoed yet, oldest first. */
  flight: string[]
}

export interface NoteToSend {
  file: string
  page: number
  text: string
}

export class NotesOutbox {
  #files = new Map<string, Map<number, Edit>>()

  /** An edit of a page; `sent` says it was written into a live socket just now. */
  write(file: string, page: number, text: string, sent: boolean): void {
    const pages = this.#files.get(file) ?? new Map<number, Edit>()
    const edit = pages.get(page) ?? { text: '', flight: [] }
    edit.text = text.trim()
    if (sent) edit.flight.push(edit.text)
    pages.set(page, edit)
    this.#files.set(file, pages)
  }

  /** The server accepted `text` on a page. True when that settled this device's edit. */
  settle(file: string, page: number, text: string): boolean {
    const pages = this.#files.get(file)
    const edit = pages?.get(page)
    if (!pages || !edit) return false
    const at = edit.flight.indexOf(text)
    if (at < 0) return false
    edit.flight.splice(0, at + 1)
    if (edit.flight.length > 0 || edit.text !== text) return false
    pages.delete(page)
    if (pages.size === 0) this.#files.delete(file)
    return true
  }

  /**
   * Every unconfirmed edit, to be written into a new socket. Copies sent into
   * the old one may or may not have arrived, and their echoes would come on
   * the old socket, which is gone: only this send's echo counts from now on.
   */
  resend(): NoteToSend[] {
    const out: NoteToSend[] = []
    for (const [file, pages] of this.#files) {
      for (const [page, edit] of pages) {
        edit.flight = [edit.text]
        out.push({ file, page, text: edit.text })
      }
    }
    return out
  }

  /** Forget these pages' edits: something wrote them whole and must not be overwritten. */
  drop(file: string, pages: Iterable<number>): void {
    const mine = this.#files.get(file)
    if (!mine) return
    for (const page of pages) mine.delete(page)
    if (mine.size === 0) this.#files.delete(file)
  }

  /** The server's map of a document with this device's unconfirmed edits laid over it. */
  over(file: string | null, heard: Record<number, string>): Record<number, string> {
    const mine = file === null ? undefined : this.#files.get(file)
    if (!mine) return heard
    const next = { ...heard }
    for (const [page, { text }] of mine) {
      // As in the server's map: an empty note is the page's absence.
      if (text) next[page] = text
      else delete next[page]
    }
    return next
  }

  /** The pages of each document with an unconfirmed edit, in order. */
  pending(): Record<string, number[]> {
    return Object.fromEntries(
      [...this.#files].map(([file, pages]) => [file, [...pages.keys()].sort((a, b) => a - b)]),
    )
  }
}
