import { tr } from '@shared/i18n'
/**
 * Parsing an incoming Yjs frame into verbs — before it is applied.
 *
 * The seminar's document is shared, and that is what a CRDT is: anyone who is
 * connected can write anything into it — someone else's output, someone else's
 * `stdin`, "the kernel died", a line into the terminal under someone else's
 * name. The room's rules ("students do not delete cells") are meaningless as
 * long as the bytes are applied before anyone has looked at what is in them.
 *
 * The looking has to happen BEFORE applying. Applying and rolling back is not
 * possible: Yjs cannot undelete — undo copies — and rolling back a deletion
 * leaves everyone who has that cell open typing into a tombstone: keystrokes
 * vanish without an exception, without an error and without a single observer
 * firing. A rule meant to protect the teacher from a student would hand the
 * student a weapon against the teacher. Plus `broadcastDocUpdate`, `record()`
 * and the write to disk hang synchronously inside `applyUpdate` — the rollback
 * would have time to spread across twenty tabs and get written into the
 * history.
 *
 * The module is pure: the test comes here, and there are no sockets and no
 * database here.
 *
 * The cost measure (500 cells, 114 KB): parsing a keystroke — 0.36 µs, the full
 * classification with parent resolution — 1.77 µs, applying the same bytes —
 * 67 µs. Twenty people typing give ~160 frames per second.
 */
import * as Y from 'yjs'
import {
  allCellArrays,
  CELLS_KEY,
  CHAT_KEY,
  isBookRoot,
  isCellOpen,
  META_KEY,
  TERMINAL_KEY,
  type YCell,
} from '@shared/notebook'
import type { GateRule } from '@shared/protocol'
import {
  actsAfterClass,
  allowsStructure,
  bookRefusal,
  CLASS_IS_OVER,
  mayEditCell,
  rulesForBook,
  type Asker,
  type RoomRules,
} from '@shared/rules'

/*
 * What a frame does — in terms of the room's rules, not of bytes.
 *
 * The enumeration is one for both sides and lives in the protocol: the gate
 * judges by it, and the `refused` frame that goes to the browser names it.
 * There were two copies, and they managed to drift apart — the protocol had a
 * `'files'` value that never existed here and that the server never sent.
 */
export type { GateRule }

export interface Verdict {
  rule: GateRule
  /** Only for `structure`: what exactly happens to the notebook's cell list. */
  verb?: 'add' | 'remove'
  /** The cell, if it could be named — for the message to a person. */
  cellId: string | null
  /** The resolved path, for the message and for the test. */
  path: string
  /**
   * The root of the notebook the frame targets — the name of its Y.Array in
   * the document.
   *
   * By it, and only by it, the access of an individual notebook is found
   * (shared/rules.ts · RoomRules.books): a root is issued to a notebook once
   * and survives a rename of the file, while a path gets freed.
   *
   * `null` for verdicts that are not about a notebook's cells — currently that
   * is only `title`. A map key "null" matches nothing, so such a verdict is
   * judged by the room's rules, as it always was.
   */
  root: string | null
  /**
   * The teacher opened the cell — and only for an edit of its TEXT.
   *
   * Verdicts about the notebook's cell list and about a change of type do not
   * carry this flag on purpose: an open cell gives the room typing, not the
   * right to remove the cell or turn it into a note (shared/rules.ts ·
   * mayEditCell). The flag is read from the document, not from the frame:
   * `open` is written by the server, and what the browser thinks about this
   * cell gives no rights.
   */
  open?: boolean
}

export type Judgement =
  | {
      ok: true
      verdicts: Verdict[]
      /**
       * Cells whose `type` the frame changes.
       *
       * The client now writes only the type itself; resetting the execution
       * state (`state`, `execCount`, `startedAt`, `ranMs`, `outputs`) is done
       * by the server right after applying — the only place where the client
       * wrote server fields has ceased to exist.
       */
      retyped: string[]
      /**
       * Cells the frame creates.
       *
       * The server brings them into agreement with itself right after
       * applying: it erases someone else's output, and brings back its own —
       * if this is an undone deletion — from its own record. A cell whose
       * name is already taken by a live one does not get in here: the
       * settling searches by name and would reach not it but the one already
       * in the notebook. The arrived copy is removed by the duplicate watcher.
       */
      created: string[]
      /**
       * Cells the frame deletes.
       *
       * The server remembers them BEFORE applying: after applying there is
       * nothing left to read, and without this Ctrl+Z would bring a cell back
       * without output. And it tells the kernel about them AFTER applying
       * (`collab/index.ts · onCellsRemoved`): the cell being removed may be
       * the one it is computing right now.
       */
      removed: string[]
    }
  | { ok: false; why: string; path: string }

/**
 * A ceiling per frame, before any classification and the same for everyone.
 *
 * Not a right: the teacher pastes from the clipboard just the same.
 * `MAX_WS_PAYLOAD` is 16 MB, and such a frame is relayed into every socket,
 * goes whole into an SQLite blob and is copied once more into a history
 * keyframe. Without this ceiling the classifier would just carefully take a
 * bomb apart.
 */
export const MAX_SYNC_FRAME_BYTES = 256 * 1024

/**
 * A ceiling for a FIRST-sync frame — separate and higher.
 *
 * Step2 is not an edit but the difference between a tab and the server, and it
 * includes the document's WHOLE delete set: every word erased over the room's
 * life, forever. For a room that has lived a semester it alone takes hundreds
 * of kilobytes with zero new structures — and the edit ceiling would refuse it
 * on every reconnection, that is, forever. Eight megabytes is half of
 * `MAX_WS_PAYLOAD`; the parsing cost is bounded not by bytes but by the walk
 * budget below (`MAX_WALK`).
 */
export const MAX_SYNC_STEP2_BYTES = 8 * 1024 * 1024

/**
 * How many steps the classifier agrees to take in one frame — on top of what
 * it is bound to take for a document of this size anyway.
 *
 * A reserve against a degenerate delete set: a range a billion long costs a few
 * bytes on the wire. A real deletion, even "select all in a big cell", does not
 * give even a thousand. Hitting the ceiling is a refusal, not a pass.
 *
 * The ceiling cannot be constant, and that was measured on 23 Sep 2026 on the
 * live room zxrrsac6 (35 thousand structures, a 750 KB snapshot): the step2 of
 * a fully synced tab cost 55 thousand steps — the delete set is walked by
 * structure, and it grows with every class — and a tab that offered the whole
 * document anew hit a hundred thousand and got "frame too large" on every
 * entry. The walk is bounded by the number of structures anyway: a delete-set
 * step jumps over a whole structure, on the server or in the frame. So
 * `WALK_PER_STRUCT` per structure of the document and the frame is added to
 * the reserve.
 */
const MAX_WALK = 100_000

/**
 * Steps per structure: constructor, contiguity, verdict, lookup in the frame,
 * path to the root. On that room it came out at less than two — a fourfold
 * margin.
 */
const WALK_PER_STRUCT = 8

/** The number of structures in the document store — without walking the structures. */
function storeSize(doc: Y.Doc): number {
  let n = 0
  for (const structs of doc.store.clients.values()) n += structs.length
  return n
}

/** Cell keys that only the server writes. They are always closed to the client. */
const SERVER_OWNED = new Set([
  'outputs',
  'state',
  'execCount',
  'runBy',
  'runById',
  'startedAt',
  'ranMs',
  'stdin',
  /*
   * The lecture lock — and it is server-owned all the more because it is not a
   * reading but a right: a cell that opened itself is a participant who let
   * themselves type in a closed notebook. The teacher opens it with a control
   * message (control.ts), that is, through the channel where the role is
   * asked, not through a frame, where the role plays no part.
   *
   * The third position of the same lock — the council — lives in the same key,
   * and the gate does not see it on purpose: `isCellOpen` answers strictly to
   * `true`, so for typing a council cell is a closed cell. A student sends
   * their own sheet not as a frame but as a snapshot over the control socket
   * (control.ts · council:draft).
   */
  'open',
  /*
   * The council's knobs — "runs for students" and "names on the projector".
   * The first is a right, not a reading: a cell that switched runs on for
   * itself is a class that let itself into the kernel queue. They are written
   * by the same control channel (control.ts · cell:lock).
   */
  'council',
])

/**
 * What a freshly created cell carries. Nothing beyond — otherwise a refusal.
 *
 * `stdin` and `open` are absent here on purpose, and both for one reason: they
 * are not contents but a claim of rights — a forged invitation to enter a
 * password and a removed lock. A cell that brought such a thing with it is
 * rejected together with the frame.
 *
 * The price for `open` is the same as for `stdin`, and it is paid knowingly:
 * undoing the deletion of an OPEN cell arrives as a copy with this field and is
 * refused, and a refusal costs the tab a reload. There are only a handful of
 * open cells in a notebook, only the teacher deletes them — and a lock that can
 * be brought in a frame is no lock at all.
 */
const FRESH_KEYS = new Set([
  'id',
  'type',
  'source',
  'outputs',
  'state',
  'execCount',
  'runBy',
  'runById',
  'startedAt',
  'ranMs',
  /*
   * And the lock — but not because the browser is allowed to set it.
   *
   * A refusal here would cost more than the hole: Ctrl+Z after deleting an
   * OPEN cell arrives as its copy together with the field, that is, a teacher
   * who undid their own deletion would get a refusal and a tab reload. So the
   * frame is accepted, and the server removes the lock — `settleFresh` brings a
   * new cell to closed, just as it brings its output and state to clean. The
   * returned cell is closed, and opening it again is one click.
   */
  'open',
  // The knobs travel with the lock and are removed along with it, in settleFresh.
  'council',
])

class Refusal extends Error {
  constructor(
    readonly why: string,
    readonly path: string,
  ) {
    super(`${why} (${path})`)
  }
}

/**
 * A delete set as `decodeUpdate` returns it.
 *
 * The type is not exported from yjs; it is described here exactly in the part
 * the classifier reads — a list of ranges per client.
 */
interface DeleteSet {
  clients: Map<number, { clock: number; len: number }[]>
}

/** Any structure from a frame: Item, GC or Skip — Yjs does not narrow this type. */
type Struct = Y.Item | { id: Y.ID; length: number }

/** What a reference resolved to: a tombstone, a fresh structure or a live item. */
type Target =
  | { kind: 'gc'; struct: Y.GC }
  | { kind: 'fresh'; struct: Y.Item }
  | { kind: 'item'; item: Y.Item }

/** A place: the container the thing lies in, and the key if the container is a Y.Map. */
interface Place {
  container: string[]
  sub: string | null
  /** The structure occupying the `cells/[]` spot on this path, if it leads there. */
  cell: Target | null
  /** Whether this cell is being created in this very frame. */
  cellIsFresh: boolean
}

function isItem(struct: Struct): struct is Y.Item {
  return struct instanceof Y.Item
}

function segment(sub: string | null): string {
  return sub === null ? '[]' : `::${sub}`
}

/**
 * One parse of one frame.
 *
 * A class, not a set of functions, for the memo of resolved paths: deleting a
 * cell that has been run touches sixteen items, and resolving their parents one
 * by one would mean walking the tree to the root sixteen times.
 */
class Frame {
  private readonly byClient = new Map<number, Y.Item[]>()
  private readonly placeMemo = new Map<Y.Item, Place>()
  private walked = 0
  private readonly budget: number

  constructor(
    private readonly doc: Y.Doc,
    private readonly dec: { structs: Struct[]; ds: DeleteSet },
  ) {
    this.budget = MAX_WALK + WALK_PER_STRUCT * (storeSize(doc) + dec.structs.length)
    // Logical ranges can encode many clocks in a handful of bytes. Charge
    // constructor work before indexing and retain intervals, never each clock.
    for (const struct of this.dec.structs) {
      this.step('')
      if (!Number.isSafeInteger(struct.length) || struct.length < 1 ||
          !Number.isSafeInteger(struct.id.clock + struct.length)) {
        throw new Refusal(tr("server.theFrameCannotBeRead.c96480"), '')
      }
      if (!isItem(struct)) continue
      const list = this.byClient.get(struct.id.client)
      if (list) list.push(struct)
      else this.byClient.set(struct.id.client, [struct])
    }
    for (const list of this.byClient.values()) list.sort((a, b) => a.id.clock - b.id.clock)
  }

  private freshAt(id: Y.ID, path: string): Y.Item | undefined {
    const list = this.byClient.get(id.client)
    if (!list) return undefined
    let lo = 0
    let hi = list.length - 1
    while (lo <= hi) {
      this.step(path)
      const mid = (lo + hi) >>> 1
      const item = list[mid]
      if (id.clock < item.id.clock) hi = mid - 1
      else if (id.clock >= item.id.clock + item.length) lo = mid + 1
      else return item
    }
    return undefined
  }

  private step(path: string): void {
    this.walked += 1
    if (this.walked > this.budget) throw new Refusal(tr("server.theFrameIsTooLargeToRead.4cb416"), path)
  }

  /**
   * Resolving a reference — and the whole security of the gate rests on it.
   *
   * A clock above what the server has seen means: the server does not have
   * this content. If it is in this same frame, we resolve through the frame. If
   * not — a refusal, and never "let it through, sort it out later".
   *
   * Letting it through is impossible, and that was measured, not deduced: a
   * frame of zero structures with one delete range starting at the host's
   * current clock is put by Yjs into `store.pendingDs` and re-applied inside
   * every following `applyUpdate`. The host types " world" — their screen says
   * "hello world", the server "hello", and every following keystroke is
   * deleted on arrival. Silently. Forever.
   *
   * A tombstone is not that case, and the clock tells them apart mechanically.
   * When one tab deleted a cell another is typing in, the other's structure
   * resolves through its origin at clock 8 with state 16: the clock is lower,
   * `getItem` returns GC, and the frame passes. A write into a tombstone
   * changes nothing anyone will see.
   *
   * `getItem` throws on a client the store has never heard of — so the state
   * check comes first, not in a `catch` afterwards.
   */
  private resolve(id: Y.ID, path: string): Target {
    this.step(path)
    if (id.clock >= Y.getState(this.doc.store, id.client)) {
      const fresh = this.freshAt(id, path)
      if (!fresh) throw new Refusal(tr("server.referenceToContentThatIsNotIn.692803"), path)
      return { kind: 'fresh', struct: fresh }
    }
    // `getItem`'s type lies: in place of collected garbage it returns GC.
    const found = Y.getItem(this.doc.store, id) as Y.Item | Y.GC
    if (!(found instanceof Y.Item)) return { kind: 'gc', struct: found }
    return { kind: 'item', item: found }
  }

  /**
   * The path of the root type — and along the way the cell we ended up in.
   *
   * The cell is needed for the message to a person: "the edit in cell N was not
   * accepted" reads, while "the edit at path cells/[]/::source/[]" does not.
   */
  private pathOfType(type: Y.AbstractType<unknown>): {
    segs: string[]
    cell: Y.Item | null
  } {
    const segs: string[] = []
    let cell: Y.Item | null = null
    let current: Y.AbstractType<unknown> = type
    for (;;) {
      this.step(segs.join('/'))
      const item = current._item
      if (item === null) {
        // `findRootTypeKey` throws on a detached type — it must be reached alive.
        if (!current.doc) throw new Refusal(tr("server.writeToATypeOutsideTheDocument.85d447"), segs.join('/'))
        segs.unshift(Y.findRootTypeKey(current))
        return { segs, cell }
      }
      segs.unshift(segment(item.parentSub))
      const parent = item.parent
      if (!(parent instanceof Y.AbstractType)) {
        throw new Refusal(tr("server.theParentCannotBeResolved.65a644"), segs.join('/'))
      }
      // An item lying right in the cells root is the cell.
      if (item.parentSub === null && parent._item === null && parent.doc) {
        if (isBookRoot(Y.findRootTypeKey(parent))) cell = item
      }
      current = parent
    }
  }

  /**
   * The place of a thing: where it lies and under which key.
   *
   * The parent comes in three forms, and all three occur on the wire: as a
   * string (the root's name is written into the bytes literally), as an id (the
   * item the type lives in) and as `null`.
   *
   * `null` is neither rare nor a breakage: Yjs writes the parent only when the
   * item has neither a left nor a right neighbour. `meta.set('title')` over an
   * existing title has a neighbour — and there is NO `parentSub` on the wire.
   * In that case the key is taken from the neighbour; a version that trusts
   * `struct.parentSub` will be wrong silently and will not show it in tests:
   * `set('title')` and `set('kernelStatus')` give byte-for-byte identical
   * structures.
   */
  private place(target: Target, path: string): Place {
    if (target.kind === 'gc')
      return { container: ['<gc>'], sub: null, cell: null, cellIsFresh: false }

    if (target.kind === 'item') {
      const item = target.item
      const memo = this.placeMemo.get(item)
      if (memo) return memo
      const parent = item.parent
      if (!(parent instanceof Y.AbstractType)) {
        throw new Refusal(tr("server.theParentCannotBeResolved.65a644"), path)
      }
      const { segs: container, cell } = this.pathOfType(parent)
      const here: Place = {
        container,
        sub: item.parentSub,
        cell: cell ? { kind: 'item', item: cell } : null,
        cellIsFresh: false,
      }
      if (container.length === 1 && isBookRoot(container[0]) && item.parentSub === null) {
        here.cell = target
      }
      this.placeMemo.set(item, here)
      return here
    }

    const struct = target.struct
    const memo = this.placeMemo.get(struct)
    if (memo) return memo
    this.step(path)

    let here: Place
    const parent = struct.parent
    if (typeof parent === 'string') {
      here = {
        container: [parent],
        sub: struct.parentSub,
        cell: null,
        cellIsFresh: false,
      }
    } else if (parent instanceof Y.ID) {
      const owner = this.resolve(parent, path)
      here = {
        container: this.slot(owner, path),
        sub: struct.parentSub,
        cell: this.place(owner, path).cell,
        cellIsFresh: this.place(owner, path).cellIsFresh,
      }
    } else {
      // No parent on the wire — take it from the neighbour, together with the key.
      const neighbourId = struct.origin ?? struct.rightOrigin
      if (!neighbourId) throw new Refusal(tr("server.structureHasNeitherAParentNorA.62175e"), path)
      const neighbour = this.resolve(neighbourId, path)
      const beside = this.place(neighbour, path)
      here = {
        container: beside.container,
        sub: beside.sub,
        cell: beside.cell,
        cellIsFresh: beside.cellIsFresh,
      }
    }

    if (here.container.length === 1 && isBookRoot(here.container[0]) && here.sub === null) {
      here.cell = target
      here.cellIsFresh = true
    }
    this.placeMemo.set(struct, here)
    return here
  }

  /** The full path of the thing itself: the container's place plus its own segment. */
  private slot(target: Target, path: string): string[] {
    if (target.kind === 'gc') return ['<gc>']
    const here = this.place(target, path)
    return [...here.container, segment(here.sub)]
  }

  /**
   * The cell we ended up in — if it already lives in the document.
   *
   * `null` for a fresh one: its values are not applied yet, and they are read
   * from the frame (`checkFresh`), not from here.
   */
  private cellMapOf(place: Place): YCell | null {
    const cell = place.cell
    if (!cell || cell.kind !== 'item') return null
    const content = cell.item.content
    if (!(content instanceof Y.ContentType)) return null
    const map = content.type
    return map instanceof Y.Map ? (map as YCell) : null
  }

  /** The cell's name, if it can be read: only for the message to a person. */
  private cellIdOf(place: Place): string | null {
    const id: unknown = this.cellMapOf(place)?.get('id')
    return typeof id === 'string' ? id : null
  }

  /**
   * Whether the teacher opened this cell.
   *
   * From the DOCUMENT, and only from there: `open` is written by the server, so
   * reading it from the frame would mean asking permission of the one being
   * checked. A fresh cell is never open — the field does not get into it at
   * all, see FRESH_KEYS.
   */
  private openOf(place: Place): boolean {
    const map = this.cellMapOf(place)
    return map ? isCellOpen(map) : false
  }

  /** The rule for a resolved path. `null` means a verb that concerns nobody. */
  private verdictFor(slot: string[], place: Place, op: 'insert' | 'delete'): Verdict | null {
    const path = slot.join('/')
    if (slot[0] === '<gc>') return null

    if (isBookRoot(slot[0])) {
      const cellId = this.cellIdOf(place)
      // The root is also the notebook's name in the document: its own access
      // is judged by it (shared/rules.ts · rulesForBook). It is taken from the
      // same place as the path, because the path starts with it.
      const root = slot[0]
      // The notebook's cell list itself.
      if (slot.length === 2 && slot[1] === '[]') {
        return {
          rule: 'structure',
          verb: op === 'insert' ? 'add' : 'remove',
          cellId,
          path,
          root,
        }
      }
      if (slot.length < 3) throw new Refusal(tr("server.writeToAnUnknownNotebookLocation.6e676f"), path)

      const key = slot[2].startsWith('::') ? slot[2].slice(2) : null
      if (key === null) throw new Refusal(tr("server.writeToAnUnknownNotebookLocation.6e676f"), path)

      // A cell created by this same frame is part of the creation as a whole;
      // its values are checked separately, in checkFresh.
      if (place.cellIsFresh) return { rule: 'structure', verb: 'add', cellId, path, root }

      if (SERVER_OWNED.has(key)) {
        /*
         * The lock has its own phrase: "this field is written by the server"
         * explains nothing to someone trying to open a cell for themselves —
         * and that is exactly what such a frame looks like.
         */
        throw new Refusal(
          key === 'open' || key === 'council'
            ? tr("server.onlyTheTeacherMayOpenACell.408fc1")
            : tr("server.thisFieldIsWrittenByTheServer.ea61b2"),
          path,
        )
      }
      if (key === 'id') throw new Refusal(tr("server.theCellIdentifierCannotBeChanged.ed6a4a"), path)
      if (key === 'source') {
        // Inside the text is an edit; replacing the key itself is not: it
        // tears down the Y.Text in which other people's cursors sit at that
        // moment.
        if (slot.length === 3) throw new Refusal(tr("server.theEntireCellTextIsBeingReplaced.ef575f"), path)
        // The only place where the lock allows anything: typing in an open
        // cell goes on while the notebook is closed — see shared/rules.ts ·
        // mayEditCell.
        return { rule: 'edit', cellId, path, root, open: this.openOf(place) }
      }
      if (key === 'type') {
        if (slot.length !== 3) throw new Refusal(tr("server.writeToAnUnknownNotebookLocation.6e676f"), path)
        // No `open`: changing the type means rewriting the cell whole together
        // with its output, that is, the notebook's cell list, and in a lecture
        // that belongs to the teacher.
        return { rule: 'edit', cellId, path, root }
      }
      throw new Refusal(tr("server.unknownCellField.5417fd"), path)
    }

    if (slot[0] === META_KEY) {
      if (slot.length === 2 && slot[1] === '::title') {
        return { rule: 'title', cellId: null, path, root: null }
      }
      throw new Refusal(tr("server.thisSeminarFieldIsWrittenByThe.4b1639"), path)
    }

    if (slot[0] === CHAT_KEY || slot[0] === TERMINAL_KEY) {
      throw new Refusal(tr("server.thisThreadIsWrittenByTheServer.a453d6"), path)
    }

    throw new Refusal(tr("server.writeToASectionThatDoesNot.901f9e"), path)
  }

  /**
   * The values of a new cell, not only the path.
   *
   * Otherwise the permission "create cells" would open a hole: a fresh cell
   * with a forged `stdin` draws the teacher an invitation to enter a password
   * and puts the keystrokes into someone else's variable. A field not in
   * `FRESH_KEYS` is a refusal; everything a cell may bring but may not declare
   * about itself (output, "In [7]") the server clears after applying, not by a
   * refusal: see below, where this is taken apart in full.
   */
  private checkFresh(fresh: Map<Y.Item, Map<string, Y.Item>>): string[] {
    const namesHere = new Set<string>()
    const created: string[] = []
    for (const keys of fresh.values()) {
      const path = `${CELLS_KEY}/[]`
      for (const key of keys.keys()) {
        if (!FRESH_KEYS.has(key)) throw new Refusal(tr("server.theNewCellContainsAnUnexpectedField.0d2454", { p0: key }), path)
      }
      const id = valueOf(keys.get('id'))
      if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
        throw new Refusal(tr("server.theNewCellHasNoIdentifier.6dfd8e"), path)
      }
      /*
       * The name must be new. A matching name is not a typo but a takeover:
       * the teacher's "Run" finds a cell by name and would execute someone
       * else's source.
       */
      if (namesHere.has(id)) throw new Refusal(tr("server.twoNewCellsShareTheSameIdentifier.844381"), path)
      namesHere.add(id)
      /*
       * In ALL of the room's notebooks, not in one: a cell is found by name
       * without knowing which notebook it is in (see `findCell`), and matching
       * names in two different notebooks would mean that "Run" sometimes runs
       * the wrong one.
       *
       * But a match is not a refusal, see below.
       */
      const taken = allCellArrays(this.doc).some((cells) =>
        cells.toArray().some((c) => c instanceof Y.Map && c.get('id') === id),
      )

      const type = valueOf(keys.get('type'))
      if (type !== 'code' && type !== 'markdown') throw new Refusal(tr("server.theNewCellHasNoType.fd1999"), path)

      if (!isType(keys.get('source'), Y.Text))
        throw new Refusal(tr("server.theNewCellSTextIsNot.21d144"), path)
      if (!isType(keys.get('outputs'), Y.Array))
        throw new Refusal(tr("server.theNewCellSOutputIsNot.2d985e"), path)

      /*
       * Neither ready output, nor "In [7]", nor a taken name is judged by a
       * refusal, and this is one decision with two halves.
       *
       * Both are Ctrl+Z. Yjs undoes a deletion with a COPY, so undoing the
       * deletion of a cell that has been run arrives as a new cell with ready
       * output; and if someone managed to bring the same cell back from the
       * history (a restore recreates it with the PREVIOUS name), also with a
       * taken name. This used to be judged by the server's memory of
       * deletions — ten minutes and thirty items — and beyond those limits an
       * ordinary gesture cost a person a closed socket, an erased cache and a
       * page reload in the middle of a class: exactly what the memory was
       * meant to prevent.
       *
       * There is no need to tell them apart: `ops.ts · settleFresh` brings
       * EVERY new cell to clean anyway and brings output back from the
       * SERVER's record, not from the frame — the floor holds without a
       * refusal. And a taken name is sorted out by the duplicate watcher
       * (collab/index.ts): it removes exactly the arrived copy, so swapping
       * someone else's cell for your own by name is still impossible.
       *
       * A taken name does not go into `created`: `settleFresh` searches by
       * name and would bring to clean the cell that already lives in the
       * notebook — that is, erase someone else's output for the room over one
       * coincidence.
       */
      if (!taken) created.push(id)
    }
    return created
  }

  /** Parse the whole frame. Throws `Refusal` — the frame is not applied at all. */
  judge(): {
    verdicts: Verdict[]
    retyped: string[]
    created: string[]
    removed: string[]
  } {
    const verdicts: Verdict[] = []
    const seen = new Set<string>()
    const retyped: string[] = []
    /** Fresh cells: the map of keys the frame puts into them. */
    const fresh = new Map<Y.Item, Map<string, Y.Item>>()

    const keep = (verdict: Verdict | null): void => {
      if (!verdict) return
      const key = `${verdict.rule}:${verdict.verb ?? ''}:${verdict.path}:${verdict.cellId ?? ''}`
      if (seen.has(key)) return
      seen.add(key)
      verdicts.push(verdict)
    }

    this.checkContiguity()

    for (const struct of this.dec.structs) {
      if (!isItem(struct)) continue
      /*
       * Novelty is not an optimization but what lets the gate survive an
       * ordinary page reload. `y-indexeddb` replays the local cache on every
       * open, and `y-websocket` forwards everything that is not itself — that
       * is, every browser offers the server its whole document anew, along
       * with `terminal`, `chat` and outputs. Without this check such a frame
       * would be refused in any room, under any rules, and the prescribed
       * rebuild would erase the student's cache.
       */
      if (struct.id.clock + struct.length <= Y.getState(this.doc.store, struct.id.client)) continue

      const target: Target = { kind: 'fresh', struct }
      const place = this.place(target, CELLS_KEY)
      const slot = this.slot(target, CELLS_KEY)
      const verdict = this.verdictFor(slot, place, 'insert')
      keep(verdict)

      if (place.cellIsFresh && place.cell?.kind === 'fresh') {
        const cell = place.cell.struct
        const keys = fresh.get(cell) ?? new Map<string, Y.Item>()
        fresh.set(cell, keys)
        // A cell's keys lie at depth 3; deeper is already content.
        if (slot.length === 3 && slot[2].startsWith('::')) keys.set(slot[2].slice(2), struct)
        else if (slot.length > 3 && slot[2] !== '::source') {
          // Ready output does not stay on a new cell in the document: the
          // server brings every new cell to clean right after applying
          // (ops.ts · settleFresh). All other content is a refusal.
          if (slot[2] !== '::outputs') {
            throw new Refusal(tr("server.theNewCellContainsPresetContent.c75536"), slot.join('/'))
          }
        }
      } else if (verdict?.rule === 'edit' && slot.length === 3 && slot[2] === '::type') {
        const value = valueOf(struct)
        if (value !== 'code' && value !== 'markdown') {
          throw new Refusal(tr("server.unknownCellType.df318b"), slot.join('/'))
        }
        if (verdict.cellId) retyped.push(verdict.cellId)
      }
    }

    const created = this.checkFresh(fresh)

    for (const [client, ranges] of this.dec.ds.clients) {
      for (const range of ranges) {
        let clock = range.clock
        const end = range.clock + range.len
        while (clock < end) {
          this.step(`${CELLS_KEY}#${client}`)
          const target = this.resolve(Y.createID(client, clock), `${CELLS_KEY}#${client}`)
          const struct = target.kind === 'item' ? target.item : target.struct
          const step = Math.max(1, struct.id.clock + struct.length - clock)
          clock += step
          /*
           * A tombstone as a whole, not clock by clock. It used to be
           * `clock += 1`, and this was measured on a live room: nine
           * cleaned-out oracle feeds gave 122 thousand clocks of collected
           * garbage, the walk hit MAX_WALK, and every reconnection of every
           * tab was refused with "frame too large" — forever, because the
           * delete set does not shrink. Now the same set costs about six
           * thousand steps.
           */
          if (target.kind === 'gc') continue
          // Already deleted changes nothing — the same IndexedDB cache again.
          if (target.kind === 'item' && target.item.deleted) continue
          keep(this.verdictFor(...this.outermost(target)))
        }
      }
    }

    const removed = verdicts
      .filter((v) => v.rule === 'structure' && v.verb === 'remove' && v.cellId)
      .map((v) => v.cellId as string)
    return { verdicts, retyped, created, removed }
  }

  /**
   * One client's keystrokes come in a row, and a frame must continue exactly
   * from the clock at which the server saw that client.
   *
   * Otherwise Yjs accepts a structure with a gap before it and puts it into
   * `pendingStructs` — forever, because the missing clock will not come: the
   * gate refused that frame. What was refused does not disappear: the stuck
   * part goes into the snapshot, into every step2 to the server and back to
   * every tab, and the gate judges it anew on every reconnection. In a closed
   * room that is a refusal to every student on every entry. Measured on a live
   * room: 140 KB of stuck keystrokes in the snapshot after one morning.
   *
   * And the second half of the same hole is bypassing the rules: the gate would
   * judge a structure with a gap, but it cannot be applied, so it would wait in
   * pending and get into the document together with the missing clock —
   * already without judgement. So a gap is a refusal, not a pass. `Skip` is the
   * same gap, written explicitly.
   */
  private checkContiguity(): void {
    const byClient = new Map<number, Struct[]>()
    for (const struct of this.dec.structs) {
      if (struct instanceof Y.Skip) {
        throw new Refusal(tr("server.theFrameHasAGapInEdits.6c7e40"), `${CELLS_KEY}#${struct.id.client}`)
      }
      const list = byClient.get(struct.id.client)
      if (list) list.push(struct)
      else byClient.set(struct.id.client, [struct])
    }
    for (const [client, structs] of byClient) {
      structs.sort((a, b) => a.id.clock - b.id.clock)
      let expected = Y.getState(this.doc.store, client)
      for (const struct of structs) {
        this.step(`${CELLS_KEY}#${client}`)
        const end = struct.id.clock + struct.length
        // Already known — the same IndexedDB cache as in the structure parse.
        if (end <= expected) continue
        if (struct.id.clock > expected) {
          throw new Refusal(
            tr("server.theFrameContinuesEditsThatTheServer.1709af"),
            `${CELLS_KEY}#${client}`,
          )
        }
        expected = end
      }
    }
  }

  /**
   * The outermost ancestor deleted by this same frame — and the verdict is
   * passed on it.
   *
   * The rule "take the outer item of the range" is wrong here, and that was
   * measured: deleting one cell that has ever been run gives ranges under TWO
   * clients — besides the browser, the server that wrote `outputs` and `state`
   * has its own clock. Inside the server's range the outer item is an output
   * record, which the floor declares server-owned, so under that rule any
   * legitimate deletion of a cell that has been run would be refused in any
   * room under permissive defaults.
   *
   * By nesting, deleting a cell with output folds from sixteen paths into
   * exactly one verdict — "a deletion whose parent is the cells root" — and
   * fifteen absorbed ones.
   */
  private outermost(target: Target): [string[], Place, 'delete'] {
    let best = target
    let current = target
    for (;;) {
      this.step('')
      const owner = this.ownerOf(current)
      if (!owner) break
      if (owner.kind === 'gc') break
      const id = owner.kind === 'item' ? owner.item.id : owner.struct.id
      if (!Y.isDeleted(this.dec.ds, id)) break
      best = owner
      current = owner
    }
    return [this.slot(best, ''), this.place(best, ''), 'delete']
  }

  /** The item holding this thing's container — one level up. */
  private ownerOf(target: Target): Target | null {
    if (target.kind === 'gc') return null
    if (target.kind === 'item') {
      const parent = target.item.parent
      if (!(parent instanceof Y.AbstractType)) return null
      return parent._item ? { kind: 'item', item: parent._item } : null
    }
    const parent = target.struct.parent
    if (typeof parent === 'string') return null
    if (parent instanceof Y.ID) return this.resolve(parent, '')
    const neighbourId = target.struct.origin ?? target.struct.rightOrigin
    if (!neighbourId) return null
    return this.ownerOf(this.resolve(neighbourId, ''))
  }
}

/** The value of a simple Y.Map key from a frame structure. */
function valueOf(struct: Y.Item | undefined): unknown {
  if (!struct) return undefined
  const content = struct.content
  if (content instanceof Y.ContentAny) return content.arr[0]
  if (content instanceof Y.ContentString) return content.str
  if (content instanceof Y.ContentType) return content.type
  return undefined
}

function isType(struct: Y.Item | undefined, kind: unknown): boolean {
  if (!struct) return false
  const content = struct.content
  return content instanceof Y.ContentType && content.type instanceof (kind as never)
}

/**
 * Parse a frame. Applies nothing and does not touch the document.
 */
export function classify(
  doc: Y.Doc,
  payload: Uint8Array,
  maxBytes: number = MAX_SYNC_FRAME_BYTES,
): Judgement {
  if (payload.byteLength > maxBytes) {
    return { ok: false, why: tr("server.frameTooLarge.5693f1"), path: '' }
  }
  try {
    const dec = Y.decodeUpdate(payload) as unknown as {
      structs: Struct[]
      ds: DeleteSet
    }
    const { verdicts, retyped, created, removed } = new Frame(doc, dec).judge()
    return { ok: true, verdicts, retyped, created, removed }
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, why: err.why, path: err.path }
    // A parse that fell apart is a refusal, not a pass: letting through what
    // could not be read means executing it after the check stopped looking.
    return { ok: false, why: tr("server.theFrameCannotBeRead.c96480"), path: '' }
  }
}

/**
 * Whether the room's rules allow what the frame does.
 *
 * Separate from parsing on purpose: parsing says WHAT is in the frame and knows
 * neither the room nor the role; the rules say who may do it. The test of
 * parsing does not depend on the rules, and vice versa.
 *
 * @param finished — whether the class is over. It affects two things.
 *
 * The words — and that used to be its only job: the rules arrive here as
 * effective ones (`db.ts · getRules`), that is, after the end of the class as
 * the teacher's, and a participant will be refused without any extra check.
 * But by the rules alone "the teacher closed the notebook" and "the class is
 * over" are indistinguishable, and the person needs to be told the second —
 * otherwise they will go looking for a teacher who changed nothing.
 *
 * And the lock: an open cell is a right ON TOP of the rules, it is not in the
 * rules at all, and only this flag closes it (`mayEditCell`). The default is
 * left for calls where the class is known to be going on; whoever judges real
 * frames must pass it — otherwise an open cell will outlive the end of the
 * class.
 */
/**
 * @param participantId — who sent the frame. Needed for exactly one question:
 * whether this is their personal notebook (shared/rules.ts · BookRule.owner).
 * `null` means "a frame without a name", and such a sender is certainly not the
 * author: an error here falls on the side of refusal, not on the side of
 * someone else's personal notebook.
 */
export function permits(
  verdicts: Verdict[],
  rules: RoomRules,
  role: 'host' | 'participant',
  finished = false,
  participantId: string | null = null,
): { ok: true } | { ok: false; rule: GateRule; message: string } {
  const acts = actsAfterClass(finished, role)
  const who: Asker = { role, participantId }
  const why = (own: string): string => (acts ? own : tr(CLASS_IS_OVER))
  /*
   * The words of a refusal are chosen by the NOTEBOOK when it refused, and by
   * the room in all other cases.
   *
   * Otherwise a student who poked into someone else's personal notebook would
   * read "the teacher types in this seminar" — and would go to a teacher who
   * forbade nothing: it was not the teacher who closed the notebook but its
   * author, with one click.
   *
   * After the bell all of this is silent: `why` replaces any phrase of its own
   * with CLASS_IS_OVER, because what matters to the person is not which rule
   * stopped them but that the class is over.
   */
  const refusal = (verdict: Verdict, own: string): string => {
    const book = bookRefusal(rules, verdict.root, who)
    return why(book ? tr(book.key, { p0: book.name }) : own)
  }
  for (const verdict of verdicts) {
    if (verdict.rule === 'title') {
      if (role === 'host') continue
      return {
        ok: false,
        rule: 'title',
        message: why(tr("server.onlyTheTeacherMayRenameTheSeminar.61046b")),
      }
    }
    /*
     * Each verdict is judged by the rules of ITS OWN notebook, not the room's.
     *
     * Recomputed per verdict, not once per frame: a frame easily carries edits
     * to two notebooks at once — that is how the step2 of a reconnected tab
     * that has both open arrives. `rulesForBook` in an ordinary room returns
     * THE SAME object, so the cost of this is a reference comparison.
     */
    const here = rulesForBook(rules, verdict.root, who)
    if (verdict.rule === 'edit') {
      if (mayEditCell(here, role, verdict.open === true, finished)) continue
      return {
        ok: false,
        rule: 'edit',
        message: refusal(verdict, tr("server.onlyTheTeacherMayEditThisSeminar.dfef31")),
      }
    }
    const verb = verdict.verb ?? 'add'
    if (allowsStructure(here.structure, role, verb)) continue
    return {
      ok: false,
      rule: 'structure',
      message: refusal(
        verdict,
        verb === 'add'
          ? tr("server.onlyTheTeacherMayAddCellsIn.9fb3e4")
          : tr("server.onlyTheTeacherMayRemoveCellsIn.9a1ac0"),
      ),
    }
  }
  return { ok: true }
}
