import type { ReasoningEffort } from './admin.js'
import type { RoomRules } from './rules.js'
import type {Locale} from './i18n-types.js'

/**
 * Wire contracts between browser and server: the control WebSocket, the REST
 * surface, and the AI streaming endpoint.
 *
 * Notebook *content* never travels through here — that is Yjs's job. This
 * channel carries intent ("run this cell") and side-band state (kernel health,
 * file listing) only.
 */
import type {
  CellLock,
  CellOutput,
  CellSnapshot,
  CellState,
  CouncilSettings,
  KernelStatus,
} from './notebook'
export type { CellLock, CouncilSettings } from './notebook'
import type { InkStroke, LectureState } from './lecture'

export type ParticipantRole = 'host' | 'participant'

export interface Participant {
  id: string
  name: string
  avatar: string | null
  color: string
  role: ParticipantRole
}

export interface SessionInfo {
  id: string
  name: string
  createdAt: number
  /**
   * What this room lets people do.
   *
   * Sent to every client so the interface can be honest about itself: a Run
   * button that a student may not press should look unpressable rather than
   * fail when pressed. The server enforces the same rules independently — this
   * copy decides what is drawn, never what is allowed.
   */
  rules: RoomRules
  /**
   * When the teacher finished the class — or null while it is going on.
   *
   * The room does not close or disappear because of it: the notebook, the
   * files, the terminal feed and the oracle's answers stay open for reading,
   * because that is exactly what people come for after class. What closes is
   * actions — everything that changes the room or wakes the kernel is left to
   * the teacher (shared/rules.ts · rulesAfterClass).
   *
   * A time, not a flag: "finished at 15:40" is what the room and the panel
   * show, and a flag would need a second field to say the same thing.
   */
  finishedAt: number | null
  /**
   * This seminar's published page and the course it belongs to.
   *
   * The join screen needs it, and it repairs the only address a student
   * really has. The link in the chat is `/s/`; without this hint a student a
   * week later types their name into a finished class, creates one more
   * participant row, wakes the kernel and ends up alone in a live notebook
   * where nothing says that a published version exists.
   *
   * `slug` — because the hint must lead to THE address that was given to the
   * class: pages live at `/p/<slug>`, and `/p/<id>` is the fallback entrance
   * for those without a name. There is no need to assemble the address by
   * hand; `publicationAddress` in shared/publish.ts is there for that.
   * Optional field: a server that does not send it yet leaves the address by
   * `id` — and that is the truth, not a guess.
   */
  published: { id: string; slug?: string | null; steps: number } | null
  course: { id: string; name: string } | null
  /**
   * The organization that deployed the instance — the line next to the logo.
   *
   * A property of the INSTANCE, not of the seminar: it is one for all rooms at
   * once and changes only by editing `INSTITUTION` in the environment. It
   * lives in the seminar contract precisely because that contract already
   * arrives on every screen where the logo is drawn — the room, the
   * projection, the console and the join screen. A separate request for a
   * single line would cost either an extra round trip to the server on the
   * first frame or a divider popping up under an already drawn word.
   *
   * Empty means there is no line at all; that is the default. The product is
   * deployed by different organizations, and nobody's name is hard-coded
   * here.
   */
  institution: string
}

export interface FileEntry {
  /** The name without folders — what is visible in the tree row. */
  name: string
  /**
   * The path from the root of the seminar folder: `src/model.py`.
   *
   * Next to `name`, not instead of it, and that is a choice in favor of what
   * is already written: for a file in the root `path === name`, so everything
   * that read `name` before folders appeared keeps reading it and sees exactly
   * the same. A file is addressed by `path`; it is shown by `name`.
   */
  path: string
  /** A folder. Its `size` is zero and means nothing. */
  dir: boolean
  size: number
  modifiedAt: number
}

/**
 * A change in the room's tree — instead of the whole tree.
 *
 * The file list used to be broadcast whole on every edit, and all sorts of
 * things edit it: the editor's autosave, `df.to_csv` in a cell,
 * `pip install`. One created file cost a room of five hundred people 3.0 MB
 * (measured) — while one row out of two thousand had changed.
 *
 * The order of the list is a depth-first walk, folders before files, by name:
 * it is uniquely determined by the tree's contents, so the relative order of
 * the surviving entries is the same in the old and the new list. Hence the
 * rule for applying it: first remove `removed`, then replace `changed` by
 * path, then insert `added` in ascending `at` — and the result is exactly the
 * new list.
 *
 * A truncated tree (`truncated`) is not described by a delta: in it "there is
 * no entry" and "the entry did not fit" are different things, and that
 * difference costs a notebook deleted for everyone. There the frame travels
 * whole.
 */
export interface FilesDelta {
  /** Entries that are gone — by path. */
  removed: string[]
  /** Entries whose size, time or kind of entry changed. */
  changed: FileEntry[]
  /** New entries and each one's place in the FINISHED list, in ascending `at`. */
  added: { at: number; entry: FileEntry }[]
}

/* ------------------------------------------------------------------ REST */

export interface CreateSessionRequest {
  name: string
  /**
   * How much memory to give this room's kernel, in megabytes.
   *
   * Staff only, and only within the machine's bounds (512 MB at the bottom,
   * the machine's memory minus a gigabyte at the top): a room that took
   * everything kills not itself but the server under it. Omitted means the
   * environment's default, that is, exactly what rooms lived by before the
   * field appeared.
   */
  memoryMb?: number | null
  /**
   * How many cores to give the room. By the same rule: staff only, from one to
   * all of the machine's cores; omitted means the instance default
   * (`KERNEL_CPUS`).
   */
  cpus?: number | null
}

export interface CreateSessionResponse {
  session: SessionInfo
  /** Signed host credential; the browser keeps it in localStorage. */
  hostToken: string
}

/**
 * The key with which the teacher hands their console over to a tablet.
 *
 * Not a token: it can open neither a socket nor a file download — it can only
 * be exchanged once for an ordinary join, and only while it is alive. The
 * lifetime arrives together with the key, so that the screen can say "the
 * link lives ten minutes" and not lie if the lifetime changes one day.
 */
export interface HandoffResponse {
  key: string
  livesMs: number
  /**
   * The address at which the room is visible from outside — the instance's
   * `PUBLIC_URL`.
   *
   * The console link used to be built from `location.origin`, and a teacher
   * most often opens the room at `http://localhost:3000`: such a link will not
   * open on a tablet at all, even though the seminar is exposed to the
   * outside. The client still picks one of the two addresses (the same rule
   * as in the panel — seminar-link.ts), but there is nowhere else in the room
   * to get the setting from.
   */
  origin: string
}

export interface JoinRequest {
  name: string
  avatar?: string | null
  /** Sent on a repeat visit so the same person keeps their identity. */
  participantId?: string | null
  /**
   * The token minted for that participant, proving the claim above.
   *
   * Every participant id in a room is broadcast to the room — awareness carries
   * it so a caret can be attributed to a face — so "I am p_xyz" is a sentence
   * any student can say about anybody. Only the browser that joined as them has
   * the token, so that is what the claim is checked against.
   */
  token?: string | null
  /** Proves "I created this seminar" across a page refresh. */
  hostToken?: string | null
  /**
   * The mark was picked by hand, not handed out by the screen.
   *
   * The judge of uniqueness is the server: it swaps a taken mark for a free
   * one, otherwise a class that opened the link in the same minute scatters
   * with identical animals (routes/sessions.ts · `markToHand`). It could not
   * tell a handed-out mark from a chosen one by the request body — and swapped
   * both, so a person who tapped the hedgehog got an otter without a single
   * word. This is the only field through which that difference is visible.
   *
   * A hand-picked mark is not swapped: the picker draws taken marks as taken
   * and does not let anyone press them (components/join/MarkPicker.svelte), so
   * one can tap someone else's animal only within a network round trip — and
   * two hedgehogs in a room are cheaper than a screen that pretended not to
   * hear.
   */
  picked?: boolean
}

export interface JoinResponse {
  session: SessionInfo
  participant: Participant
  /** Signed credential for the control socket and AI endpoint. */
  token: string
}

/**
 * A ban: whom the teacher shut out of the room and until when.
 *
 * What the teacher sees in the list — and nothing beyond it. No participant
 * id, no device mark, no address: the ban is checked by those fields, but the
 * list does not need them, and the browser's mark is the only thing in the
 * room about a person that nobody knows, the person included.
 *
 * `until` is the moment of the end, not "how much is left": the clock is drawn
 * by whoever is looking. The server in the container lives in UTC, and a line
 * "until 15:40" built by it would point to the wrong time in a classroom at
 * UTC+3.
 */
export interface Ban {
  id: string
  /** The name the person was banned under: the room may have forgotten it by now. */
  name: string
  until: number
  createdAt: number
  /** Who banned them — or null if it was a host without a staff account. */
  byTeacher: string | null
  /**
   * This is your own device.
   *
   * It is easy to miss: the participant list is names, not faces, and a
   * teacher who banned themselves would otherwise see an ordinary row and not
   * understand why the room stopped letting their second tab in.
   */
  mine: boolean
}

/* -------------------------------------------------------- control socket */

export type ControlClientMessage =
  | { t: 'run'; cellId: string }
  /**
   * Take a cell out of the run queue. Not the same as interrupting: the cell
   * that is *running* is Interrupt's business, and cancelling never reaches it.
   * A student who pressed Run All behind somebody else's forty-second cell
   * otherwise had nothing to press — Interrupt belongs to the person whose cell
   * holds the kernel, and the queue was a one-way door.
   */
  | { t: 'cancel'; cellId: string }
  | { t: 'term:open' }
  | { t: 'term:run'; command: string }
  | { t: 'term:interrupt' }
  | { t: 'term:clear' }
  | { t: 'term:close' }
  /**
   * The whole sheet — and `book` says WHOSE sheet.
   *
   * A room has several notebooks, and "run all" in one of them does not mean
   * "run everything in the room": the kernel is shared, but the sheets are
   * different. No field means the room's notebook, that is, the first one:
   * this is how messages from tabs opened before multiple notebooks existed
   * are read.
   */
  | { t: 'runAll'; book?: string }
  | { t: 'runAbove'; cellId: string; book?: string }
  /**
   * Stop execution.
   *
   * `cellId` is the cell the button was drawn for. The button on the cell
   * itself names it, the room-wide one in the top bar does not, and the
   * difference matters: a press that missed its own cell still stops whatever
   * is computing in this notebook — it has one kernel — but does not take
   * apart someone else's queue: only the batch the named cell belongs to is
   * removed. And a nameless press remains the only way to clear a piled-up
   * queue when nothing is running. The right is checked against the execution
   * environment on the server; the target's name permits nothing.
   */
  | { t: 'interrupt'; cellId?: string; book?: string }
  /**
   * Restart the kernel of ONE notebook — the one named.
   *
   * Each notebook has its own kernel (server/src/kernel/index.ts), so
   * restarting the lecture does not touch the seminar. No field means the
   * room's notebook, by the same rule as `runAll`: this is how frames from
   * tabs opened before there were several kernels are read.
   */
  | { t: 'restart'; book?: string }
  | { t: 'clearOutputs'; cellId?: string; book?: string }
  /**
   * Put every code cell through black. A cell the formatter refuses — a magic,
   * a shell line, a line somebody is still typing — is left exactly as it was,
   * and the rest are still formatted.
   */
  | { t: 'format'; book?: string }
  /**
   * An answer to a cell stopped inside `input()`.
   *
   * The one whose cell is asking answers — or the teacher. The prompt lives in
   * the document because the room must see it; seeing and answering are not
   * the same thing, and a password `input()` all the more so.
   *
   * `cellId` names the cell the form was drawn for. Without it the answer went
   * to whatever the kernel happened to be blocked on at that moment: the cell
   * changed between drawing and pressing Enter — and the typed password went
   * to someone else's cell.
   */
  | { t: 'input'; value: string; cellId?: string }
  /**
   * A decision on an oracle proposal — accept or reject.
   *
   * Through the server, not in one's own document. The "is the proposal still
   * open" check inside a transaction saves from two presses in one tab and
   * does not save from two browsers: each reads `'open'` in its own copy, each
   * writes, and Yjs dutifully merges both edits — the cell gets the patch
   * twice.
   *
   * The server has one copy, and it handles messages in turn: the second sees
   * the state the first set, and does nothing.
   */
  | { t: 'ai:decide'; entryId: string; accept: boolean }
  /**
   * Undo an oracle turn entirely: return the files to what they were before
   * it.
   *
   * Through the server, because it is the files that must be returned, not the
   * document: only the server remembers their earlier text. It goes by the
   * same rule as "do" mode itself — whoever could start it can undo it.
   */
  | { t: 'ai:undo'; entryId: string }
  /**
   * Swap a cell with its neighbor.
   *
   * Through the server, not in one's own document, and that is forced. Y.Array
   * has no move: one of the two cells has to be recreated as a clone, and the
   * clone carries its output. Reordering a notebook is no reason to throw away
   * output, and writing output from a browser is not allowed in any room. The
   * only mixed client transaction in the product, and it goes to the server
   * whole.
   */
  | { t: 'cells:move'; cellId: string; direction: -1 | 1 }
  /**
   * Open a cell to the room — or close it again.
   *
   * A lock on a cell: in a lecture room the teacher types and runs, and an
   * open cell is the one where the hall does so. So the `open` field is
   * written by the server, not the browser: a client write into the CRDT would
   * be a right the server never granted — "I may do this here" would be
   * declared by the very person being asked. The gate closes the cell's server
   * keys to clients precisely for this, and this key is one of them.
   */
  | { t: 'cell:open'; cellId: string; open: boolean }
  /**
   * Put a cell's lock into one of three positions: closed / open to everyone /
   * council.
   *
   * One message for all three positions, and `cell:open` above is its special
   * two-position case, kept for those who already send it: the server reads
   * both the same way (control.ts). Teacher only, and only while the class is
   * going on — by the same arguments as for `cell:open`.
   *
   * `settings` are the council's knobs; they make sense only with
   * `state: 'council'`. Not attached — they stay as they were, and a cell that
   * has not been a council yet gets the defaults (notebook.ts ·
   * DEFAULT_COUNCIL). A repeated `cell:lock` with the same `state` and new
   * `settings` is exactly "flip a knob": there is no separate message for
   * knobs.
   *
   * Lock → not a council: the attempts stay in the database for viewing until
   * the end of class, the student gets `council:mine` with `closed: true`, and
   * their text stays with them as a draft.
   */
  | { t: 'cell:lock'; cellId: string; state: CellLock; settings?: Partial<CouncilSettings> }
  /**
   * Council: the student's own sheet.
   *
   * `council:draft` is a snapshot of the text on a pause in typing (~1 s).
   * Whole, not a delta: an attempt does not live in the CRDT, and for one
   * person on one cell the latest snapshot is enough. The server accepts it
   * from anyone who acts in the room (rules.ts · mayWriteCouncil), only into a
   * cell that is a council right now, and sends it ONLY to the teacher
   * (`council:board`) and to the author themselves (`council:mine`). A
   * snapshot of a submitted attempt does not "unsubmit" it: that is what
   * `council:withdraw` is for — otherwise an autosnapshot after an accidental
   * keypress would silently take off "submitted".
   *
   * `council:submit` is "Submit": it sets submittedAt; `council:withdraw` is
   * "Edit": it clears it, the text stays.
   */
  | { t: 'council:draft'; cellId: string; text: string }
  | { t: 'council:submit'; cellId: string }
  | { t: 'council:withdraw'; cellId: string }
  /**
   * Council: what the host does (rules.ts · mayLeadCouncil — host only).
   *
   * `council:show` is "Show the class": the cell's shared text does NOT
   * change. The shown attempt arrives to the whole room as a separate
   * `council:shown` frame — a signed badge under that same cell — and the cell
   * stays a cell: the teacher's template is in place, and the document history
   * has no edit nobody made. The author also gets `council:mine` with
   * `shown: true`.
   *
   * `council:show:clear` is "take off the screen": it removes the showing from
   * the cell entirely (a `council:shown` frame with `null`). Before, there was
   * nothing to remove it with, because there was nothing to remove: showing
   * was a text substitution, and "rolling it back" meant typing by hand.
   *
   * `council:run` runs an attempt in the kernel of ITS notebook; the output
   * goes to the attempt, not into the shared cell. Without `participantId` it
   * is one's own attempt: this is how a student runs, and it goes through only
   * with `studentRun === true` (rules.ts · mayRunCouncil); a refusal is an
   * `error` in words, with the place in the queue if there is a queue.
   *
   * `council:reply` is an answer to the author or to the whole group of
   * identical solutions: every addressee gets a line in `council:mine.reply`
   * signed by the teacher. An oracle draft (CouncilOracle.drafts) arrives here
   * as already edited text — the model does not speak on these wires.
   *
   * `council:mark` is ✓ Correct / clear the mark:
   * `correct: true | false | null`.
   */
  | { t: 'council:show'; cellId: string; participantId: string }
  | { t: 'council:show:clear'; cellId: string }
  | { t: 'council:run'; cellId: string; participantId?: string }
  /** A request is separate from submission; its ID names a specific saved version. */
  | { t: 'council:run:request'; cellId: string }
  | { t: 'council:run:cancel'; cellId: string; requestId: string }
  | { t: 'council:run:approve'; cellId: string; participantId: string; requestId: string }
  | { t: 'council:run:decline'; cellId: string; participantId: string; requestId: string }
  /**
   * Take SOMEONE ELSE'S waiting run off the queue — without touching the
   * person.
   *
   * Teacher only. Until now someone else's entry in the console queue had one
   * button, and it was "remove from the class": to free the queue from a run
   * that took it by mistake, one had to ban the author. That is exactly the
   * disproportion people asked about: removing a job and removing a person
   * are different things.
   *
   * Works only on a waiting attempt: one that has gone to the kernel cannot be
   * reached from here, it is stopped by "Interrupt". The author is told about
   * it in words — a run that vanished silently reads as a breakage.
   */
  | { t: 'council:run:drop'; cellId: string; participantId: string }
  | {
      t: 'council:reply'
      cellId: string
      to: { participantId: string } | { groupKey: string }
      text: string
    }
  | { t: 'council:mark'; cellId: string; participantId: string; correct: boolean | null }
  /**
   * "Ask the oracle" on ONE'S OWN failed attempt — and nobody else's.
   *
   * Over the socket, not `POST /ai/ask`, because the shared thread is read by
   * the whole room, while council texts are private: the question "why does
   * mine fail" together with the attempt's code would go where forty
   * neighbors would read it. The answer arrives as a letter in the attempt
   * itself (`CouncilReply.to === 'oracle'`) and is visible to two people — the
   * author and the teacher, like everything else on their sheet.
   *
   * The frame does not name the author: a hint is asked only for oneself, and
   * participantId is taken from the token — otherwise it would be a door to
   * someone else's code.
   */
  | { t: 'council:hint'; cellId: string }
  /**
   * Council: send this attempt whole — with its output.
   *
   * The teacher's console asks when a card is expanded and the output did not
   * come with the stack (`CouncilRun.outputsOmitted`). The answer is an
   * ordinary `council:patch` delta with one attempt; there is deliberately no
   * frame for "no such attempt": it may have been banned, and the stack will
   * learn about that in due course.
   */
  | { t: 'council:attempt'; cellId: string; participantId: string }
  /**
   * Put a room document on the shared screen — or take it off.
   *
   * Through the server, not through presence: presence disappears with the
   * tab, and the teacher's closed laptop would take the material away from
   * everyone at once, while a latecomer would see nothing until the teacher
   * moved. The room remembers it by itself and tells everyone who connects.
   */
  | { t: 'board:open'; name: string }
  | { t: 'board:close' }
  /**
   * Finish the class — and open it again.
   *
   * A teacher's action, checked by the server: from that minute a participant
   * in the room only reads. The reverse move is right here, on purpose — a
   * class ends before one more cell needed finishing, and the cost of a
   * mistake must be one press, not "create a new seminar".
   */
  | { t: 'class:finish' }
  | { t: 'class:resume' }
  /**
   * Tree edits: create, rename, remove.
   *
   * Over the control socket, not REST, for exactly the reason `cells:move`
   * goes through it: the result must be seen not only by whoever pressed but
   * by the whole room, and the `files` message is already broadcast to
   * everyone. A refusal comes back to that one person as an `error` line:
   * `refused` is about CRDT frames parsed by the gate, and the tree does not
   * go through the gate.
   */
  | { t: 'tree:mkdir'; path: string }
  | { t: 'tree:new'; path: string }
  /**
   * Bring a .ipynb into the room — that is, open it as a notebook.
   *
   * A separate message, not a side effect of opening a tab: the cells move
   * from the file into the room's document, and the server must do it once,
   * not twenty browsers racing each other.
   */
  | { t: 'book:open'; path: string }
  | { t: 'tree:move'; from: string; to: string }
  | { t: 'tree:remove'; path: string }
  /**
   * Duplicate a file — as a copy alongside, under a free name.
   *
   * The right is `files`, the same as for "new file" and for upload: a copy
   * ADDS an entry rather than removing one, and an open room where everyone
   * puts their own solution is an ordinary seminar. Rename and delete stay
   * with the teacher, and there is no contradiction: they remove the old path,
   * and this does not.
   *
   * The copy's name is chosen by the server, not by whoever pressed. "Taken"
   * here is not a refusal but the normal case — people duplicate the same
   * thing twice in a row — and composing the name on twenty tabs racing each
   * other would mean fighting over it across the network: the second would
   * get a refusal for a name the first took while the frame was in flight.
   *
   * Files only. A folder would have to be walked in depth, counting the
   * room's ceiling at every step, while in the panel it is one press with no
   * way back; saying "folders are not duplicated" is cheaper than silently
   * doubling an unpacked dataset.
   */
  | { t: 'tree:copy'; path: string }
  /**
   * Give me the whole tree.
   *
   * Asked in exactly one case: a delta arrived (`files:delta`), and there is
   * nothing to glue it to — the tab holds a list with a different number. By
   * itself that is not a failure: the room stood empty, someone who came in
   * recomputed the tree, the number moved. Asking is cheaper than sending
   * everyone the full list just in case.
   */
  | { t: 'files:ask' }
  /**
   * Run a file — as a script, not a cell.
   *
   * It goes into the same terminal where `term:run` lives: the room has one
   * container, one output feed and one "interrupt" button, and giving scripts
   * a second one would mean showing two different answers to the question
   * "what is computing now".
   */
  | { t: 'file:run'; path: string }
  /* --------------------------------------------------------- lecture */
  /**
   * Start a lecture: one page on the projector and one person at the console.
   *
   * Separate from the shared screen (`board:open`), because it is a different
   * kind of class. With the shared screen everyone looks at the document on
   * their own and is free to run ahead; a lecture has ONE projection the hall
   * sees, and its page is moved by the presenter.
   */
  | { t: 'lecture:start'; file: string }
  | { t: 'lecture:stop' }
  | { t: 'lecture:page'; page: number }
  /** A black screen: turns off the projection, leaving the page on the presenter's console. */
  | { t: 'lecture:blank'; on: boolean }
  /**
   * Append to a pencil stroke.
   *
   * In points, not the whole stroke at the end: the hall must see the line
   * while it is being drawn. Coordinates are fractions of the page: a tablet
   * pixel means nothing either on the projector or for a student.
   */
  | {
      t: 'ink'
      page: number
      id: string
      color: string
      width: number
      /** Pairs of fractions: x0, y0, x1, y1 … */
      points: number[]
    }
  | { t: 'ink:undo'; page: number }
  /**
   * Erase one stroke — the one the eraser touched.
   *
   * By the stroke's name, not by pixels: the wire has only whole strokes, and
   * pixel erasing would require a new format and rewriting the lecture's whole
   * history for the sake of an eraser. Separate from `ink:undo`, and not for
   * symmetry: undo removes the LAST stroke, the eraser the one the hand came
   * down on, and in the middle of a lecture those are two different gestures,
   * not one with two buttons.
   */
  | { t: 'ink:erase'; page: number; id: string }
  | { t: 'ink:clear'; page?: number }
  /**
   * Ask for the ink of ONE page.
   *
   * The welcome batch does not have to carry all of the lecture's writing:
   * twenty minutes of markup is about a megabyte per socket, and at that
   * moment people are looking at one page. So the batch carries the current
   * page and an INVENTORY of the rest (`ink:pages`), and a page one moved to
   * without asking is asked for here: by the console's thumbnail strip with
   * its blank sheets and by a tab that fell behind the hall.
   *
   * A page the presenter moved the HALL to, the server sends by itself —
   * otherwise between the `lecture` frame and the answer to this question five
   * hundred people would have an empty slide.
   */
  | { t: 'ink:page'; page: number }
  /**
   * Ask for the speaker notes for a document.
   *
   * Ask, rather than receive in the welcome batch, and that is not thrift.
   * Notes go ONLY to hosts, and a socket's role is determined on connection —
   * putting them in the shared batch would mean keeping "who may see this" in
   * two places, one of which someone will one day forget to fix.
   */
  | { t: 'notes:open'; file: string }
  /**
   * Write a note for one page. An empty one means its absence.
   *
   * The whole text of the page, not a difference: on a disconnect the client's
   * queue holds sixteen messages and throws away the OLD ones, so with the full
   * text the only surviving message is the correct one, while with a
   * difference a meaningless tail would survive.
   */
  | { t: 'notes:set'; file: string; page: number; text: string }
  /**
   * The pointer. Ephemeral on purpose: where it was a second ago is not a fact
   * about the lecture but a movement of a hand, and there is nowhere and no
   * reason to store it.
   *
   * `shape` — whether it points with a dot or circles with a line; it travels
   * together with the point, because the hall must see THE SAME as the
   * presenter. The shape lives in every frame, not in a separate mode-change
   * message: pointer frames go twenty-five times a second anyway, an extra
   * byte in them is cheaper than one more state that can be missed and drift
   * apart.
   */
  | { t: 'laser'; page: number; x: number; y: number; shape?: 'dot' | 'line' }
  | { t: 'laser:off' }
  /**
   * What to complete at this place in the code — the cell editor asks the
   * room's kernel.
   *
   * `id` is unique to each question, and the answer arrives with the same
   * number: while a person types there are several questions on the wire, and
   * a late answer must be recognized and thrown away, not shown over a fresh
   * one. That is the only reason for the number — it refers to nothing in the
   * room.
   *
   * `cursor` is characters from the start of `code`, not a line and column:
   * exactly what Jupyter itself measures the cursor with (`cursor_pos`), and
   * an extra conversion between counting systems is one more place where
   * surrogate pairs will one day drift apart.
   *
   * `code` is the text of the CELL, not the notebook: the kernel completes
   * from its own variables, and an unfinished line higher up in the notebook
   * would only confuse the parse. It is never longer than 24 KB — the client
   * cuts it itself (session.svelte.ts), and the server cuts it once more,
   * because the client is not the only one who can send a frame here.
   */
  /**
   * `cellId` — where the question comes from, and it is about the RIGHT, not
   * about parsing.
   *
   * The right to complete is the right to read the kernel's state, and in a
   * lecture it belongs to the teacher (control.ts · mayComplete). One's own
   * council cell is the only one where a student is told to write code
   * themselves, and a silent refusal there meant "write from memory": names
   * came from the cell's own words, but the columns of the real `df` did not.
   * A frame without the cell's name could not say this, and the server has
   * no right to fill it in: see the comment at mayComplete. Optional — an old
   * client does not send it, and then the old rule applies.
   */
  | { t: 'complete'; id: number; code: string; cursor: number; cellId?: string }
  /** Help about what is under the caret: the signature for the hint above the parenthesis. */
  /**
   * `brief` — what is asked is not help but ONE LINE about the value.
   *
   * The same frame, because the question is the same: "what is under the
   * pointer". The difference is in the answer and the price: help is a
   * signature with documentation and, if needed, bringing the kernel up,
   * while a line about a value is the type and size of an object already
   * lying in the kernel. The kernel is not brought up for it and there is no
   * static guessing: no answer, no line (the owner's complaint on 21 Sep 2026
   * about "a wagonload of text" on a variable).
   */
  | { t: 'inspect'; id: number; code: string; cursor: number; cellId?: string; brief?: boolean }
  /**
   * "Where is this defined" — the third question of the same shape, and the
   * only one of the three that does NOT go to the kernel.
   *
   * The server answers it by itself: it parses a subset of Python
   * (shared/python-defs.ts) and searches the notebook's document and the .py
   * files of the seminar folder. Hence two consequences its neighbors do not
   * have. It works without a running kernel — that is, for someone who has
   * just opened the notebook and run nothing; and the right here is not "the
   * right to run" but the right to READ: going to a definition does not touch
   * the kernel's state and reports nothing about it.
   *
   * `path` is the file clicked in, if it is not a cell: relative imports
   * (`from . import util`) are resolved from it.
   *
   * `from` is how many characters were cut off on the LEFT when the source did
   * not fit under the ceiling. Without this number a jump in a large file
   * landed on the wrong line: the server counted lines from the start of the
   * window it was sent, while a person sees them from the start of the file.
   * `case_cian.py` in a live course is 886 KB, that is, the window is the rule
   * there, not the exception.
   */
  | {
      t: 'define'
      id: number
      code: string
      cursor: number
      cellId?: string
      path?: string
      from?: number
    }
  | { t: 'ping' }

/**
 * Where the definition lies.
 *
 * A cell is addressed by name (`cellId`) — the same as everywhere in the room;
 * a file by its path from the root of the seminar folder. A cell has a `path`
 * too, but it is about the NOTEBOOK the cell lies in: it labels the jump when
 * there are several notebooks.
 */
export interface DefinitionHit {
  where: 'cell' | 'file'
  cellId?: string
  path?: string
  /** The line, counting from one: that is how it is shown to a person. */
  line: number
  /** The column where the name starts, counting from zero. */
  column: number
  /** What is written there — as a line, trimmed: the caption of where the jump landed. */
  text: string
  /** The name that was looked for. */
  name: string
}

/**
 * Why there is no jump — and these are four DIFFERENT answers, not one.
 *
 * `nothing` — there is no name under the pointer at all. Nothing is said
 * about it: there was no underline, and the person made no gesture.
 *
 * `unknown` — there is a name, but no definition in the room. An ordinary
 * thing: a function from the standard library, a typo, a cell not written
 * yet.
 *
 * `outside` — a name from a library: the module is named, but its file is
 * not and cannot be in the seminar folder. It is worth saying so together
 * with the module's name — "numpy is not in the seminar folder" explains,
 * while "not found" accuses.
 *
 * `opaque` — a chain from DATA: `df.head`, where `df` is bound by
 * assignment. Searching for `head` across the whole notebook would almost
 * certainly find someone else's method and confidently lead into it — the
 * one miss a person would not notice. So here there is an honest "I do not
 * know what df is".
 */
export type DefinitionMiss =
  | { why: 'nothing' }
  | { why: 'unknown'; name: string }
  | { why: 'outside'; name: string; module: string }
  | { why: 'opaque'; name: string; owner: string }

/**
 * Why there is no help — and why it is worth saying out loud.
 *
 * For a long time nothing was said: help either appeared or did not, and a
 * person could not tell "the name is not in the kernel" from "the kernel is
 * still coming up" from "there is never help here". At the live class on
 * 19 Sep 2026 this read as a breakage — "it does not always show up" —
 * although every refusal was legitimate.
 *
 * `no-kernel` — the room has no kernel, and this person has no way to bring
 * one up (a lecture room, a finished class). We say that there is nobody to
 * start it.
 *
 * `starting` — the kernel is coming up right now, including because this very
 * question brought it up. There will be an answer, but not to this question:
 * saying "in a few seconds" is more honest than silence.
 *
 * `busy` — the kernel is computing someone else's cell. ipykernel has one
 * shell and it is sequential: the help will not be late, it will not come at
 * all.
 *
 * `thinking` — static analysis did not make it within its budget. The first
 * analysis of a heavy library on a cold container costs seconds, the second
 * milliseconds: there will be an answer, and it is worth waiting for.
 * Separate from `unknown` because these are exact opposites: "I do not know
 * yet" and "I do not know".
 *
 * `unknown` — asked, and the answer was "not found". The name was never
 * executed, and static analysis knows nothing about it either.
 *
 * `refused` — asking was not allowed (the question bucket, a frame without
 * code). The client lives through this silently: the person made the right
 * gesture, there is nothing to explain to them.
 *
 * Three of the six are temporary: `starting`, `busy` and `thinking`. The
 * client does not settle for them but asks again while the hint is open
 * (CodeEditor.svelte · `askSignature`), and replaces the reason line with the
 * help in place.
 */
/**
 * A short truth about a value — what is shown on hovering over a variable.
 *
 * All fields are optional, and that is the shape of the answer, not laziness:
 * an `int` has a value and no size, a `DataFrame` the other way round, and an
 * unfamiliar object has only a type name — nothing else may be asked of it,
 * since that could be expensive or have a side effect
 * (server/src/kernel/inspect-static.ts · `_brief_of`).
 */
export interface BriefValue {
  /** `DataFrame`, `ndarray`, `list[str]`, `LinearRegression`. */
  type: string
  /** The size in the type's own words: `1460 × 81`, `(100, 3)`, `3`. */
  dims?: string
  dtype?: string
  /** The value itself — only for scalars and strings, trimmed. */
  value?: string
  /** A footnote: the tensor's device, the dict's first keys, "fitted". */
  note?: string
}

export type InspectMiss =
  | 'no-kernel'
  | 'starting'
  | 'busy'
  | 'thinking'
  | 'unknown'
  | 'refused'

export type TerminalStatus = 'closed' | 'starting' | 'idle' | 'busy' | 'dead'

/**
 * What a CRDT frame does to the document — in terms of the room's rules, not
 * bytes.
 *
 * One enumeration for both sides: the gate (server/src/collab/gate.ts) judges
 * by it, and `refused` names it too. There were two copies, and they had
 * already drifted apart — the protocol had a fourth value `'files'` the
 * server never sent: files do not go through the gate, they have control
 * messages and `error`.
 */
export type GateRule = 'structure' | 'edit' | 'title'

export type ControlServerMessage =
  | { t: 'instance:language'; language: Locale }
  /**
   * @param kernel the state of the ROOM's notebook kernel — what has always
   * been here.
   * @param kernels the state per notebook: the sheet's path and what is
   * happening with its kernel. The field is optional because a tab opened
   * before multiple kernels existed does not know it, and from then on both
   * arrive with the document anyway (`meta.kernels`) — this frame is only
   * about the first moment, while sync is in progress.
   */
  /**
   * @param ownKernels whether THIS instance can give a personal notebook a
   * kernel of its own. On docker — yes; on the broker (k3s) one Pod is created
   * per class, and a second one, without a GPU, does not exist there yet. The
   * field goes to the room so that the "Students' personal notebooks" rule
   * line does not promise what the instance cannot do: learning it from a
   * refusal on the first run in the middle of a class is the worst way. A
   * missing field reads as "can": that is how an old build would answer.
   */
  | {
      t: 'ready'
      kernel: KernelStatus
      kernels?: Array<{ book: string; status: KernelStatus }>
      ownKernels?: boolean
    }
  /*
   * The role the SERVER will act on, sent as soon as the socket opens. A
   * participant token carries the role it was minted with, which goes stale:
   * a teacher who joined a seminar before signing in holds a 'participant'
   * token for a room they run, and the client would grey out interrupt and
   * restart for its own owner. Presence of a staff cookie decides it, and this
   * is how the browser is told.
   */
  | { t: 'role'; role: ParticipantRole }
  | { t: 'terminal'; status: TerminalStatus }
  /** @param book whose news this is; without the field — the room's notebook. */
  | { t: 'kernel'; status: KernelStatus; book?: string }
  /**
   * The room's tree. `truncated` — the list is incomplete: the walk hit the
   * ceiling, and some folders stayed unexpanded.
   *
   * A flag, not silence: "the file is not in the list" and "there is no file"
   * are different things, and whoever confuses them either searches by eye
   * for a file that is on disk or (worse) removes a live notebook based on an
   * incomplete list.
   */
  | { t: 'files'; files: FileEntry[]; truncated?: boolean; rev?: number }
  /**
   * The tree changed — and only what changed in it travels.
   *
   * `from` is the number of the list the delta is laid on top of, `rev` the
   * number after it. The numbers run through the room and grow by one: a tab
   * that does not hold `from` does NOT apply the delta (there is nothing to
   * glue it to) but asks for the whole tree (`files:ask`). This way a gap
   * heals itself — both after a reconnect and after someone who came in got a
   * list fresher than someone else's.
   *
   * A truncated tree is not described by a delta: the full frame travels
   * there.
   */
  | ({ t: 'files:delta'; from: number; rev: number } & FilesDelta)
  /*
   * The room's rules changed. They can be edited after a seminar is made, and
   * the server reads them fresh on every request — so a room told nothing
   * would keep drawing a Run button that had just started refusing, which
   * reads as a broken product rather than a rule.
   */
  | { t: 'rules'; rules: RoomRules }
  /**
   * The class has ended or is going on again.
   *
   * A separate frame, not a field in `rules`: the stored rules do not change,
   * and the room must see the difference between "the teacher tightened a
   * rule" and "the class ended" — the phrases in the hints are different for
   * them.
   */
  | { t: 'class'; finishedAt: number | null }
  /**
   * You have been banned — right now, in the middle of the class.
   *
   * It comes to one person, and right after it the socket closes. Without the
   * frame the banned person would see exactly what the room sees on a network
   * drop: the connection silently vanished and does not come back — that is,
   * they would decide Colloq broke and go complain about it instead of
   * understanding what happened.
   *
   * `until` is the moment the ban ends; the browser shows it in words by its
   * own clock.
   */
  | { t: 'banned'; until: number }
  /**
   * The document on the room's shared screen, or `null` if there is none.
   *
   * Comes both in the welcome batch and on every change: otherwise a person
   * who came in the middle of the class will not learn that the room is
   * looking at something.
   */
  | { t: 'board'; open: string | null }
  /**
   * The room's lecture, or `null` if there is none.
   *
   * Comes both in the welcome batch and on every change: a latecomer must see
   * the same page as the hall without waiting for the presenter to turn the
   * page.
   */
  | { t: 'lecture'; state: LectureState | null }
  /**
   * The lecture's ink — a FULL replacement of everything the tab holds.
   *
   * Comes on connection and after "erase everything". How many pages travel
   * in it is decided by the server, and both measures are legitimate: the
   * welcome batch carries the SHOWN page (control.ts · inkFrame), and a
   * lecture just started carries an empty list; the rest arrives by
   * `ink:page`. The client is ready for both measures and does not take what
   * arrived for the lecture's full writing: how many pages are actually inked
   * is said by the inventory below.
   */
  | { t: 'ink'; strokes: InkStroke[] }
  /**
   * The ink of ONE page — a full replacement of the strokes of THAT page, and
   * only of it.
   *
   * An answer to a tab's question, and a send-along to someone the presenter
   * moved to another page. An empty list is a legitimate answer and means
   * "the page is clean", not "I do not know": without it a tab that asked
   * about a blank sheet would wait for ink until the end of the lecture.
   */
  | { t: 'ink:page'; page: number; strokes: InkStroke[] }
  /**
   * The INVENTORY of inked pages: their numbers, without a single stroke.
   *
   * Travels next to every `ink` — that is, with the welcome batch and with
   * "erase everything" — and costs tens of bytes where the ink costs a
   * megabyte. Without it a tab that got one page cannot tell "the rest are
   * empty" from "the rest have not arrived": the console counts from the ink
   * how many blank sheets were created (sheet number N proves that all before
   * it were created too), and the thumbnail strip knows from it what to ask
   * for.
   */
  | { t: 'ink:pages'; pages: number[] }
  /** New points. A stroke with a known name is extended, an unknown one is created. */
  | { t: 'ink:add'; stroke: InkStroke }
  | { t: 'ink:drop'; page: number; id: string }
  | { t: 'ink:clear'; page: number | null }
  /**
   * The speaker notes for a document: page → text.
   *
   * Comes ONLY to hosts and only in answer to `notes:open`. The only thing in
   * this product the room is not supposed to see: a note "ask here who
   * remembers Bayes' formula; if they are silent, derive it on the board" is
   * the teacher talking to themselves, and arriving to everyone it arrives
   * together with the answer to a question not yet asked.
   */
  | { t: 'notes'; file: string; notes: Record<number, string> }
  /**
   * The echo of one edit — also only to hosts.
   *
   * One page, not a fresh whole map: an edit goes out with a debounce of four
   * hundred milliseconds, that is, several times per phrase, and the map for a
   * two-hundred-page handout is hundreds of kilobytes. This is exactly the
   * wastefulness the ink is protected from by slicing into new points.
   */
  | { t: 'notes:one'; file: string; page: number; text: string }
  /**
   * Where the pointer is right now, or `null` — it was taken away.
   *
   * No color: it is red for everyone, always — it is the one thing the hall
   * recognizes instantly and confuses with nothing. The presenter's color used
   * to come here out of the general habit of coloring everything by author,
   * and at a second teacher's lecture the pointer turned out blue — that is,
   * indistinguishable from the ink.
   */
  | { t: 'laser'; at: { page: number; x: number; y: number; shape: 'dot' | 'line' } | null }
  /**
   * Council: one's own attempt — to one person.
   *
   * Comes to the author on connection (for every cell where they have an
   * attempt or where a council is open) and after each of their own actions
   * and each of the teacher's actions on their attempt: submitted, shown,
   * answered, run, marked, council closed. It never contains other people's
   * attempts.
   */
  | { t: 'council:mine'; cellId: string; state: CouncilMine }
  /**
   * Council: the whole stack — ONLY to the teacher.
   *
   * Whole — in the host's welcome batch for every cell where a council is
   * open or where there are attempts, and on a change of lock or knobs; the
   * changes in between travel as `council:patch`. The client computes the
   * groups and the stack's order itself from the full list. The server may
   * merge frequent resends into one (debounce).
   */
  | { t: 'council:board'; cellId: string; board: CouncilBoard }
  /**
   * Council: a change in the stack — ONLY to the teacher, and only what
   * changed.
   *
   * The whole stack travels in the welcome batch and on a lock change;
   * everything else — a snapshot on a pause in typing, a run, a reply, a
   * mark, a ban — travels as the attempts it affected. Otherwise every frame
   * would carry to the host the output of every attempt (up to megabytes per
   * card) because of one letter from one student — three times a second while
   * the class types. `attempts` are whole attempts (replace by
   * participantId), `removed` are those no longer in the stack (a ban);
   * `counts`, `lock` and `settings` are fresh, as in the stack. The client
   * computes the groups and the order itself from the full list, as before. A
   * frame for a cell whose stack the client does not have is skipped: the full
   * stack for it is already on its way or has already been.
   */
  | {
      t: 'council:patch'
      cellId: string
      attempts: CouncilAttempt[]
      removed: string[]
      counts: CouncilBoard['counts']
      lock: CellLock
      settings: CouncilSettings
    }
  /**
   * Council: THE PLACE IN THE QUEUE — and nothing else.
   *
   * The number moves for every waiting person at every end of any kernel
   * work, and it used to be carried by the whole sheet (`council:mine`): with
   * five hundred waiting, one finished run meant five hundred sheets, each of
   * which the server assembled separately (a walk of the document under a
   * lock, reading the attempt from the database) and carried whole, together
   * with the attempt's text and the task, for the sake of one number in it.
   * Measured: 0.32 MB per shift against 30 KB with these frames.
   *
   * The whole queue is NOT broadcast to the room either: it would be one
   * assembly for everyone, but five hundred times eleven kilobytes (measured
   * 5.65 MB per shift) — so that each person reads one number of their own in
   * it.
   *
   * `at` is the place in the KERNEL's queue, not among attempts: the
   * teacher's cells may be computing ahead, so the numbers are not
   * contiguous. `null` means the person is no longer in this cell's queue;
   * "computing now" is said by `run.state`, not by a place in the queue.
   */
  | { t: 'council:queue'; cellId: string; at: number | null }
  /**
   * Council: what the kernel of this cell's NOTEBOOK is busy with — ONLY to
   * the teacher.
   *
   * Comes in the welcome batch for every cell with a stack and then on every
   * queue shift (coalesced within a window). Small and without texts: a name,
   * a cell number, a clock and two flags. Everything else about the work the
   * console already knows from the stack. See `CouncilKernel` — it records
   * why this was introduced.
   */
  | { t: 'council:kernel'; cellId: string; kernel: CouncilKernel }
  /** Council: the oracle on solutions changed state — also to the teacher only. */
  | { t: 'council:oracle'; cellId: string; oracle: CouncilOracle }
  /**
   * Council: what is happening with the hint request — to the attempt's
   * AUTHOR and nobody else.
   *
   * The answer itself arrives as a letter in `council:mine`: it is part of the
   * attempt and survives a reload. This frame is only about the button:
   * "thinking" (disable), "done" (enable again) and a refusal in words if the
   * model is turned off or the questions have run out. A separate frame, not
   * the general `error`: from the general one you cannot tell whose refusal
   * arrived, and the button would stay disabled forever.
   */
  | { t: 'council:hint:state'; cellId: string; asking: boolean; error?: string }
  /**
   * Council: what is on the screen for this cell right now — to the WHOLE
   * room.
   *
   * The only council frame with someone else's code that a student sees, and
   * that is not a leak: the shown solution is on the projector that very
   * second. In return the substitution is gone — showing no longer touches
   * the cell's shared text (`CouncilShown`).
   *
   * `null` means "taken off the screen" (or there is nothing to show): the
   * badge folds, the cell goes back to one column. Comes in the welcome batch
   * for every cell where a showing is on, and then on every change — someone
   * else was shown, the names knob was flipped, the author rewrote the shown
   * text.
   */
  | { t: 'council:shown'; cellId: string; shown: CouncilShown | null }
  /**
   * Council: "N of M submitted" — to the whole room, without texts.
   *
   * This is for the projector and for the chip above the cell for students.
   * There is deliberately no live wall here: the counter says that the class
   * is working, and nothing about what it wrote. `total` is how many people
   * started an attempt (submitted or writing).
   */
  | { t: 'council:count'; cellId: string; submitted: number; total: number }
  /**
   * The council's welcome batch is over — emptiness can now be trusted.
   *
   * Without this frame "there is no stack for this cell" meant two different
   * facts at once: "the frame is still on its way" and "there really is no
   * council here". The console chose the second, and on reload managed to
   * flash "the cell is not in a council" exactly between the splash and
   * itself. Nothing inside the client can tell them apart: NOT A SINGLE frame
   * may arrive (the room has no councils at all), and waiting "a little
   * longer" is guessing, not knowing.
   *
   * So the end of the batch is said in a word, one frame per connection and
   * twenty bytes long. It goes to EVERYONE, not only the teacher: a student
   * has the same fork on their sheet, and a second flag for the same fact
   * would drift from the first. An old server does not send it — the client
   * survives that with a timed guard (council.svelte.ts · WELCOME_WAIT_MS).
   */
  | { t: 'council:ready' }
  /**
   * An edit to the DOCUMENT was not accepted — and why.
   *
   * Comes to one person, not to the room. Prevention is the normal path: a
   * room where a rule forbids editing draws read-only editors, and this
   * message is a safety net for two cases: a forged or scripted client, and
   * the fractions of a second after a rule was tightened while the frame was
   * in flight.
   *
   * Correctness does not rest on it: the control socket is a separate
   * connection that reconnects on its own, and if returning the document to a
   * consistent state depended on this line, a disconnect would leave a person
   * mute forever, and neither side would be able to notice.
   *
   * Only about a CRDT frame parsed by the gate (server/src/collab/gate.ts):
   * the notebook's composition, a cell's text, the title. Everything that goes
   * as a control message — the file tree, the terminal, the lecture — has its
   * own answer, and that is `error`.
   */
  | { t: 'refused'; rule: GateRule; message: string }
  | { t: 'error'; message: string }
  /**
   * The answer to the heartbeat, and the server's clock along with it.
   *
   * `startedAt` on a cell is server time, while the stopwatch ticks in the
   * browser. Subtracting one from the other without a correction means showing
   * "40.0s" on a just-started cell to someone whose clock runs fast, and a
   * frozen "0.0s" to someone whose clock runs slow — a stopwatch standing
   * still on a working cell. One field on a message that goes back and forth
   * anyway removes both cases.
   */
  | { t: 'pong'; now: number }
  /**
   * The answer to `complete` — with the same number as in the question.
   *
   * An empty list is a legitimate answer, and it is also the answer to every
   * refusal: the kernel is busy, there is no kernel at all, the right is not
   * granted, there are more questions than allowed. There are deliberately no
   * words about the refusal here. Completion is the background of typing, and
   * a toast "in this room the teacher runs things" on every typed dot would be
   * a punishment for typing, not an explanation of the rule: the rule is told
   * by the gray "run" button, which has room for that.
   *
   * `start`/`end` — which piece of code the replacement replaces; the kernel
   * computes them (`cursor_start`/`cursor_end`), and by them the editor
   * understands whether to append to `df.` or to replace the word begun.
   */
  | {
      t: 'complete:reply'
      id: number
      matches: Array<{ text: string; type?: string }>
      start: number
      end: number
    }
  /**
   * The answer to `inspect`. `found: false` — nothing to say, and that is not
   * an error.
   *
   * `reason` is WHY there is nothing (`InspectMiss`), and the field is
   * optional on purpose: an old client does not read it and behaves as it
   * did, while a new one says a single muted line instead of silence. The
   * field exists only on a miss: where `found: true`, there is nothing to
   * explain.
   */
  | {
      t: 'inspect:reply'
      id: number
      found: boolean
      text?: string
      reason?: InspectMiss
      /** The answer to `brief`: the value's type and size. See `BriefValue`. */
      brief?: BriefValue
    }
  /**
   * The answer to `define`: where to go — or why there is nowhere.
   *
   * Exactly one of the two fields. Silence, as with `complete`, will not do
   * here: completion is the background of typing, while a person CALLS for a
   * jump to a definition, and a gesture that did nothing reads as a breakage.
   * So each "nowhere" has its own reason and its own words — see
   * `DefinitionMiss`.
   */
  | { t: 'define:reply'; id: number; hit?: DefinitionHit; miss?: DefinitionMiss }

import type { OracleMode } from './admin.js'

/* ------------------------------------------------------------------ council */

/**
 * What is known about an attempt after a run.
 *
 * A separate record, not fields of the shared cell: the attempt's output goes
 * TO THE ATTEMPT, and the shared cell stays what the teacher showed. `by` is
 * who pressed: the teacher (the usual path) or the author themselves (with the
 * knob on).
 */
export interface CouncilRun {
  state: Extract<CellState, 'queued' | 'running' | 'ok' | 'error'>
  outputs: CellOutput[]
  execCount: number | null
  /** How long the actual run took; `null` while it is going or if it was interrupted. */
  ranMs: number | null
  /** The server clock at the start — for the line "run by the teacher · 14:36". */
  startedAt: number
  by: 'host' | 'author'
  /**
   * The server stopped the run by itself: it went on longer than the limit
   * from the cell's rules (notebook.ts · CouncilSettings.runLimitSec). The
   * number is the limit in seconds that fired: the rules may have changed
   * since, and the line "stopped: longer than 30 s" must speak about its own
   * run.
   *
   * A separate field, not an error name in the output: by `ename` one would
   * have to parse output that often does not even travel in the stack
   * (`outputsOmitted`), and the job list and the queue must know the reason
   * without opening the card. `state` is then `'error'`, and the output up to
   * the stop is kept.
   */
  timedOut?: number
  /**
   * The output did not travel in this frame — it exists, but it is requested
   * separately.
   *
   * The whole stack (`council:board`) carries every attempt's output, and that
   * is up to 64 KB of text and up to 2 MB of pictures (kernel/council.ts).
   * With five hundred attempts run, one frame would become tens of megabytes
   * — and that on every console reconnect and every click of the lock. So the
   * server has an output budget per frame: attempts beyond it travel with
   * `outputs: []` and this flag, and the console asks for one card's output
   * with `council:attempt` — it arrives whole as a `council:patch` delta.
   *
   * Optional: `undefined` means "the output here is real", as before. It is
   * never present in `council:mine` or in the on-request delta.
   */
  outputsOmitted?: boolean
}

/** The teacher's answer to the author or to a group. Always signed by the teacher. */
export interface CouncilReply {
  text: string
  at: number
  /** The name of whoever answered: a room can have two teachers. */
  by: string
  /**
   * Whom this letter was addressed to: personally or to the whole group.
   *
   * Letters are told apart in storage by it: an attempt has two places for
   * them — personal and group (server/src/council.ts · keeping) — and a new
   * letter goes into its own, without touching the neighbor. The teacher
   * answered Petya "Check the sign", a minute later sent the oracle's draft
   * to the whole group, another minute later a correction to the same group;
   * Petya's personal line survives both. The field is optional: attempts
   * recorded before it have no `to`, and such an answer counts as personal —
   * that is, it is kept.
   *
   * `oracle` is the third kind: a model hint the author asked for THEMSELVES
   * when their attempt failed. It lies in the same place as the teacher's
   * letters, and for the same reason: it is a conversation about THIS
   * attempt, not a line in the shared feed — the council never writes to the
   * feed, attempt texts are private. By being its own kind it keeps one place
   * for itself: the next hint replaces the previous one and touches neither
   * the personal letter nor the group mailing.
   */
  to?: 'person' | 'group' | 'oracle'
}

/**
 * The teacher's letters on an attempt — separately and in the order sent.
 *
 * One copy of the rule for both readers: the student's sheet (CellView) and
 * the console feed (PultLetters) draw letters line by line, and both must be
 * able to handle an old server. There the `replies` field does not exist at
 * all, and the only thing that arrives is `reply`: the same letters glued
 * together. A client without the fallback would then show no answer at all —
 * and the student is waiting for the teacher's answer.
 *
 * An empty list means "no letters": nothing to draw, and no line is created.
 */
export function councilLetters(
  attempt: { reply: CouncilReply | null; replies?: readonly CouncilReply[] } | null | undefined,
): readonly CouncilReply[] {
  if (!attempt) return []
  return attempt.replies ?? (attempt.reply ? [attempt.reply] : [])
}

/**
 * The attempt's state in one word — the chip on the card and the color of the
 * line under the segment.
 *
 *   unrun   — not run and not marked (gray line, "not run")
 *   ran     — the run went through without an exception, no mark
 *   failed  — the run failed (red line; the chip shows the exception name)
 *   correct — the teacher marked it "correct" (green)
 *   wrong   — the teacher marked it "wrong" (ochre)
 *
 * The teacher's mark beats the run: `correct`/`wrong` stand even over a failed
 * run, because the decision about correctness is theirs, not the kernel's.
 */
export type CouncilStatus = 'unrun' | 'ran' | 'failed' | 'correct' | 'wrong'

/**
 * A group's state from its members' states — one place for the console, the
 * server and the oracle. It cannot go by one representative: the teacher
 * lands with an arrow on any member of the group, and a "Correct" or a
 * TypeError on their card would otherwise reach neither the line under the
 * segment nor the chip in the summary, and the oracle would count the group
 * differently from the console.
 *
 * The teacher's mark beats the run (correct, then wrong); among runs a
 * failure is louder: for the same text in a shared kernel the outcome depends
 * on the state, and a red line is more honest than a gray one.
 */
export function groupStatus(statuses: readonly CouncilStatus[]): CouncilStatus {
  for (const wanted of ['correct', 'wrong', 'failed', 'ran'] as const) {
    if (statuses.includes(wanted)) return wanted
  }
  return 'unrun'
}

/** One's own attempt — what the student sees. */
export interface CouncilRunRequest {
  id: string
  requestedAt: number
  status: 'pending' | 'declined'
}

export interface CouncilMine {
  runRequest?: CouncilRunRequest | null
  text: string
  /** When they pressed "Submit"; `null` — still writing (or pressed "Edit"). */
  submittedAt: number | null
  updatedAt: number
  /** The teacher showed this answer to the class. */
  shown: boolean
  correct: boolean | null
  /**
   * The teacher's letters as one line — compatibility and a fallback view.
   *
   * The real storage is `replies` (personal and group side by side); here they
   * are glued with an empty line, and the signature and time are the last
   * one's. The field stayed required because clients that do not yet know
   * about `replies` read it: they are better off seeing both letters in one
   * paragraph than losing the personal one.
   */
  reply: CouncilReply | null
  /**
   * The teacher's letters separately, in the order sent.
   *
   * There are no more than two: personal and group. A new letter goes into
   * its own place without touching the neighbor — otherwise a group mailing
   * would erase a personal answer, and there would be no way to bring it back:
   * attempts have no version history (`CouncilReply.to`).
   *
   * Optional: an old server does not send the field, and then the client draws
   * `reply`.
   */
  replies?: CouncilReply[]
  run: CouncilRun | null
  /**
   * The place in the run queue, if runs for students are on and the run is
   * waiting: "you are 37th". `null` — not in the queue.
   */
  queue: number | null
  /**
   * From which second (server clock) the author may run or ask for a run
   * again — the pause from the rules (notebook.ts ·
   * CouncilSettings.rerunPauseSec). `null` or in the past — right now. The
   * server holds the right: it will refuse even without this field; the field
   * is there so that a countdown stands in place of the button rather than a
   * button that answers with a refusal.
   */
  nextRunAt?: number | null
  /** The council on this cell is closed: the text stays a draft and does not go to the server. */
  closed: boolean
  /**
   * THE TASK: the cell's shared text at the moment the lock was switched to
   * council.
   *
   * An empty sheet is seeded with it, not with what lies in the cell now. The
   * difference appears after "Show the class": from that second the shared
   * text is already someone's solution, and a latecomer (or someone who just
   * reloaded the page) got it as the starting text of their sheet. There is
   * no leak in this — the solution is on the screen anyway — but no task
   * remained on their sheet, while an "attempt" appeared, and a single press
   * of "Submit" sent them into the author's group.
   *
   * Optional: an old server does not send the field, and then the client
   * seeds as before — with the shared text.
   */
  seed?: string
}

/** One attempt as the teacher sees it. */
export interface CouncilAttempt {
  runRequest?: CouncilRunRequest | null
  participantId: string
  name: string
  color: string
  avatar: string | null
  text: string
  submittedAt: number | null
  updatedAt: number
  status: CouncilStatus
  run: CouncilRun | null
  /** The glued letters for old clients — as in `CouncilMine.reply`. */
  reply: CouncilReply | null
  /** The letters separately: personal and group — as in `CouncilMine.replies`. */
  replies?: CouncilReply[]
  correct: boolean | null
  shown: boolean
  /** The key of the group of identical solutions (council-board.ts · groupAttempts). */
  groupKey: string
}

/**
 * What is on the screen for this cell right now — a signed attempt, not text.
 *
 * "Show the class" used to overwrite the cell's shared text with someone
 * else's solution on the teacher's behalf: the template disappeared for
 * everyone, the document history named the host as the author, and nothing
 * on the screen said it was someone's solution. Now showing is a LINK next to
 * the cell: nobody touches the text, and the room gets this — whose attempt,
 * who put it up and when, with what output.
 *
 * It goes to the WHOLE room (`council:shown`), unlike the stack: the shown
 * solution is on the projector anyway, there is nothing to hide from those
 * looking at it. Everything else about other people's attempts is still known
 * only to the teacher.
 *
 * An attempt has no id of its own and none is introduced: the key is the
 * "cell and person" pair (council_attempts), and `cellId` sits in the frame
 * itself. A second name for the same thing would one day drift from the
 * first.
 *
 * The name is `null` when the cell's `namesOnProjector` knob is off: then
 * `variant` signs it ("Answer 12"), and neither the name, nor the color, nor
 * the avatar arrive — neither to the student nor to the teacher in the
 * notebook. Not "arrived, but we do not draw it": a name that reached someone
 * else's browser counts as shown.
 */
export interface CouncilShown {
  participantId: string
  /**
   * The answer's number in this cell — the signature instead of the name when
   * names are off, and a way to refer to a solution out loud ("let's look at
   * answer 12").
   *
   * Assigned AT SHOWING and never moves after that: it is computed by
   * submission time among the cell's attempts, and those times are live — a
   * neighbor submitted, changed their mind, submitted again — and the number
   * on the projector would change because of someone else's press.
   */
  variant: number
  /** `null` — names on the projector are off; `variant` signs it. */
  name: string | null
  color: string | null
  avatar: string | null
  /**
   * The name of whoever showed it, and when — `null` for a showing started
   * before these were recorded.
   *
   * A room running right now on the previous version knows only "this attempt
   * was shown": nobody signed the text substitution. Its badge will be
   * assembled without the time line — and that is more honest than a made-up
   * hour.
   */
  shownBy: string | null
  shownAt: number | null
  /** The attempt's text at the moment of showing — the one the class reads. */
  text: string
  /**
   * The TEACHER's run of this attempt, if there was one and it finished.
   *
   * The author's own run does not travel here: under the code on the screen
   * the class reads output the host is responsible for — and the host also
   * says "correct" based on it.
   */
  run: CouncilRun | null
  /** How many OTHERS submitted exactly the same (not counting the author); 0 — nobody. */
  alsoWrote: number
  /**
   * The teacher's mark on this attempt — it also stands in the corner of the
   * projector card. It is no news to the class: they hear "correct" out loud
   * that same second, and on the screen it lasts longer than the voice.
   */
  correct: boolean | null
}

/**
 * The kernel of THE notebook the council cell lives in — as the teacher sees
 * it.
 *
 * A separate frame, because the answer to it cannot be assembled from the
 * stack. The console used to put "running" and "queued" together from its
 * own cell's attempts, and that was half the truth: the notebook has ONE
 * queue, in which ordinary cells and the attempts of all council cells stand
 * mixed. While someone else's work held the kernel, the console wrote
 * "nothing is running in this cell right now" next to "in queue: 12" and hid
 * the "Interrupt" button — exactly in the minute it was needed.
 *
 * Goes ONLY to the teacher and only about their cell's notebook. The names
 * here are always real; hiding them behind "Answer 12" with names off is the
 * console's business, as with the other cards of the stack.
 */
export interface CouncilKernel {
  /** What the kernel is busy with; `null` — free (or nothing has been run in this notebook yet). */
  busy: {
    /** An ordinary cell of the notebook or a council attempt. */
    kind: 'cell' | 'attempt'
    /** The cell's number in the notebook, counting from one; `null` — the cell is gone. */
    index: number | null
    /** Who pressed — for a cell; the author — for an attempt. Empty if no name was found. */
    name: string
    /** The attempt's author: the console opens the work by it. `null` for an ordinary cell. */
    participantId: string | null
    /** This is an attempt of THE SAME cell: the console draws it as its own card, as before. */
    here: boolean
    startedAt: number
    /** Which limit it runs under, in seconds; `null` — no limit. */
    limitSec: number | null
    /**
     * Two stop signals went out, and the work is still computing.
     *
     * Python that went into C does not see SIGINT until it returns to the
     * interpreter. The server signals twice and falls silent — beyond that it
     * would be a storm of requests to Jupyter without a single chance to help
     * (kernel/index.ts · fireLimit). From that second the notebook's queue is
     * stuck dead, and only the console can say so.
     */
    stuck: boolean
  } | null
  /** The NOTEBOOK's whole queue: both cells and attempts of any of its council cells. */
  queued: number
}

/**
 * A group of identical solutions: the same text after normalization (without
 * spaces, empty lines and comments). Computed by the client from the full list
 * of attempts (web/src/lib/council-board.ts) and by the server — for the
 * oracle, with the same function.
 */
export interface CouncilGroup {
  key: string
  count: number
  /** The group's one-line name, from the oracle; `null` until then (the first code line is drawn). */
  label: string | null
  /** The representative's code — what is shown in the summary. */
  sample: string
  /** Over all members, not the representative — `groupStatus`. */
  status: CouncilStatus
  /** Someone from the group is on the screen now: this text already lies in the shared cell. */
  shown: boolean
  /** The representative: the earliest to submit in the group. */
  representative: string
  members: string[]
}

/**
 * What one needs to know about an attempt to put it into a group.
 *
 * Exactly the fields that the console card (`CouncilAttempt`), the server row
 * and the attempt the oracle sees all have. Nothing extra: grouping does not
 * concern name, color or avatar.
 */
export interface GroupMember {
  participantId: string
  text: string
  submittedAt: number | null
  updatedAt: number
  status: CouncilStatus
  shown: boolean
  /** The group key — `normalizeAttempt(text)`, computed once on write. */
  groupKey: string
}

/**
 * The attempt's state in one word.
 *
 * The teacher's mark beats the run: the decision about correctness is theirs,
 * not the kernel's (see `CouncilStatus`). One function for the server, the
 * console and the oracle: three copies of this rule had already drifted apart
 * in how they broke ties, and that would have cost a group signed with
 * someone else's name.
 */
export function attemptStatus(attempt: {
  run: CouncilRun | null
  correct: boolean | null
}): CouncilStatus {
  if (attempt.correct === true) return 'correct'
  if (attempt.correct === false) return 'wrong'
  if (attempt.run?.state === 'error') return 'failed'
  if (attempt.run?.state === 'ok') return 'ran'
  return 'unrun'
}

/**
 * Submission order: whoever submitted earlier comes earlier in the list; in
 * the same millisecond — whoever wrote earlier, then by id.
 *
 * The tie-break matters more than it seems: the group's representative is
 * chosen by it, and two implementations with different tie-breaks give the
 * console and the oracle different representatives of the same group — that
 * is, the draft answer lands on the wrong card. That is exactly how it was:
 * the server and the client broke ties by `updatedAt`, the oracle did not.
 */
export function bySubmission(
  a: Pick<GroupMember, 'submittedAt' | 'updatedAt' | 'participantId'>,
  b: Pick<GroupMember, 'submittedAt' | 'updatedAt' | 'participantId'>,
): number {
  return (
    (a.submittedAt ?? 0) - (b.submittedAt ?? 0) ||
    a.updatedAt - b.updatedAt ||
    a.participantId.localeCompare(b.participantId)
  )
}

/**
 * Groups of identical solutions — only among submitted ones, by the
 * ready-made `groupKey`.
 *
 * One function for three places: the teacher's stack (server/src/council.ts),
 * the frame for the oracle (server/src/ai/council.ts) and the console
 * (web/src/lib/council-board.ts). While there were three of them, every change
 * to the key, the tie-break or the order had to be repeated three times — and
 * one day it would not have been: "311 others answered the same" would have
 * drifted from the width of the segment, and the oracle's draft would have
 * landed on the wrong group.
 *
 * Only submitted ones: what a person is still typing is not a solution but
 * half a word. The representative is the earliest to submit; the state and
 * "on screen" go over all members (`groupStatus`); the order is from a big
 * group to a small one, on a tie the one whose representative submitted
 * earlier goes first, and then by key, so that the order does not float
 * between two identical frames.
 */
export function groupAttempts<T extends GroupMember>(
  attempts: readonly T[],
  labels: Record<string, string> = {},
): CouncilGroup[] {
  const byKey = new Map<string, T[]>()
  for (const attempt of attempts) {
    if (attempt.submittedAt === null) continue
    const bucket = byKey.get(attempt.groupKey)
    if (bucket) bucket.push(attempt)
    else byKey.set(attempt.groupKey, [attempt])
  }
  const groups: CouncilGroup[] = []
  const firstAt = new Map<string, number>()
  for (const [key, members] of byKey) {
    members.sort(bySubmission)
    const head = members[0]
    firstAt.set(key, head.submittedAt ?? 0)
    groups.push({
      key,
      count: members.length,
      label: labels[key] ?? null,
      sample: head.text,
      status: groupStatus(members.map((m) => m.status)),
      shown: members.some((m) => m.shown),
      representative: head.participantId,
      members: members.map((m) => m.participantId),
    })
  }
  // The representative's time is computed above rather than looked up with
  // `find` over all attempts on every comparison: with five hundred attempts
  // that is a sort with a linear search hidden inside it.
  return groups.sort(
    (a, b) =>
      b.count - a.count ||
      (firstAt.get(a.key) ?? 0) - (firstAt.get(b.key) ?? 0) ||
      a.key.localeCompare(b.key),
  )
}

/**
 * The oracle on the class — the state the server keeps and the console tab
 * draws.
 *
 * Asked ONLY by hand, and the answer is always one: prose in the feed. There
 * is no longer a summary by groups of identical solutions here — neither a
 * three-paragraph `summary`, nor `groupLabels`, nor `drafts`: the teacher
 * reads not six nameless groups but the class by name, and a letter to a
 * group turned out to be an answer to the wrong person.
 *
 * `basedOn` is how many attempts the model read last time; so many are
 * submitted on the screen, and the difference is exactly "N more submitted
 * since then" (web/src/lib/council-board.ts · oracleState/staleBy). The CLIENT
 * computes it: otherwise the server would have to send `council:oracle` on
 * every "Submit" by anyone.
 */
/**
 * One turn of the "question → answer" feed: what was asked about the class and
 * what was answered.
 *
 * `people` is needed in exactly one case: when students' names do NOT go to
 * the model (the instance setting `sendNames` is off). Then it sees people as
 * labels S1…SN, and this dictionary turns `S7` in the answer into a chip with
 * the student's name (or "Answer N") and into a button that opens their work.
 * The numbering lives for exactly one question, and the client cannot guess
 * it from the answer — so the server computes the dictionary when it
 * assembles the frame.
 *
 * With names on (the default) the dictionary is empty: the model calls people
 * by name, and the console highlights them by the room's roster
 * (web/src/lib/council-oracle-answer.ts).
 *
 * This frame goes ONLY to teachers (control.ts · toTeachers): both the markup
 * of other people's work and the analysis of who solved it how are not for
 * the class.
 */
/**
 * The length of a question about the class — one number for the input field
 * and for the route.
 *
 * Five hundred characters is "who is stuck and what to tell them", not a
 * retelling of the class: the frame about the class already carries the whole
 * list to the model, and a long question eats into its room. The field cuts
 * on input, the server on receipt: `maxlength` in the browser holds back only
 * the keyboard, not a paste from the clipboard in someone else's tab.
 */
export const MAX_ORACLE_QUESTION = 500

export interface CouncilOracleAnswer {
  id: string
  /** What was asked — in the teacher's own words or as a console preset. */
  question: string
  text: string
  /**
   * Why there is no answer: the model did not open the stream, fell silent
   * halfway, someone pressed "Stop". `undefined`/`null` — an ordinary answer.
   *
   * The turn stays in the feed on a refusal too, and that is no small thing:
   * at the live class on 20 Sep 2026 "Refresh summary" hung until the end of
   * class, and the teacher's question disappeared together with the refusal
   * — there was nothing to repeat for a second try, and it was impossible
   * even to understand what had gone unanswered.
   */
  failed?: string | null
  askedAt: number
  /** Which class the answer was about: "5 submitted · 5 writing" under the answer. */
  basedOn: { submitted: number; drafts: number }
  /**
   * A label in the answer text → participantId. The keys are `S1`, `S2`, …
   *
   * Empty when the names went to the model: then the answer has names in it,
   * and the chip is assembled from the room's roster, not from the dictionary.
   */
  people: Record<string, string>
}

export interface CouncilOracle {
  /**
   * Three states, and the server sets all three itself. A fourth — "stale" —
   * is deliberately not here: it is not about the model but about how many
   * submitted after it, and it is computed on the spot (see `basedOn`).
   */
  state: 'idle' | 'reading' | 'ready'
  askedAt: number | null
  /** How many attempts the model read. */
  basedOn: number
  /**
   * Why it did not work. Duplicates the reason that already stands in the
   * feed at its question (`CouncilOracleAnswer.failed`): the banner on top is
   * for whoever is looking at the tab, the line in the feed for whoever came
   * back to it a minute later and is looking for what exactly went
   * unanswered.
   */
  error: string | null
  /**
   * The feed of questions about the class, oldest first; the server keeps the
   * last six.
   *
   * Six is a screen of conversation in class and the frame's ceiling: every
   * answer carries its own label dictionary, and a feed without a limit would
   * grow in every `council:oracle` until the end of class.
   *
   * `council_oracle` rows written before this field read as an empty feed
   * (server/src/council.ts · normalizeOracle) — a seminar running right now
   * must not stumble over the update.
   */
  answers: CouncilOracleAnswer[]
  /**
   * The question being read right now — so that in the feed it stands above
   * the answer's skeleton instead of appearing together with it.
   *
   * `null` even with `state === 'reading'` is legitimate: that is how a
   * SUMMARY of the solutions is read, which has no question.
   */
  pending: { question: string; askedAt: number } | null
}

/** The whole stack — what arrives for the teacher. */
export interface CouncilBoard {
  lock: CellLock
  settings: CouncilSettings
  counts: {
    /** Saved attempts: submitted work and drafts, regardless of author presence. */
    attempts: number
    submitted: number
    /** Legacy field name: number of saved, unsubmitted drafts, not live typing. */
    writing: number
    groups: number
  }
  attempts: CouncilAttempt[]
  /**
   * The groups at the time of the full frame — for tests and for an outside
   * look; the console computes them itself from `attempts` (council-board.ts ·
   * groupAttempts), so `council:patch` does not carry them, and after a delta
   * this field goes stale.
   */
  groups: CouncilGroup[]
  oracle: CouncilOracle | null
}

/* ------------------------------------------------------------------- AI */

export type AiAction = 'explain' | 'fix' | 'debug' | 'improve' | 'hint' | 'ask' | 'edit'

/**
 * Which actions an oracle in this mode will accept.
 *
 * One definition, two callers: the route that refuses and the panel that
 * decides whether to draw the button. They were separate, and the panel drew
 * FIX and DEBUG in hints mode and let the student press them to be told no —
 * which is the rule leaking out as an error message instead of as a design.
 *
 * 'ask' is a typed question with no instruction of its own, so it survives
 * hints mode; the mode shapes the answer, not the right to ask.
 */
export function actionAllowedIn(mode: OracleMode, action: AiAction): boolean {
  if (mode === 'off') return false
  if (mode === 'full') return true
  /*
   * 'edit' is deliberately not in the hints list. It does not describe a fix,
   * it writes one — a diff the room can accept with one press — and a mode
   * whose whole point is that the student reaches the answer themselves cannot
   * also hand them the answer as a patch.
   */
  return action === 'hint' || action === 'ask'
}

export interface AiAskRequest {
  /** Free-form prompt. Optional when `action` carries the whole intent. */
  message: string
  action?: AiAction
  /**
   * The cell the turn is ATTACHED to: the one the proposed edit will land in.
   *
   * One, and that is not a leftover: a proposal rewrites one text, it has one
   * base and one decision for everyone. A turn about several cells names them
   * in `cellIds`, and still proposes edits to just one.
   */
  cellId?: string | null
  /**
   * The cells one asks to focus on — the asker's selection.
   *
   * The oracle sees the notebooks whole even without them; this is not "what
   * to show it" but "what to look at first". Empty means it looks at
   * everything at once, and that is the ordinary case.
   */
  cellIds?: string[]
  /**
   * Ask or do.
   *
   * `agent` is not "the same question, but in more detail": the oracle reads
   * the folder, edits files and runs scripts by itself. A separate room rule,
   * a separate step feed and a separate undo button — see `RoomRules.agent`.
   */
  mode?: 'ask' | 'agent'
  /**
   * How long to think before answering — for THIS question.
   *
   * Empty means the instance default (`OracleSettings.reasoningEffort`), and
   * then not a single new field goes to the provider. Any participant may
   * lower the level, only the teacher may raise it above the instance's:
   * waiting and paying for "detailed" is decided by whoever runs the class.
   */
  effort?: ReasoningEffort
}

/**
 * Asking is fire-and-forget: the server appends the question to the shared
 * document and streams the answer into it, so every browser in the room sees
 * the same thread arrive without a per-client response stream.
 */
export interface AiAskResponse {
  entryId: string
}

/** Snapshot the server assembles for the model. Exported for tests/debugging. */
export interface AiContext {
  sessionName: string
  cells: CellSnapshot[]
  selectedCellId: string | null
  files: string[]
}

/* ---------------------------------------------------------------- misc */

export const PARTICIPANT_COLORS = [
  '#f97362', // coral
  '#f2a33c', // amber
  '#8ac44a', // lime
  '#3ec9a7', // teal
  '#4aa8f0', // sky
  // Nudged from #7c7cf0, which left initials at 4.48:1 — a hair under AA, and
  // the one colour in the palette where they were not readable. Six units of
  // RGB buys 4.74 and keeps it plainly indigo, and plainly not the sky or the
  // purple either side of it.
  '#7e82f0', // indigo
  '#c273e6', // violet
  '#ef6ba8', // pink
] as const

export function colorForId(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return PARTICIPANT_COLORS[hash % PARTICIPANT_COLORS.length]
}

/** Shape stored in Yjs Awareness under the `user` field. */
export interface AwarenessUser {
  id: string
  name: string
  avatar: string | null
  color: string
  role: ParticipantRole
  /** Cell the person is currently focused on, for the "editing here" badge. */
  activeCellId?: string | null
  /** True while they are typing into the oracle composer. */
  composing?: boolean
  /** True while their cursor is in the terminal. */
  inTerminal?: boolean
  /**
   * Which file the person is editing right now — a path, or null if it is the
   * notebook.
   *
   * In presence, like `viewing`, and for the same reason: the place of work is
   * ephemeral, it means nothing after the tab leaves and must not get into
   * version history or under Ctrl+Z. The files panel draws "who is here" dots
   * from it, and the editor the line "Ada is editing here".
   *
   * Cursors inside the file itself are not included here: they live in the
   * presence of THE document that is open, and never reach the room at all.
   */
  editing?: string | null
  /**
   * Which document the person is looking at and where they are in it.
   *
   * In presence, not in the shared document, and that is a choice, not a
   * convenience. A place in a PDF is exactly as ephemeral as a cursor in a
   * cell: it means nothing after the person has left, there is no reason to
   * bring it back with Ctrl+Z and no reason to record it in version history —
   * otherwise the timeline would fill up with rows "the teacher scrolled".
   * Presence is already broadcast to the whole room and already repaired by
   * the server (see `pinRole`, `ownAwareness`), so no new write paths appear.
   *
   * The price is honest: on a page reload the place is lost, and if the
   * teacher left there is nobody to follow. Both are right in substance.
   */
  viewing?: {
    file: string
    page: number
    /**
     * The place on the page as a fraction of its height, not in pixels.
     *
     * The viewer has their own column width and their own zoom: the teacher's
     * pixel falls on a different line. A fraction carries over.
     */
    y: number
  } | null
}

/** Per-viewer preference, never shared with the room. */
export type ThemeName = 'light' | 'dark'

/* ----------------------------------------------- "no such room" in words */

/**
 * What the server answers about a nonexistent seminar.
 *
 * One string for the whole product, because something irreversible is decided
 * by it: a 404 from OUR API means "the room is gone" — the local copy of the
 * notebook may be erased — while a 404 from anything in front of it (a relay
 * without a connected frpc, static hosting with index.html-for-everything, a
 * wrong upstream) only means that the backend cannot be heard right now. A
 * bare status code does not tell these two cases apart, and while the client
 * judged by it, a tunnel dropping erased the offline typing of the whole
 * class and declared a live seminar deleted.
 *
 * Both the server (the response body) and the client (the check) take it from
 * here — so that there is one copy and they do not silently drift apart.
 */
export const SESSION_MISSING = 'session not found'

/**
 * This is our 404 — the one where the server said plainly that it has no such
 * room.
 *
 * Structurally, not by error class: `ApiError` lives in the browser, while the
 * rule is shared. All it requires is the 404 code and our own words in the
 * body; an answer without a body arrives with a phrase like "Not found (404)"
 * and does not fit the rule, that is, it counts as a lost connection, not a
 * verdict on the room.
 */
export function saysSessionMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { status, message } = error as { status?: unknown; message?: unknown }
  return status === 404 && message === SESSION_MISSING
}

/* ------------------------------------------- "but am I let in?" in words */

/**
 * What the room answers about a presented key: whether it is valid and whether
 * entry is closed.
 *
 * Introduced for one place — a tab refused at the handshake. The socket closes
 * BEFORE the upgrade and without words (the browser sees 1006), and the client
 * is left guessing: there is no room, the key has expired, or the teacher has
 * closed access. While it guessed by an unauthorized `GET /api/sessions/:id`,
 * a banned person after a reload read "the place has expired", lost their
 * identity in the room and the next day came in as a new participant — with
 * their attempts and authorship unlinked.
 *
 * Three different answers for three different cases, and not a single
 * "probably":
 *   • `ban` — entry is closed by a person, until this moment;
 *   • `tokenValid: false` — this room no longer recognizes the key;
 *   • everything else (a 404 in our words, a network failure, a 500) is not an
 *     answer at all, and should be treated like a lost connection.
 *
 * It answers WITHOUT a key too: `tokenValid: false` without a ban means "show
 * your key", not "you have been removed".
 */
export interface SessionMe {
  /** The room recognizes the key presented in the header right now. */
  tokenValid: boolean
  /** Entry is closed by the teacher until this moment, or null. */
  ban: { until: number } | null
  /** Who the room considers the key's bearer to be, or null. */
  participantId: string | null
  /** The role the server will act with on this key, or null. */
  role: ParticipantRole | null
}
