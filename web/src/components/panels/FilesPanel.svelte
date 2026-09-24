<script lang="ts">
  import RowsSkeleton from '@/components/ui/RowsSkeleton.svelte'
  import { tr } from '@shared/i18n'
  /**
   * The seminar folder as a tree.
   *
   * The list comes from the server already in the order in which it is drawn —
   * depth-first, folders before files — so no tree is built here: a row knows
   * its depth from the number of slashes in its path, and a collapsed folder
   * hides everything under it. That is the very reason the server returns a
   * flat list: a tree assembled twice, on two sides, is two places where the
   * order can diverge.
   *
   * Clicking a file opens it rather than copying a line for a cell: there is
   * now something to open it with.
   *
   * Everything else that can be done with a row lives in the menu under the
   * right click — and only there. The strip of three hover icons that used to
   * stand here could do exactly three things, took up space the size of the
   * file, and on a tablet was available only on the selected row; every further
   * action ran into it too, because a fourth icon no longer fit into a row 26
   * pixels high. Instead of the strip there is a single "⋯" button that opens
   * the same menu: the right click is not obvious, and on a phone it does not
   * exist at all.
   */
  import type { FileEntry } from '@shared/protocol'
  import { api } from '@/lib/api'
  import { getSessionState } from '@/lib/session.svelte'
  import { formatBytes, splitFileName } from '@/lib/utils'
  import ContextMenu, { type ContextMenuItem } from '@/components/ui/ContextMenu.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { copyText } from '@/lib/clipboard'
  import { iconFor } from '@/lib/file-icons'
  import { permitsIn } from '@/lib/may'
  import { dropFolder, movedPaths, planMove, readsInside, type Row } from '@/lib/tree-move'
  import { watchBooks } from '@/lib/yreactive.svelte'
  import {
    baseOf,
    joinPath,
    kindOf,
    parentOf,
    runnerFor,
    safeSegment,
    whySegmentRefused,
  } from '@shared/paths'

  /** One file still on the wire, and the bytes the browser has actually flushed. */
  interface Upload {
    id: number
    name: string
    size: number
    sent: number
  }

  interface Props {
    /** Open a file: editor, reader or preview — the caller decides. */
    onopen?: (path: string) => void
    /** What is open now — this row is highlighted. */
    active?: string | null
    /** A file was renamed: the tab on it has to follow. */
    onrename?: (from: string, to: string) => void
    /**
     * Run a script — with the same `file:run` that the bar above the editor
     * uses (editor/FileBar.svelte). This action did not exist here, and it was
     * added only as a menu item: running has no button of its own in a tree
     * row, nor should it — people look at a .py in the folder more often than
     * they run it.
     */
    onrun?: (path: string) => void
  }

  let { onopen, active = null, onrename, onrun }: Props = $props()

  const session = getSessionState()

  let dragDepth = $state(0)
  /** The folder that what is being carried will land in. Empty string: root. */
  let dragInto = $state<string | null>(null)
  /** A folder that would refuse: the "not here" highlight. */
  let dragDeny = $state<string | null>(null)
  /**
   * Files are being carried from the disk, not a tree row.
   *
   * The "drop files here" frame belongs only to the first case: one's own row
   * carried over the panel would light up an invitation to upload that nobody
   * asked for.
   */
  let dragFiles = $state(false)
  /**
   * The row being held in hand.
   *
   * It has to be remembered here: while dragging, the browser gives out only
   * the TYPES of the data transfer, and the content not before the drop.
   * Without this the highlight could not answer a single question about what
   * exactly is being carried.
   */
  let carried = $state<Row | null>(null)
  let uploads = $state<Upload[]>([])
  /** A warning, not an error: the upload worked but replaced something. */
  let note = $state<string | null>(null)
  let noteTimer: number | undefined
  let errorRender = $state<() => string | null>(() => null)
  const error = $derived(errorRender())
  /**
   * What exactly has just gone into the clipboard — as the line itself, not as
   * a word.
   *
   * The mark moved from the file row to under the tree. The row had room for
   * one word ("copied"), and both the path and the name can be copied: one word
   * for both cases leaves people guessing what was taken. Under the tree there
   * is room, and the path itself fits there — the very thing the person is
   * about to paste into a cell.
   */
  let copied = $state<string | null>(null)
  let confirming = $state<string | null>(null)
  const isHost = $derived(session.me.role === 'host')
  const may = $derived(permitsIn(session.session.rules, session.me.role, session.finished))
  /**
   * Who can drag rows around the tree.
   *
   * The room rule is `may.files`, as for everything else in this panel. The
   * role next to it is not redundant: `tree:move` on the server is
   * teacher-only, and a row that someone was allowed to pick up and that was
   * then silently not moved is a promise that will not be kept. The refusal
   * would also go not here but into the shared error bar.
   */
  const mayDrag = $derived(may.files && isHost)
  /** Room notebooks: an `.ipynb` already open as a notebook is not a file. */
  const books = watchBooks(session.doc)
  const isBook = (path: string): boolean => books.current.some((book) => book.path === path)
  /**
   * This is MY personal notebook.
   *
   * By the room rules, not by the document: the author and the access live in
   * the rules (shared/rules.ts · BookRule), because this is a right, and rights
   * are not carried in a CRDT, where anyone can rewrite them. The server gives
   * the same answer.
   */
  const myBook = (path: string): boolean => {
    const root = books.current.find((book) => book.path === path)?.root
    const rule = root ? may.rules.books?.[root] : null
    return rule?.access === 'owner' && rule.owner === session.me.id
  }

  /** Folders open only by an explicit click or drag-hover, including on first sync. */
  let expanded = $state<Set<string>>(new Set())
  const collapsed = $derived(new Set(
    session.files.filter(entry => entry.dir && !expanded.has(entry.path)).map(entry => entry.path),
  ))
  /**
   * The row touched last — and the only way to its actions from a finger.
   *
   * The action strip (a line for a cell, download, remove) appeared on `hover`,
   * and a tablet has no hover: a tap left the "hovered" state hanging until the
   * next touch, and after `future.hoverOnlyWhenSupported` in tailwind.config.js
   * it does not even leave that — the buttons cannot be reached from a finger
   * at all. The same answer as for the cell toolbar (CellView ·
   * `selected && opacity-100`): the actions are shown by the SELECTED row, and
   * it is selected by the same press that opens the file. The mouse loses
   * nothing: `hover` and `focus-within` stay alongside.
   */
  let picked = $state<string | null>(null)
  /**
   * Where "new file", "new folder" and uploads will land. Empty string: the
   * root.
   *
   * The target is the folder opened last (or the parent of the open file), and
   * it lives exactly as long as the folder is open: collapse it and the target
   * moves up to the parent. That way it has an obvious way out, not only "click
   * another file", and the caption at the bottom always names a place, not a
   * rule.
   */
  let target = $state('')
  /**
   * The same folder as a tree row — for a drop onto the dashed button at the
   * bottom.
   *
   * The button had no handler of its own, and the event bubbled up to the
   * section, which aims at the root: the caption read "Files — into folder
   * data", while the file landed next to that folder. Clicking the same button
   * meanwhile put it into `target` — one element sending two gestures into two
   * different folders, and the caption lied about one of them.
   */
  const targetRow: Row | null = $derived(target ? { path: target, dir: true } : null)
  /** The input line: creating something new or renaming an existing one. */
  let draft = $state<{ kind: 'file' | 'dir' | 'book' | 'rename'; dir: string; from?: string } | null>(
    null,
  )
  let draftName = $state('')
  let draftInput = $state<HTMLInputElement | null>(null)

  const visible = $derived(
    session.files.filter((entry) => {
      let folder = parentOf(entry.path)
      while (folder) {
        if (!expanded.has(folder)) return false
        folder = parentOf(folder)
      }
      return true
    }),
  )

  /**
   * Folders that have at least something inside.
   *
   * The list comes flat, and the parent is read from the path: assembling a
   * tree for the sake of one question, "is it empty here", would mean setting
   * up a second traversal order next to the first — exactly what the server
   * avoids by returning a flat list.
   */
  const filled = $derived(new Set(session.files.map((entry) => parentOf(entry.path))))

  /**
   * What to write under an expanded folder in which nothing is visible — and
   * whether to write it.
   *
   * There are three cases, and "empty" is right only in the first. A truncated
   * list is not empty: the traversal simply did not get to the contents, and
   * the line at the bottom says so. A folder at the very bottom even less so:
   * the traversal will never get there, there will be no line at the bottom
   * (`truncated` counts only list rows), and yet the files in it are there and
   * take up space — a single cell can see them.
   */
  function emptyWord(path: string): string | null {
    if (filled.has(path)) return null
    if (!readsInside(path)) return tr('room.ui.610')
    return truncated ? null : tr('room.ui.611')
  }

  const fileCount = $derived(session.files.filter((entry) => !entry.dir).length)
  const listed = $derived(session.files.length > 0 || uploads.length > 0)

  /**
   * The tree is not shown in full.
   *
   * The server walks folders level by level and hits a ceiling (see `listTree`
   * in workspace.ts): the deepest things do not make it into the list. Keeping
   * silent about it is not an option — a person who has not found their file
   * looks for it again rather than guessing about the ceiling.
   *
   * The flag travels next to the list, in the `files` message, and lives in the
   * room state (`session.filesTruncated`): it is replaced by every frame, so
   * the line goes out by itself as soon as the tree fits in full again.
   */
  const truncated = $derived(session.filesTruncated)

  const depthOf = (path: string): number => path.split('/').length - 1

  /**
   * Who keeps files open — from the room's presence, in a single pass.
   *
   * Not cursors: those live in the presence of the file itself and do not reach
   * the room. Here there is only "who is here", and that is enough not to start
   * editing a file that a neighbour is editing at that moment without knowing
   * anything about it.
   *
   * A map by path, not a search for every row. `#readPeers` returns a new array
   * on EVERY remote cursor, and the old code, on every such frame, walked
   * everyone present for every visible row of the tree: a hundred rows with
   * five hundred people are fifty thousand comparisons per neighbour's move
   * between cells. Now there is one pass over presence, and the rows read the
   * ready result.
   */
  const NOBODY: { id: string; color: string; name: string }[] = []

  const peersByPath = $derived.by(() => {
    const map = new Map<string, { id: string; color: string; name: string }[]>()
    for (const peer of session.peers) {
      const path = peer.user.editing
      if (peer.isSelf || !path) continue
      let here = map.get(path)
      if (!here) map.set(path, (here = []))
      // Three faces per row: more will not fit, and a second tab of the same
      // person is still the same person.
      if (here.length >= 3 || here.some((seen) => seen.id === peer.user.id)) continue
      here.push({ id: peer.user.id, color: peer.user.color, name: peer.user.name })
    }
    return map
  })

  function peersIn(path: string): { id: string; color: string; name: string }[] {
    return peersByPath.get(path) ?? NOBODY
  }

  /**
   * Forty pixels — the space for the file size, and also for the menu button.
   *
   * The width of this strip used to be computed from the number of icons in the
   * row: a strip designed for two buttons laid the third one out on top of the
   * file name — which is exactly what happened once, when PDF got "open". There
   * is now one button, and it will always be one, however many actions are
   * added to the menu, so there is nothing left to compute.
   */
  const SIZE_LANE = 40

  function toggle(path: string): void {
    // A tap on the arrow is also a touch of the row: having expanded a folder
    // with a finger, a person should also see what can be done with it.
    picked = path
    const next = new Set(expanded)
    if (next.has(path)) {
      next.delete(path)
      // A collapsed folder does not remain the target: a file would land where
      // it cannot be seen, and there was otherwise no way to return the target
      // to the root — only by opening a file next to it. Closing the folder is
      // exactly "deselecting".
      if (target === path || target.startsWith(`${path}/`)) target = parentOf(path)
    } else {
      next.add(path)
      target = path
    }
    expanded = next
  }

  /**
   * Open or download — on a single click.
   *
   * The same name also carries renaming on a double click, and the second click
   * reached `pick` as a second press: a binary file was requested and
   * downloaded twice (two tickets, two `a.click()` — a gigabyte dataset in the
   * downloads as two copies), a folder collapsed and expanded in a row, and a
   * student who has no renaming at all was left with nothing but the side
   * effects. `detail` is counted by the browser itself: 1 for the first click,
   * 2 for the second.
   */
  function pick(entry: FileEntry, detail = 1): void {
    if (detail > 1) return
    /*
     * A long finger press ends with a press — and the browser sends `click`
     * right after the menu has already opened. Without this line a menu called
     * up by a finger would also open the file it was called on: a tab on top of
     * the menu, while the menu is still about the file that is loading at that
     * very second.
     */
    if (heldOpen) {
      heldOpen = false
      return
    }
    // Selection — before any of the refusals below: the row that was pressed
    // shows its actions even if the room rule did not let the file open.
    picked = entry.path
    if (entry.dir) {
      // The target is set and cleared by `toggle`: an open folder is the
      // target, a closed one is not.
      toggle(entry.path)
      return
    }
    target = parentOf(entry.path)
    // Nothing can open a binary file: a press on it means "give it to me here".
    if (kindOf(entry.path) === 'binary') {
      void download(entry.path)
      return
    }
    /*
     * A notebook that is not in the room yet is added by the server — and the
     * server may refuse. A tab on it would open at once and stay forever at
     * "Opening…": a notebook that was not created will never appear in the
     * room, and there would be nothing to close the tab. The refusal comes
     * here, before the press, in the same words the server would answer with.
     *
     * What is asked is `ownBook`, not `files`: adding an .ipynb to the room
     * means adding a notebook, and that has its own rule (shared/rules.ts ·
     * ownBooks). Putting a file into the folder and adding it to the room are
     * different things, and the check that stood here was the wrong one.
     */
    if (kindOf(entry.path) === 'notebook' && !may.ownBook && !isBook(entry.path)) {
      // From `may`, as in the two neighbouring branches: its own words here,
      // after the bell, named a rule that nobody had changed.
      errorRender = () => (may.ownBookWhy + '.')
      return
    }
    onopen?.(entry.path)
  }

  /**
   * Fetch a ticket, then let the browser take the file.
   *
   * The anchor is gone because an anchor could only carry the session token,
   * and that token opens the control socket: a link copied into the group chat
   * handed every reader Restart and Restore under the teacher's name. The
   * ticket in this URL is good for one file for five minutes.
   */
  async function download(path: string): Promise<void> {
    try {
      const { token } = await api.fileTicket(session.session.id, path, session.token)
      const a = document.createElement('a')
      a.href = api.fileUrl(session.session.id, path, token)
      a.download = baseOf(path)
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (err) {
      errorRender = () => (err instanceof Error ? tr(err.message) : tr('room.ui.612'))
    }
  }

  /* ------------------------------------------------- new items and names */

  function startDraft(kind: 'file' | 'dir' | 'book'): void {
    draft = { kind, dir: target }
    // For a notebook the extension is filled in and will not be selected: the
    // person types the name, and `.ipynb` is not their concern.
    draftName = kind === 'book' ? '.ipynb' : ''
    queueMicrotask(() => {
      draftInput?.focus()
      draftInput?.setSelectionRange(0, 0)
    })
  }

  function startRename(entry: FileEntry): void {
    if (!isHost) return
    draft = { kind: 'rename', dir: parentOf(entry.path), from: entry.path }
    draftName = entry.name
    queueMicrotask(() => {
      draftInput?.focus()
      // The name without the extension is selected: people usually rename that,
      // not the `.py`.
      const dot = draftName.lastIndexOf('.')
      draftInput?.setSelectionRange(0, dot > 0 ? dot : draftName.length)
    })
  }

  function commitDraft(): void {
    const current = draft
    if (!current) return
    const name = draftName.trim()
    /*
     * A notebook draft starts with a pre-filled `.ipynb`, and "nothing typed"
     * looks here not like an empty string but like the extension alone. Without
     * this branch, leaving the field by clicking elsewhere produced the refusal
     * "the name starts with a dot", and the field did not close: every next
     * click elsewhere repeated the same error, and the only way out was Escape.
     * An empty name closes the field — the same as for a file and a folder.
     */
    if (!name || (current.kind === 'book' && name === '.ipynb')) return cancelDraft()
    if (!safeSegment(name)) {
      errorRender = () => (whySegmentRefused(name))
      return
    }
    const path = joinPath(current.dir, current.kind === 'book' && !name.endsWith('.ipynb') ? name + '.ipynb' : name)
    if (current.kind === 'rename') {
      if (current.from && current.from !== path) {
        /*
         * A taken name can be seen from here — the room's file list is already
         * here.
         *
         * The tab moves to the new name at once, and it has to: the broadcast
         * of the list arrives later and would close it as a tab on a vanished
         * file. But if the server refuses, there will be no list at all, and
         * the tab already stands on a non-existent path — the editor will let
         * go of the document together with its undo history and close with
         * 4404. So whatever the server would refuse with is checked before
         * sending, in its own words.
         */
        if (!session.files.some((entry) => entry.path === current.from)) {
          errorRender = () => (tr('room.ui.613', { p0: baseOf(current.from!) }))
          return
        }
        if (session.files.some((entry) => entry.path === path)) {
          errorRender = () => (tr('room.ui.614', { p0: baseOf(path) }))
          return
        }
        session.send({ t: 'tree:move', from: current.from, to: path })
        // A folder may have been renamed too — then everything in it moves, and
        // tabs on its contents have to move along with it.
        for (const moved of movedPaths(current.from, path, session.files)) {
          onrename?.(moved.from, moved.to)
        }
      }
    } else if (current.kind === 'dir') {
      session.send({ t: 'tree:mkdir', path })
    } else if (current.kind === 'book') {
      session.send({ t: 'tree:new', path })
      pendingOpen = path
    } else {
      session.send({ t: 'tree:new', path })
      // Open at once: a new file is created in order to write something in it,
      // and searching for it in the tree is work for nothing.
      pendingOpen = path
    }
    cancelDraft()
  }

  /**
   * A file that was created and should be opened as soon as it appears in the
   * list.
   *
   * The list comes from the server, not made up here: opening the file before
   * the server has confirmed it exists would mean opening a tab on something
   * that may not turn out to be there — the name is taken, the folder is gone,
   * the rule changed.
   *
   * `$state`, not a plain variable, and that is not decoration: the effect
   * below reads it on its first line and exits on `null` without reading
   * anything else. A plain variable would not be its dependency — the effect
   * would run once on mount and never wake up again, and the file would open
   * "some time later", that is, on someone else's next edit.
   */
  let pendingOpen = $state<string | null>(null)

  $effect(() => {
    if (!pendingOpen) return
    const waiting = pendingOpen
    if (!session.files.some((entry) => entry.path === waiting)) return
    pendingOpen = null
    onopen?.(waiting)
  })

  function cancelDraft(): void {
    draft = null
    draftName = ''
  }

  /*
   * A destructive question you cannot back out of with the keyboard is a trap,
   * and this one appears inline in a row rather than in a dialog you can see
   * the edges of. Escape cancels it; a delete already in flight is left alone,
   * because pretending to cancel something the server is doing would be a lie.
   */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    // The consumed key is marked: the terminal drawer closes on Escape if
    // nobody needed it, and "cancelled the file name" is exactly the case when
    // it was needed.
    if (draft) {
      event.preventDefault()
      return cancelDraft()
    }
    if (!confirming || deleting) return
    event.preventDefault()
    confirming = null
  }
  let deleting = $state<string | null>(null)
  let picker: HTMLInputElement | null = $state(null)
  let copyTimer: number | undefined
  let nextUploadId = 0

  $effect(() => () => {
    window.clearTimeout(copyTimer)
    // Otherwise the timer would expand a folder in a panel that is no longer on
    // screen.
    window.clearTimeout(hoverTimer)
    // And these would open a menu on a row that no longer exists — and keep its
    // record in memory together with the whole tree.
    window.clearTimeout(holdTimer)
    window.clearTimeout(heldTimer)
    // And the copy highlight, together with the memory of what the tree was
    // like before it.
    window.clearTimeout(freshTimer)
    window.clearTimeout(waitTimer)
  })

  function percent(upload: Upload): number {
    // A zero-byte file has nothing to report and is already there by the time
    // the row paints; anything else is a genuine fraction of the payload.
    if (upload.size === 0) return 100
    return Math.min(100, Math.round((upload.sent / upload.size) * 100))
  }

  /*
   * XMLHttpRequest rather than api.uploadFiles(), which is built on fetch —
   * fetch has no upload progress event at all, so a bar driven by it would be
   * an animation rather than a measurement. `xhr.upload.progress` reports bytes
   * handed to the socket, which is the only honest number available here.
   *
   * One request per file, in sequence: a batched multipart body can only report
   * a batch percentage, and the design puts the percentage on the row.
   */
  function put(
    file: File,
    dir: string,
    onSent: (sent: number) => void,
  ): Promise<{ files: FileEntry[]; replaced: string[] }> {
    return new Promise((resolve, reject) => {
      const form = new FormData()
      // The folder first: busboy parses the parts in order, and a field that
      // arrived after the file would be late by exactly the file it was sent
      // for.
      form.append('dir', dir)
      form.append('file', file, file.name)

      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api/sessions/${session.session.id}/files`)
      xhr.setRequestHeader('authorization', `Bearer ${session.token}`)
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onSent(event.loaded)
      }
      xhr.onload = () => {
        let body: { files?: FileEntry[]; replaced?: string[]; error?: string } = {}
        try {
          body = JSON.parse(xhr.responseText) as typeof body
        } catch {
          /* non-JSON error body */
        }
        if (xhr.status >= 200 && xhr.status < 300 && body.files) {
          resolve({ files: body.files, replaced: body.replaced ?? [] })
        } else reject(new Error(body.error || xhr.statusText || tr('room.ui.618')))
      }
      xhr.onerror = () => reject(new Error(tr('room.ui.618')))
      xhr.send(form)
    })
  }

  async function upload(list: FileList | File[] | null, dir: string) {
    const files = Array.from(list ?? [])
    if (files.length === 0) return
    // The permission — before the first byte: a refusal that arrives after the
    // file has been chosen reads to a person as a breakage, not as a room rule.
    if (!may.files) {
      errorRender = () => (may.filesWhy + '.')
      return
    }
    errorRender = () => (null)

    const queued: Upload[] = files.map((file) => ({
      id: nextUploadId++,
      name: file.name,
      size: file.size,
      sent: 0,
    }))
    uploads = [...uploads, ...queued]

    /*
     * What landed on top of what was already there.
     *
     * A file with the same name was replaced silently: a person drops their
     * `data.csv` into the room, and under that name there is already someone
     * else's, on which something is being computed in the seminar. There is no
     * way to undo this, but learning about it from the numbers is too late. It
     * is collected over the whole batch and reported in one line.
     */
    const overwritten: string[] = []

    for (let i = 0; i < files.length; i++) {
      const { id } = queued[i]
      try {
        const done = await put(files[i], dir, (sent) => {
          uploads = uploads.map((item) => (item.id === id ? { ...item, sent } : item))
        })
        session.files = done.files
        overwritten.push(...done.replaced)
      } catch (err) {
        errorRender = () => (err instanceof Error ? tr(err.message) : tr('room.ui.619', { p0: files[i].name }))
      } finally {
        uploads = uploads.filter((item) => item.id !== id)
      }
    }

    if (overwritten.length > 0 && !error) {
      note =
        overwritten.length === 1
          ? tr('room.ui.620', { p0: overwritten[0] })
          : tr('room.ui.621', { p0: overwritten.join(', ') })
      window.clearTimeout(noteTimer)
      noteTimer = window.setTimeout(() => (note = null), 8000)
    }
  }

  function remove(entry: FileEntry): void {
    deleting = entry.path
    errorRender = () => (null)
    session.send({ t: 'tree:remove', path: entry.path })
    confirming = null
    // There is no reply: the file list comes to the room in full, and the row
    // disappears with it. A refusal, if there is one, will arrive as an
    // ordinary error line.
    window.setTimeout(() => (deleting = null), 600)
  }

  /**
   * Put into the clipboard — and show as a line WHAT exactly went there.
   *
   * One door for both menu items: the path and the name differ only in text,
   * and the clipboard refusal is shared by both (on http without localhost
   * `navigator.clipboard` simply does not exist — see lib/clipboard.ts).
   *
   * Two and a half seconds, not one and a half: reading `data/train.csv` takes
   * longer than seeing a check mark.
   */
  async function copyInto(text: string): Promise<void> {
    try {
      await copyText(text)
      copied = text
      window.clearTimeout(copyTimer)
      copyTimer = window.setTimeout(() => (copied = null), 2600)
    } catch {
      errorRender = () => (tr('room.ui.622'))
    }
  }

  /* --------------------------------------------------------------- menu */

  /**
   * What is under the menu right now: a tree row or an empty part of the panel.
   *
   * A record, not a path string: the menu asks for `dir`, the name and the
   * extension, and searching for the row in the list for every item would mean
   * searching for it again after every edit of the tree by someone else. The
   * disappearance of the row itself is caught by the effect below — it also
   * closes a menu left hanging over a file that no longer exists.
   */
  type MenuOn = { kind: 'entry'; entry: FileEntry } | { kind: 'panel' }

  /** Where the menu stands, in window coordinates; `null`: menu closed. */
  let menuAt = $state<{ x: number; y: number } | null>(null)
  let menuOn = $state<MenuOn | null>(null)
  /** Where focus returns when the menu closes: the row or the "⋯" button. */
  let menuOpener = $state<HTMLElement | null>(null)
  /** The panel itself: the up and down arrows move through it. */
  let panel = $state<HTMLElement | null>(null)

  function openMenu(
    point: { x: number; y: number },
    on: MenuOn,
    opener: HTMLElement | null,
  ): void {
    menuOn = on
    menuOpener = opener
    menuAt = point
    // The hint about the right click is needed only until the first menu is
    // opened.
    rememberTip()
  }

  function closeMenu(): void {
    menuAt = null
    menuOn = null
    menuOpener = null
  }

  /*
   * The row the menu hung over may have been removed — by its own button, by
   * dragging or from a neighbouring tab. A menu about a vanished file is a set
   * of actions, each of which will answer "it is no longer there".
   */
  $effect(() => {
    const on = menuOn
    if (on?.kind !== 'entry') return
    if (!session.files.some((entry) => entry.path === on.entry.path)) closeMenu()
  })

  /** The row's name button: focus returns to it, and the arrows move by it. */
  function nameButtonIn(row: EventTarget | null): HTMLElement | null {
    return row instanceof HTMLElement ? row.querySelector<HTMLElement>('[data-row-name]') : null
  }

  function onRowMenu(event: MouseEvent, entry: FileEntry): void {
    event.preventDefault()
    // One's own row outranks the panel: the same event bubbles up to the
    // section, and the section opens the menu about the root of the class
    // folder.
    event.stopPropagation()
    picked = entry.path
    openMenu({ x: event.clientX, y: event.clientY }, { kind: 'entry', entry }, nameButtonIn(event.currentTarget))
  }

  function onPanelMenu(event: MouseEvent): void {
    event.preventDefault()
    openMenu({ x: event.clientX, y: event.clientY }, { kind: 'panel' }, null)
  }

  /** "⋯" opens the same menu — and closes it with a second press. */
  function onMoreClick(event: MouseEvent, entry: FileEntry): void {
    event.stopPropagation()
    const button = event.currentTarget as HTMLElement
    if (menuOn?.kind === 'entry' && menuOn.entry.path === entry.path) {
      closeMenu()
      return
    }
    picked = entry.path
    const box = button.getBoundingClientRect()
    // Down from the button, not from the pointer: "⋯" can be pressed from the
    // keyboard too, and then there is no pointer at all. The menu will not
    // slide past the right edge of the window — the component itself presses it
    // back.
    openMenu({ x: box.left, y: box.bottom + 2 }, { kind: 'entry', entry }, button)
  }

  /* ----------------------------------------------------- keys on a row */

  /**
   * The keyboard on a tree row.
   *
   * Shift+F10 and the "menu" key are the system-wide way to call up a context
   * menu, and the only way someone without a mouse gets to it. F2 and Delete
   * are the same as in any file manager; the arrows move between rows, because
   * Tab inside a tree of a hundred files is a hundred presses.
   */
  function onRowKeydown(event: KeyboardEvent, entry: FileEntry): void {
    const row = event.currentTarget as HTMLElement
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault()
      const box = row.getBoundingClientRect()
      picked = entry.path
      openMenu({ x: box.left + 8, y: box.bottom + 2 }, { kind: 'entry', entry }, row)
      return
    }
    if (event.key === 'F2') {
      event.preventDefault()
      if (mayRename) startRename(entry)
      else errorRender = () => whyEdit
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      askRemove(entry)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      step(row, event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  /**
   * The neighbouring row — by the markup, not by the `visible` list.
   *
   * The list knows paths, while focus is given to an element, and matching one
   * to the other would have to go through `querySelector` by path — that is,
   * through a selector assembled from a file name the person made up themselves
   * (a quote in the name, and the selector is invalid). The order of the
   * buttons in the markup is the order of the tree.
   */
  function step(from: HTMLElement, by: number): void {
    if (!panel) return
    const rows = [...panel.querySelectorAll<HTMLElement>('[data-row-name]')]
    const now = rows.indexOf(from)
    if (now < 0) return
    // At the edges we stay put. Wrapping around the file list would take one
    // from the last row to the first, and a tree is read from top to bottom.
    rows[now + by]?.focus()
  }

  /* ------------------------------------------------------ long press */

  let holdTimer: number | undefined
  /** Where the hold started — to tell a press from a scroll. */
  let holdFrom: { x: number; y: number } | null = null
  /** Opened by finger: the next `click` on this row echoes the gesture. */
  let heldOpen = false
  let heldTimer: number | undefined

  /**
   * Half a second of a finger on a row — the same menu.
   *
   * A phone has no right click, and "⋯" requires hitting the row first and only
   * then the icon. Half a second is the cross-platform bar for a long press;
   * anything shorter would fire for people who are just running a finger down
   * the list.
   *
   * Android sends `contextmenu` for the same press, and the menu then opens
   * twice in a row at the same point — that is, exactly once on screen. iOS
   * does not send `contextmenu` at all, and without the timer nothing would
   * open the menu there.
   */
  function onRowPointerDown(event: PointerEvent, entry: FileEntry): void {
    if (event.pointerType !== 'touch') return
    const row = event.currentTarget
    holdFrom = { x: event.clientX, y: event.clientY }
    window.clearTimeout(holdTimer)
    holdTimer = window.setTimeout(() => {
      holdFrom = null
      heldOpen = true
      // The echo lives for half a second: if the `click` never comes after it
      // (the finger was moved off the screen), the next real tap must not be
      // lost.
      window.clearTimeout(heldTimer)
      heldTimer = window.setTimeout(() => (heldOpen = false), 700)
      picked = entry.path
      openMenu({ x: event.clientX, y: event.clientY }, { kind: 'entry', entry }, nameButtonIn(row))
    }, 500)
  }

  /** The finger moved — this is a scroll, not a press. */
  function onRowPointerMove(event: PointerEvent): void {
    if (!holdFrom) return
    if (Math.abs(event.clientX - holdFrom.x) < 10 && Math.abs(event.clientY - holdFrom.y) < 10) {
      return
    }
    endHold()
  }

  function endHold(): void {
    window.clearTimeout(holdTimer)
    holdFrom = null
  }

  /* ------------------------------------------------------ permissions */

  /**
   * Renaming and removing can be done by the teacher — and that is not the same
   * as `files`.
   *
   * `tree:move` on the server is entirely teacher-only (control.ts), and
   * deletion is teacher-only with one exception: the author removes THEIR OWN
   * personal notebook themselves. The phrase is chosen the same way as
   * everywhere in the room: the room rule matters right up to the bell, and
   * after the bell all that matters to a person is that the class is over
   * (lib/may.ts · CLASS_IS_OVER).
   */
  const mayRename = $derived(isHost && may.files)
  const whyEdit = $derived(may.files ? tr('room.files.menu.hostOnly') : may.filesWhy)
  const mayRemove = (path: string): boolean => isHost || myBook(path)

  function askRemove(entry: FileEntry): void {
    if (!mayRemove(entry.path)) {
      errorRender = () => whyEdit
      return
    }
    confirming = entry.path
  }

  /**
   * The tree at the moment a copy was requested — to recognise the copy on
   * sight.
   *
   * The copy's name is chosen by the server (there is no race for a taken name
   * there), and it reaches the tab as an ordinary file list. In a tree of a
   * hundred rows a new row appears somewhere in the middle, and finding it by
   * eye is the very work that duplicating saves one from. So the list is
   * remembered before sending, and the path that appears is highlighted for a
   * second and a half.
   *
   * `$state`, not a plain variable: the effect below reads it on its first
   * line, and a plain one would not be its dependency — it would never wake up.
   */
  let beforeCopy = $state<Set<string> | null>(null)
  /** The row that has just appeared as a copy. */
  let freshCopy = $state<string | null>(null)
  let freshTimer: number | undefined
  let waitTimer: number | undefined

  function duplicate(entry: FileEntry): void {
    if (!may.files) {
      errorRender = () => (may.filesWhy + '.')
      return
    }
    errorRender = () => (null)
    beforeCopy = new Set(session.files.map((row) => row.path))
    // The server may also have refused — then no new path will appear at all.
    // Without this deadline the memory of the request would live until the end
    // of class and would highlight someone else's file uploaded half an hour
    // later.
    window.clearTimeout(waitTimer)
    waitTimer = window.setTimeout(() => (beforeCopy = null), 5000)
    // The copy's name is chosen by the server: a taken name is not a refusal
    // here but a routine matter — people duplicate the same thing twice in a
    // row (shared/protocol.ts · tree:copy).
    session.send({ t: 'tree:copy', path: entry.path })
  }

  $effect(() => {
    const was = beforeCopy
    if (!was) return
    const added = session.files.filter((row) => !was.has(row.path))
    if (added.length === 0) return
    beforeCopy = null
    window.clearTimeout(waitTimer)
    // The first of those that appeared: there is one copy, and everything else
    // in the same frame is someone else's uploads, with no reason to highlight
    // them.
    freshCopy = added[0].path
    window.clearTimeout(freshTimer)
    freshTimer = window.setTimeout(() => (freshCopy = null), 1600)
  })

  /** Create something INSIDE this folder: the target moves there too. */
  function startDraftIn(kind: 'file' | 'dir' | 'book', dir: string): void {
    // A collapsed folder expands: the input line stands where the file will
    // appear, and in a closed folder it is not visible at all — the field would
    // silently go "nowhere".
    if (dir && !expanded.has(dir)) expanded = new Set(expanded).add(dir)
    target = dir
    startDraft(kind)
  }

  function uploadInto(dir: string): void {
    if (dir && !expanded.has(dir)) expanded = new Set(expanded).add(dir)
    target = dir
    picker?.click()
  }

  /* ---------------------------------------------------- menu contents */

  function copyItem(text: string, label: string): ContextMenuItem {
    return { label, icon: 'copy', run: () => void copyInto(text) }
  }

  function fileItems(entry: FileEntry): ContextMenuItem[] {
    const path = entry.path
    const kind = kindOf(path)
    const runner = runnerFor(path)
    const items: ContextMenuItem[] = []
    /*
     * "Open" is exactly the same as clicking the row, and that is why a binary
     * file does not have it: a click on it means "give it to me here", that is,
     * "Download" already. Two items doing the same thing read as two different
     * actions, and a person will pick one of them at random.
     */
    if (kind !== 'binary') {
      items.push({
        label: tr('room.files.menu.open'),
        icon: kind === 'notebook' ? 'notebook' : 'file',
        // Adding an .ipynb to the room means ADDING a notebook, and that has
        // its own rule (shared/rules.ts · ownBooks). The server gives the same
        // answer.
        disabled: kind === 'notebook' && !isBook(path) && !may.ownBook,
        why: may.ownBookWhy,
        run: () => pick(entry),
      })
    }
    if (runner && onrun) {
      items.push({
        label: tr('room.files.menu.run'),
        icon: 'play',
        disabled: !may.run,
        why: may.runWhy,
        run: () => onrun?.(path),
      })
    }
    items.push(
      { ...copyItem(path, tr('room.files.menu.copyPath')), gap: items.length > 0 },
      copyItem(entry.name, tr('room.files.menu.copyName')),
      {
        gap: true,
        label: tr('room.files.menu.download'),
        icon: 'download',
        run: () => void download(path),
      },
      {
        label: tr('room.files.menu.duplicate'),
        icon: 'copy-plus',
        // A copy ADDS a file, like "new file" and like an upload — so its rule
        // is `files` too, not the role (server/src/control.ts · tree:copy).
        disabled: !may.files,
        why: may.filesWhy,
        run: () => duplicate(entry),
      },
      {
        gap: true,
        label: tr('room.files.menu.rename'),
        icon: 'pencil',
        keys: 'F2',
        disabled: !mayRename,
        why: whyEdit,
        run: () => startRename(entry),
      },
      {
        label: tr('room.files.menu.remove'),
        icon: 'trash',
        keys: 'Del',
        danger: true,
        disabled: !mayRemove(path),
        why: whyEdit,
        // Into the same confirmation in the row below, as before: a second
        // window on top of the menu would ask the same thing twice.
        run: () => (confirming = path),
      },
    )
    return items
  }

  function folderItems(entry: FileEntry): ContextMenuItem[] {
    const path = entry.path
    const shut = collapsed.has(path)
    return [
      {
        label: shut ? tr('room.files.menu.expand') : tr('room.files.menu.collapse'),
        icon: shut ? 'chevron-right' : 'chevron-down',
        run: () => toggle(path),
      },
      {
        gap: true,
        label: tr('room.files.menu.newFileHere'),
        icon: 'file-plus',
        disabled: !may.files,
        why: may.filesWhy,
        run: () => startDraftIn('file', path),
      },
      {
        label: tr('room.files.menu.newDirHere'),
        icon: 'folder-plus',
        disabled: !may.files,
        why: may.filesWhy,
        run: () => startDraftIn('dir', path),
      },
      {
        label: tr('room.files.menu.newBookHere'),
        icon: 'notebook',
        disabled: !may.ownBook,
        why: may.ownBookWhy,
        run: () => startDraftIn('book', path),
      },
      {
        label: tr('room.files.menu.uploadHere'),
        icon: 'upload',
        disabled: !may.files,
        why: may.filesWhy,
        run: () => uploadInto(path),
      },
      { ...copyItem(path, tr('room.files.menu.copyPath')), gap: true },
      {
        label: tr('room.files.menu.duplicate'),
        icon: 'copy-plus',
        disabled: true,
        // In the same words the server would refuse with: one phrase for both
        // ends (server/src/control.ts · tree:copy).
        why: tr('server.files.copyFolder'),
        run: () => {},
      },
      {
        gap: true,
        label: tr('room.files.menu.rename'),
        icon: 'pencil',
        keys: 'F2',
        disabled: !mayRename,
        why: whyEdit,
        run: () => startRename(entry),
      },
      {
        label: tr('room.files.menu.remove'),
        icon: 'trash',
        keys: 'Del',
        danger: true,
        disabled: !mayRemove(path),
        why: whyEdit,
        run: () => (confirming = path),
      },
    ]
  }

  /** An empty part of the panel: only what is put INTO the class folder. */
  function panelItems(): ContextMenuItem[] {
    return [
      {
        label: tr('room.files.menu.newFile'),
        icon: 'file-plus',
        disabled: !may.files,
        why: may.filesWhy,
        run: () => startDraft('file'),
      },
      {
        label: tr('room.files.menu.newDir'),
        icon: 'folder-plus',
        disabled: !may.files,
        why: may.filesWhy,
        run: () => startDraft('dir'),
      },
      {
        label: tr('room.files.menu.newBook'),
        icon: 'notebook',
        disabled: !may.ownBook,
        why: may.ownBookWhy,
        run: () => startDraft('book'),
      },
      {
        gap: true,
        label: tr('room.files.menu.upload'),
        icon: 'upload',
        disabled: !may.files,
        why: may.filesWhy,
        run: () => picker?.click(),
      },
    ]
  }

  const menuItems = $derived.by(() => {
    const on = menuOn
    if (!on) return []
    if (on.kind === 'panel') return panelItems()
    return on.entry.dir ? folderItems(on.entry) : fileItems(on.entry)
  })

  const menuTitle = $derived(menuOn?.kind === 'entry' ? menuOn.entry.name : null)

  const menuLabel = $derived.by(() => {
    const on = menuOn
    if (!on) return ''
    if (on.kind === 'panel') return tr('room.files.menu.panel')
    return on.entry.dir ? tr('room.files.menu.folder') : tr('room.files.menu.file')
  })

  /* ----------------------------------------------------- one-time hint */

  /**
   * "Right-click a file for its actions" — in one line, and exactly until the
   * person has opened the menu for the first time.
   *
   * A hint that is always there stops being a hint and becomes a part of the
   * interface that people stop reading. The flag lives in the browser, not in
   * the room: it is about the hand, not about the class, and in a private
   * window it simply will not be there — then the hint will show once more, and
   * that is no trouble.
   */
  const TIP_KEY = 'colloq.files.menuTip'

  function tipWasSeen(): boolean {
    try {
      return localStorage.getItem(TIP_KEY) === '1'
    } catch {
      // Storage is closed (a private window, cookies forbidden) — we assume
      // there is no point in showing it: a hint is not worth an exception on
      // every frame.
      return true
    }
  }

  let tipSeen = $state(tipWasSeen())

  function rememberTip(): void {
    if (tipSeen) return
    tipSeen = true
    try {
      localStorage.setItem(TIP_KEY, '1')
    } catch {
      /* no storage — the hint will simply come back next time */
    }
  }

  /* ------------------------------------------------------------- dragging */

  /**
   * Our own type in the data transfer — and the path in it.
   *
   * `text/plain` is put next to it, but it is not what decides: any selection
   * on the page has text in the transfer, and a panel trusting it would take a
   * piece of a cell's output for a tree row. The type is our own because the
   * question "is this ours" is asked mid-drag, when the transfer's content
   * cannot be read yet.
   */
  const PATH_TYPE = 'application/x-colloq-path'

  /** What is carried: our own row, files from disk, or nothing we accept. */
  function carriedKind(event: DragEvent): 'row' | 'files' | null {
    const types = event.dataTransfer?.types
    if (!types) return null
    if (types.includes(PATH_TYPE)) return 'row'
    if (types.includes('Files')) return 'files'
    return null
  }

  /**
   * A refusal said while the record is still in hand.
   *
   * The browser does not deliver to a target marked `dropEffect: 'none'`: there
   * will be no `drop` event on it at all, and there would be nowhere to say
   * anything on release. So the words appear mid-drag — and go away by
   * themselves as soon as the aim moves to where dropping is allowed. The flag
   * is needed to clear only OUR OWN words: upload refusals live in the same
   * line, and they must not be cleared by moving the mouse.
   */
  let saidOnDrag = false

  function sayRefusal(why: string | null): void {
    if (why) {
      errorRender = () => (why)
      saidOnDrag = true
      return
    }
    if (!saidOnDrag) return
    saidOnDrag = false
    errorRender = () => (null)
  }

  function onDragStart(event: DragEvent, entry: FileEntry): void {
    const data = event.dataTransfer
    if (!data || !mayDrag) return
    // The previous refusal was about the previous gesture.
    sayRefusal(null)
    data.setData(PATH_TYPE, entry.path)
    // Next to it as plain text: the same thing is visible to everything that
    // can accept text, including a cell and the terminal.
    data.setData('text/plain', entry.path)
    data.effectAllowed = 'move'
    carried = { path: entry.path, dir: entry.dir }
  }

  function onDragEnd(): void {
    carried = null
    endDrag()
  }

  /** End of the gesture: all it lit goes out — the timer too, without fail. */
  function endDrag(): void {
    dragDepth = 0
    dragFiles = false
    dragInto = null
    dragDeny = null
    // And the words too: the refusal was about this gesture, and the gesture is
    // over. Otherwise a cancelled drag — Escape, the pointer outside the
    // panel — left a red bar about a refusal that no longer existed, until the
    // next gesture or upload.
    sayRefusal(null)
    hoverOver(null)
  }

  /**
   * A collapsed folder under the pointer expands by itself — but not at once.
   *
   * Half a second: with less, the tree would open up under the hand of anyone
   * who is just carrying a record past it, and the target would slide out from
   * under the pointer. The timer is cleared on every leave and on release —
   * otherwise it would expand a folder over which there is nobody any more.
   *
   * Plain variables, not `$state`: nobody draws them, and state that a timer
   * writes and the markup reads is a sure way to get an effect that wakes
   * itself up.
   */
  let hoverDir = ''
  let hoverTimer: number | undefined

  function hoverOver(dir: string | null): void {
    const wanted = dir !== null && collapsed.has(dir) ? dir : ''
    if (wanted === hoverDir) return
    hoverDir = wanted
    window.clearTimeout(hoverTimer)
    if (!wanted) return
    hoverTimer = window.setTimeout(() => {
      // It only expands: collapsing a folder under the pointer is a trick, not
      // help, and the target would disappear together with its rows.
      const next = new Set(expanded)
      next.add(wanted)
      expanded = next
    }, 500)
  }

  /**
   * Where the gesture is aiming right now.
   *
   * Called from `dragover` — the very event that has to call `preventDefault`:
   * without it the browser will not accept the drop at all, and will simply
   * open a file from the disk instead of the page. The highlight is set from it
   * too, rather than from `dragenter`: `dragenter` on a child of the row comes
   * before `dragleave` on the row itself, and the frame went out exactly over
   * the name of the folder being aimed at.
   *
   * `stopPropagation` on the row — so that it outranks the section: the same
   * event bubbles up to it, and the section aims at the root.
   */
  function aim(event: DragEvent, onto: Row | null): void {
    const kind = carriedKind(event)
    if (!kind) return
    event.preventDefault()
    if (onto) event.stopPropagation()
    const data = event.dataTransfer
    if (!data) return
    const into = dropFolder(onto)
    if (kind === 'files') {
      /*
       * The permission is known already — there is no reason to wait for the
       * release. A folder lit with the accent for someone who may not put
       * things there promises a copy that will not happen, and at the same
       * second the panel says the opposite: the dashed button at the bottom is
       * disabled and named after the rule. The words come mid-drag, as for tree
       * rows: a target with `dropEffect: 'none'` does not deliver a `drop`
       * event at all.
       */
      if (!may.files) {
        data.dropEffect = 'none'
        dragInto = null
        dragDeny = into
        // In an empty room the same thing is written across the whole overlay —
        // there is no need to repeat one sentence twice on one screen.
        sayRefusal(listed ? may.filesWhy + '.' : null)
        return
      }
      data.dropEffect = 'copy'
      dragInto = into
      dragDeny = null
      sayRefusal(null)
      hoverOver(into)
      return
    }
    // A row from another window: the path is in the transfer, but there is
    // nothing to check it against in this tree — the transfer cannot be read
    // mid-drag. A move cannot be promised in that case.
    const plan = carried ? planMove(carried, onto, session.files) : null
    const goes = plan?.do === 'move'
    data.dropEffect = goes ? 'move' : 'none'
    dragInto = goes ? into : null
    dragDeny = plan?.do === 'refuse' ? into : null
    sayRefusal(plan?.do === 'refuse' ? plan.why : null)
    hoverOver(into)
  }

  function onDragEnter(event: DragEvent) {
    const kind = carriedKind(event)
    if (!kind) return
    dragDepth += 1
    if (dragDepth === 1) dragFiles = kind === 'files'
  }

  function onDragLeave() {
    dragDepth = Math.max(0, dragDepth - 1)
    // Left the panel entirely: a highlight left on a row over which there is
    // nobody any more promises a move that will not happen.
    if (dragDepth === 0) endDrag()
  }

  function onDrop(event: DragEvent, onto: Row | null) {
    event.preventDefault()
    event.stopPropagation()
    const kind = carriedKind(event)
    // The path is taken from the transfer, not from `carried`: the transfer
    // survives both a tab switch and a second window of the same room.
    const path = kind === 'row' ? (event.dataTransfer?.getData(PATH_TYPE) ?? '') : ''
    endDrag()
    if (kind === 'row') {
      carried = null
      if (!path) return
      // The permission is asked here too, not only in `draggable`: the row may
      // have come from a window opened before the room rules changed.
      if (!mayDrag) {
        errorRender = () => (may.filesWhy + '.')
        saidOnDrag = false
        return
      }
      // Whether it is a folder or a file is known by the room's list, not by
      // the transfer: `planMove` checks against it first thing anyway.
      const known = session.files.find((entry) => entry.path === path)
      const plan = planMove({ path, dir: known?.dir ?? false }, onto, session.files)
      // Three outcomes, not two: a gesture that ended where it began is a slip
      // of the finger, and a refusal to it would be untrue.
      if (plan.do === 'refuse') {
        errorRender = () => (plan.why)
        saidOnDrag = false
        return
      }
      if (plan.do !== 'move') return
      errorRender = () => (null)
      saidOnDrag = false
      session.send({ t: 'tree:move', from: plan.from, to: plan.to })
      // The tabs follow at once, and they have to: the file list will come
      // later and would close them as tabs on a vanished path — together with
      // the undo history. Together with the CONTENTS: a tab knows an exact
      // path, and a folder move stated by the folder's name alone does not move
      // a single one of the tabs for whose sake the folder is dragged around.
      for (const moved of movedPaths(plan.from, plan.to, session.files)) {
        onrename?.(moved.from, moved.to)
      }
      return
    }
    // It cannot be said before the drop — but silently swallowing the file is
    // even less acceptable: a released file after which nothing happened reads
    // as a breakage.
    if (!may.files) {
      errorRender = () => (may.filesWhy + '.')
      return
    }
    void upload(event.dataTransfer?.files ?? null, dropFolder(onto))
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- A frame around the whole panel means "into the root": the root has no row
     of its own that could be highlighted. It is not drawn for files from the
     disk: there the dashed button at the bottom says the same thing. -->
<section
  bind:this={panel}
  class="relative flex shrink-0 flex-col gap-0 px-3 pb-1 pt-5 {!dragFiles && dragInto === ''
    ? 'ring-1 ring-inset ring-accent'
    : !dragFiles && dragDeny === ''
      ? 'ring-1 ring-inset ring-danger/50'
      : ''}"
  aria-label={tr('room.ui.585')}
  ondragenter={onDragEnter}
  ondragover={(event) => aim(event, null)}
  ondragleave={onDragLeave}
  ondrop={(event) => onDrop(event, null)}
  oncontextmenu={onPanelMenu}
>
  <!-- The line leads the heading off to the actions, so the buttons read as the
       quiet end of the heading, not as icons hung on it. -->
  <div class="flex items-center gap-2 px-1 pb-2">
    <h2 class="text-2xs font-bold uppercase tracking-section text-muted">{tr('room.ui.586')}</h2>
    <span class="h-px flex-1 bg-line" aria-hidden="true"></span>
    <!--
      The buttons appear if anything at all is allowed: files and ONE'S OWN
      NOTEBOOK are two different rules, and the pair "files are the teacher's,
      own notebooks are allowed" is an ordinary one. The notebook button is not
      hidden meanwhile but dims with a reason: a hidden button reads as "this
      does not exist here".
    -->
    {#if may.files || may.ownBook}
      <div class="-my-1 -mr-1 flex shrink-0 items-center gap-0.5">
        {#if may.files}
          <button
            type="button"
            class="flex h-6 w-6 items-center justify-center text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            title={target ? tr('room.extra.258', { p0: target }) : tr('room.extra.259')}
            aria-label={tr('room.ui.587')}
            onclick={() => startDraft('file')}
          >
            <Icon name="file-plus" size={13} />
          </button>
        {/if}
        <button
          type="button"
          class="flex h-6 w-6 items-center justify-center text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-40"
          disabled={!may.ownBook}
          title={may.ownBook
            ? target ? tr('room.extra.260', { p0: target }) : tr('room.extra.261')
            : may.ownBookWhy}
          aria-label={tr('room.ui.588')}
          onclick={() => startDraft('book')}
        >
          <Icon name="notebook" size={13} />
        </button>
        {#if may.files}
          <button
            type="button"
            class="flex h-6 w-6 items-center justify-center text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            title={target ? tr('room.extra.262', { p0: target }) : tr('room.extra.263')}
            aria-label={tr('room.ui.589')}
            onclick={() => startDraft('dir')}
          >
            <Icon name="folder-plus" size={13} />
          </button>
          <button
            type="button"
            class="flex h-6 w-6 items-center justify-center text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            title={tr('room.ui.590')}
            aria-label={tr('room.ui.590')}
            onclick={() => picker?.click()}
          >
            <Icon name="upload" size={13} />
          </button>
        {/if}
      </div>
    {:else if listed}
      <span class="font-mono text-micro tabular-nums text-muted">{fileCount}</span>
    {/if}
  </div>

  <input
    bind:this={picker}
    type="file"
    multiple
    class="hidden"
    onchange={(event) => {
      const input = event.currentTarget
      void upload(input.files, target)
      input.value = ''
    }}
  />

  {#snippet nameField()}
    <input
      bind:this={draftInput}
      bind:value={draftName}
      class="min-w-0 flex-1 border-0 bg-canvas px-1 py-0.5 font-mono text-code text-ink outline-none ring-1 ring-accent/50"
      spellcheck="false"
      autocomplete="off"
      onblur={commitDraft}
      onkeydown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commitDraft()
        }
        // Escape closes the field — and only the field. The same key on the
        // window closes the terminal drawer unless someone says it is already
        // busy.
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          cancelDraft()
        }
      }}
    />
  {/snippet}

  {#if !session.filesArrived && !listed}
    <div class="px-2"><RowsSkeleton /></div>
  {/if}

  {#each visible as entry (entry.path)}
    {@const depth = depthOf(entry.path)}
    {@const empty = entry.dir && !collapsed.has(entry.path) ? emptyWord(entry.path) : null}
    {@const here = peersIn(entry.path)}
    <div
      class="group relative flex h-[26px] items-center transition-colors duration-100
             {freshCopy === entry.path
        ? 'bg-accent/10'
        : active === entry.path || picked === entry.path
          ? 'bg-raised'
          : 'hover:bg-raised focus-within:bg-raised'}
             {dragInto === entry.path
        ? 'ring-1 ring-inset ring-accent'
        : dragDeny === entry.path
          ? 'ring-1 ring-inset ring-danger/50'
          : ''}"
      style={`padding-left:${4 + depth * 14}px`}
      draggable={mayDrag}
      ondragstart={(event) => onDragStart(event, entry)}
      ondragend={onDragEnd}
      ondragover={(event) => aim(event, entry)}
      ondrop={(event) => onDrop(event, entry)}
      oncontextmenu={(event) => onRowMenu(event, entry)}
      onpointerdown={(event) => onRowPointerDown(event, entry)}
      onpointermove={onRowPointerMove}
      onpointerup={endHold}
      onpointercancel={endHold}
      onpointerleave={endHold}
      role="presentation"
    >
      <!-- The open file is marked by a bar at the very edge: it takes no space
           in the row and is visible even when the name is squeezed to an
           ellipsis. -->
      {#if active === entry.path}
        <span class="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden="true"></span>
      {/if}

      <!-- The arrow is a button, not a picture: pressing it did exactly
           nothing, because there was nobody to catch it, and the folder "would
           not open". The drawing is nine pixels, but it is pressed with a
           finger and a pen: negative margins grow the target to 22 without
           shifting the column of names by a pixel. -->
      {#if entry.dir}
        <button
          type="button"
          class="-m-1 flex h-[22px] w-[22px] shrink-0 items-center justify-center p-1 text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
          aria-expanded={!collapsed.has(entry.path)}
          aria-label={`${collapsed.has(entry.path) ? tr('room.extra.265') : tr('room.extra.266')} ${entry.name}`}
          onclick={() => toggle(entry.path)}
        >
          <Icon name="chevron-down" size={9} class={collapsed.has(entry.path) ? '-rotate-90' : ''} />
        </button>
      {:else}
        <span class="h-3.5 w-3.5 shrink-0"></span>
      {/if}
      <span class="flex h-3.5 w-[18px] shrink-0 items-center justify-center">
        <Icon
          name={entry.dir ? 'folder' : iconFor(entry.path)}
          size={12}
          class={active === entry.path ? 'text-ink' : 'text-faint'}
        />
      </span>

      {#if draft?.kind === 'rename' && draft.from === entry.path}
        {@render nameField()}
      {:else}
        <!-- `draggable` on the name too: the row is dragged by it, and some
             browsers do not hand a gesture started on a button to its parent.
             There is one handler — the event bubbles up to the row. -->
        <button
          type="button"
          draggable={mayDrag}
          data-row-name
          class="row-name flex min-w-0 flex-1 items-center self-stretch text-left font-mono text-code
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset
                 focus-visible:ring-accent/40
                 {entry.dir
            ? 'font-medium text-ink'
            : active === entry.path
              ? 'font-semibold text-ink'
              : 'text-muted'}"
          title={entry.dir ? entry.path : tr('room.extra.269', { p0: entry.path })}
          onclick={(event) => pick(entry, event.detail)}
          ondblclick={() => startRename(entry)}
          onkeydown={(event) => onRowKeydown(event, entry)}
        >
          <span class="truncate">{splitFileName(entry.name).stem}</span>
          <span class="shrink-0">{splitFileName(entry.name).ext}</span>
        </button>

        <!--
          The size strip is also the place of the menu button: both start at the
          same spot, so the numbers stand in a column and "⋯" does not run into
          the name.
        -->
        <div
          class="relative mr-2 flex h-6 shrink-0 items-center justify-end"
          style={`min-width:${entry.dir ? 0 : SIZE_LANE}px`}
        >
            {#if here.length > 0}
              <!--
                Who keeps the file open. It stands on top of the size and does
                not hide under the pointer: this is what people look at the row
                for.

                The space for "⋯" is set aside IN ADVANCE, not on hover. The
                button lies absolutely positioned at the right edge and is
                filled with colour, and on a row with dots it ran over them:
                half of the first one was visible, and the rest were not there
                at all — that is, exactly what the row is examined for
                disappeared. The dots cannot be shifted on hover: the pointer is
                heading for "⋯", and everything under it would twitch at that
                moment. So the offset is constant, and nothing jumps anywhere.
              -->
              <span class="flex items-center gap-1 pr-[26px]">
                {#each here as peer (peer.id)}
                  <span
                    class="h-1.5 w-1.5 rounded-full"
                    style={`background:${peer.color}`}
                    title={tr('room.extra.270', { p0: peer.name })}
                  ></span>
                {/each}
              </span>
            {:else if !entry.dir}
              <span
                class="whitespace-nowrap font-mono text-micro tabular-nums text-muted transition-opacity
                       duration-100 group-hover:opacity-0 group-focus-within:opacity-0
                       {picked === entry.path ? 'opacity-0' : ''}"
              >
                {formatBytes(entry.size)}
              </span>
            {/if}
            <!--
              One button instead of the former strip of three icons: for a
              pointer, on hover; for a finger, on the selected row (see
              `picked`). `pointer-events-none` while it is not visible is not
              decoration: the button lies on top of the size, and while
              invisible it caught a tap on the right edge of the row.

              `after:-inset-2` grows the target to forty pixels without shifting
              a single pixel in the row: the drawing stays 24×24, and a finger
              hits it. Neighbouring rows are not affected by this — their
              buttons are `pointer-events-none` at that time.
            -->
            <span
              class="absolute inset-y-0 right-0 flex items-center bg-raised transition-opacity
                     duration-100 group-hover:pointer-events-auto group-hover:opacity-100
                     group-focus-within:pointer-events-auto group-focus-within:opacity-100
                     {picked === entry.path ? 'opacity-100' : 'pointer-events-none opacity-0'}"
            >
              <button
                type="button"
                data-menu-button
                aria-haspopup="menu"
                aria-expanded={menuOn?.kind === 'entry' && menuOn.entry.path === entry.path}
                class="relative flex h-6 w-6 items-center justify-center text-muted
                       transition-colors duration-100 after:absolute after:-inset-2
                       after:content-[''] hover:text-ink focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-accent/40"
                title={tr('room.files.menu.more')}
                aria-label={tr('room.files.menu.moreFor', { p0: entry.name })}
                onclick={(event) => onMoreClick(event, entry)}
              >
                <Icon name="more" size={13} />
              </button>
            </span>
        </div>
      {/if}
    </div>

    {#if confirming === entry.path}
      <div
        class="flex h-[26px] items-center gap-2 bg-raised pr-2"
        style={`padding-left:${4 + depth * 14 + 32}px`}
      >
        <!--
          There is no longer an explanation in the row, and that is a request
          from the class of 20 Sep 2026.

          The files panel is narrow: "Delete the folder with everything in it?"
          got down to two letters and an ellipsis, that is, it took up space and
          communicated nothing. The warning has not gone anywhere — it moved
          into the button's own tooltip, where it is read on hover and where the
          width does not cut it.
        -->
        <span class="min-w-0 flex-1"></span>
        <button
          type="button"
          class="shrink-0 text-2xs font-bold uppercase tracking-caps text-danger transition-opacity duration-100 hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 disabled:opacity-50"
          disabled={deleting === entry.path}
          title={entry.dir
            ? tr('room.ui.599')
            : isBook(entry.path)
              ? tr('room.ui.600')
              : tr('room.ui.601')}
          onclick={() => remove(entry)}
        >
          {deleting === entry.path ? tr('room.ui.542') : tr('room.ui.598')}
        </button>
        <button
          type="button"
          class="shrink-0 text-2xs font-bold uppercase tracking-caps text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onclick={() => (confirming = null)}
        > {tr('room.ui.29')} </button>
      </div>
    {/if}

    <!--
      An expanded empty folder looked no different from a collapsed one: a
      person pressed the arrow, the tree did not change by a single row, and
      they read it as "the arrow does not work". The row stands one level
      deeper — where the first thing put into the folder will appear — and
      accepts a drop itself.

      The words are chosen by `emptyWord`: "empty" is not the only answer, and
      where the panel simply cannot see the contents it would be a plain lie.
    -->
    {#if empty}
      <div
        class="flex h-[22px] items-center text-2xs text-faint {dragInto === entry.path
          ? 'bg-accent/10'
          : ''}"
        style={`padding-left:${4 + (depth + 1) * 14 + 32}px`}
        title={readsInside(entry.path)
          ? undefined
          : tr('room.extra.275')}
        ondragover={(event) => aim(event, entry)}
        ondrop={(event) => onDrop(event, entry)}
        role="presentation"
      >
        {empty}
      </div>
    {/if}
  {/each}

  {#if draft && draft.kind !== 'rename'}
    <!-- The input line stands where the file will appear: in the chosen folder,
         with its indentation. The indentation is one level more, because this
         is the folder's content. -->
    <div
      class="flex h-[26px] items-center pr-2"
      style={`padding-left:${4 + (draft.dir ? depthOf(draft.dir) + 1 : 0) * 14}px`}
    >
      <span class="h-3.5 w-3.5 shrink-0"></span>
      <span class="flex h-3.5 w-[18px] shrink-0 items-center justify-center">
        <Icon
          name={draft.kind === 'dir'
            ? 'folder'
            : draft.kind === 'book'
              ? 'notebook'
              : iconFor(draftName || 'x.txt')}
          size={12}
          class="text-faint"
        />
      </span>
      {@render nameField()}
    </div>
  {/if}

  <!-- The list has ended, but the folder has not. The line stands where the
       tree ends: it is the answer to the question "where is my file?", asked
       with the eyes. -->
  {#if truncated}
    <p class="px-2 pt-1.5 text-2xs leading-snug text-muted"> {tr('room.ui.602')} <span class="font-mono">os.listdir()</span>.
    </p>
  {/if}

  {#each uploads as item (item.id)}
    {@const done = percent(item)}
    <div class="flex flex-col gap-1 px-2 pb-1 pt-1.5">
      <div class="flex items-center gap-2.5">
        <span class="h-4 w-[3px] shrink-0 bg-brand-2" aria-hidden="true"></span>
        <span class="flex min-w-0 flex-1 font-mono text-code text-muted" title={item.name}>
          <span class="truncate">{splitFileName(item.name).stem}</span>
          <span class="shrink-0">{splitFileName(item.name).ext}</span>
        </span>
        <span
          class="min-w-10 shrink-0 whitespace-nowrap text-right font-mono text-micro tabular-nums text-accent-text"
        >
          {done}%
        </span>
      </div>
      <!-- Scaled, not resized: a width transition would relayout the row on
           every progress event, and only transform is allowed to move. -->
      <div
        class="h-0.5 bg-line"
        role="progressbar"
        aria-label={tr('room.files.loading', { name: item.name })}
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          class="h-full origin-left bg-accent"
          style="transform: scaleX({done / 100}); transition: transform var(--speed-quick) linear"
        ></div>
      </div>
    </div>
  {/each}

  <!--
    Always there, in any state: otherwise an empty room would be left with a
    paragraph and no target. Where files are put by the teacher, the button
    stays in place and names the rule — like the overlay for a dropped file:
    opening the picker and refusing afterwards means spending someone's time on
    a decision known in advance.
  -->
  <button
    type="button"
    class="mx-1 mt-2 flex h-9 shrink-0 items-center justify-center border border-dashed text-2xs transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed {dragDepth >
      0 && dragFiles && may.files
      ? 'border-accent bg-accent/10 text-accent-text'
      : 'border-line text-muted'} {may.files ? 'hover:border-faint hover:text-ink' : ''}"
    disabled={!may.files}
    title={may.files ? tr('room.extra.461') : undefined}
    onclick={() => picker?.click()}
    ondragover={(event) => aim(event, targetRow)}
    ondrop={(event) => onDrop(event, targetRow)}
  >
    {#if !may.files}
      {may.filesWhy}
    {:else}
      {target ? tr('room.ui.607', { p0: target }) : tr('room.ui.608')}
    {/if}
  </button>

  <!-- The right click is the only thing in this panel that cannot be guessed
       from its look: "⋯" appears only under the pointer, and the menu under it
       is wider than one button. The line goes away for good as soon as the menu
       has been opened even once — a hint that is always there stops being a
       hint. -->
  {#if !tipSeen && listed}
    <p class="px-2 pt-1.5 text-2xs leading-snug text-faint">{tr('room.files.menu.tip')}</p>
  {/if}

  <!-- What went into the clipboard — in full, and under the tree. The file row
       had room for one word, and what goes there is a path: "copied" without
       the path itself makes people check the clipboard by pasting. The strip
       has the same shape as the error and the warning above, only the edge
       colour is different. -->
  {#if copied}
    <div
      class="mt-1.5 flex items-baseline gap-1.5 border-l-2 border-positive bg-surface px-2 py-1"
    >
      <span class="shrink-0 text-2xs text-muted">{tr('room.files.menu.copied')}</span>
      <span class="min-w-0 flex-1 break-all font-mono text-2xs text-ink">{copied}</span>
    </div>
  {/if}

  <!-- The strip is pinned to the bottom edge of what is visible: the panel lies
       in one scrolling strip with the others, and in a room where the list is
       longer than the screen, the refusal words were appended below the dashed
       button — that is, off screen. What remained was a red frame and a "not
       allowed" cursor without a single word about the reason, and there is
       nowhere to say it on release: a target with `dropEffect: 'none'` does not
       deliver a `drop` event. -->
  {#if error}
    <div
      class="sticky bottom-0 z-10 mt-1.5 flex items-start gap-2 border-l-2 border-danger bg-surface px-2 py-1 text-2xs text-danger"
    >
      <span class="min-w-0 flex-1 break-words">{error}</span>
      <button
        type="button"
        class="shrink-0 p-0.5 transition-opacity duration-100 hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
        aria-label={tr('room.ui.499')}
        onclick={() => (errorRender = () => null)}
      >
        <Icon name="x" size={11} />
      </button>
    </div>
  {/if}

  <!-- Not an error: the upload went through — but it went on top of someone
       else's file, and keeping silent about that is not an option. A separate
       strip, because the colour here is different. -->
  {#if note && !error}
    <div class="mt-1.5 flex items-start gap-2 border-l-2 border-line px-2 py-1 text-2xs text-muted">
      <span class="min-w-0 flex-1 break-words">{note}</span>
      <button
        type="button"
        class="shrink-0 p-0.5 transition-opacity duration-100 hover:opacity-70"
        aria-label={tr('room.ui.499')}
        onclick={() => (note = null)}
      >
        <Icon name="x" size={11} />
      </button>
    </div>
  {/if}

  {#if dragDepth > 0 && dragFiles && !listed}
    <!-- Without a list there is nothing to light up, and the panel becomes the
         target itself. A room where files are put by the teacher says so right
         here: learning about a refusal after having released the file is the
         same as not learning at all. -->
    <div
      class="pointer-events-none absolute inset-x-4 inset-y-3 flex items-center justify-center border border-dashed text-2xs {may.files
        ? 'border-accent bg-accent/10 text-accent-text'
        : 'border-line bg-surface/80 text-muted'}"
    >
      {may.files ? tr('room.ui.608') : may.filesWhy}
    </div>
  {/if}
</section>

<!--
  The menu stands OUTSIDE the panel and is positioned from the window: the panel
  lies in one scrolling strip with the others, and `overflow` clips vertically
  too — a menu opened at the bottom row would be cut off exactly where people
  are looking at it. The same technique as the ban menu and the access menu on
  the notebook tab.
-->
<ContextMenu
  at={menuAt}
  label={menuLabel}
  title={menuTitle}
  items={menuItems}
  opener={menuOpener}
  onclose={closeMenu}
/>

<style>
  /*
   * A long press on a row calls our menu — and on iOS, at the same time, the
   * system "Copy / Share" callout. Two panels on top of one row, and the upper
   * one is not ours. It is suppressed exactly on the row names: there is
   * nowhere else to select text in the files panel, while in the rest of the
   * room the callout is legitimate.
   */
  .row-name {
    -webkit-touch-callout: none;
  }
</style>
