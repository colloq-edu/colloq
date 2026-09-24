/**
 * The rules of one room.
 *
 * A seminar is not always the same shape. A lecture wants a notebook the class
 * can read and nobody can rearrange; a lab wants everyone typing at once; an
 * exam wants the oracle switched off and the notebook read-only. Three presets
 * say those shapes in one word — `OPEN_ROOM`, `LECTURE_ROOM`, `COUNCIL_ROOM` —
 * and the room stays adjustable one row at a time after a preset is applied,
 * because a preset is a set of values here and not a mode kept somewhere else.
 *
 * Two things this file is careful about.
 *
 * **A rule is a promise, so it has to be kept by the server.** The client uses
 * these to decide what to grey out, but greying out is decoration: the document
 * is a CRDT and the control channel is a socket, and anything not checked on
 * the server is a request away from being ignored. Every rule here says, in its
 * own comment, where it is enforced — and the ones that are not enforced yet
 * say so, because a rule the product cannot keep must not be presented as one.
 *
 * **Defaults are what the product is today.** Every field defaults to the
 * permissive value, so a seminar created before rules existed, or by somebody
 * who never opened the settings, behaves exactly as it always has.
 */

/*
 * The only import of this file is the ruler of oracle ceilings, and it is the
 * same one the instance settings use: two numbers the room tightens must be
 * measured by the same yardstick the instance measures them by, otherwise a
 * room could ask for something the instance cannot do. There is no reverse
 * arrow: shared/admin.ts takes only a type from here.
 */
import { LIMITS } from './admin.js'

/** Who a rule lets act. `room` is everyone in it, `host` is whoever is teaching. */
export type Who = 'room' | 'host'

/**
 * Who runs, and how much at once.
 *
 * `single` is the lab where everyone computes but the kernel is one: each
 * person keeps no more than one of their own cells in the queue, and Run All
 * and Run Above stay with the teacher. Without this middle ground the choice
 * was between "twenty people fill the queue with forty cells" and "nobody
 * but me".
 *
 * Not only cells are run: the same rule covers a script from the tree
 * (`file:run`) and a command in the shared shell (`term:run`), both measured
 * as one cell, so `host` closes them and `single` lets them through. Why the
 * terminal has no rule of its own is explained at the RoomRules.run field
 * below.
 */
export type RunWho = 'room' | 'single' | 'host'

/**
 * Who changes the notebook's structure.
 *
 * `add` is a prepared worksheet: you may add your own, but only the teacher
 * may remove and rearrange. Exactly that, and not "you can't touch other
 * people's": the rule does not know the author, and a participant cannot
 * remove even the cell they have just created themselves. The words are the
 * same as in the panel (web/src/lib/rule-rows.ts) and in the refusal. This is
 * the most common kind of seminar, and until now it had no value of its own:
 * one had to choose between "everyone edits" and "the structure is mine".
 */
export type StructureWho = 'room' | 'add' | 'host'

/* --------------------------------------------------- access to ONE notebook */

/**
 * Who works in a SEPARATE notebook of the room.
 *
 * A room has several notebooks (shared/notebook.ts · Book), and until now
 * the rules were the same for all of them. That broke on the most common
 * gesture of a class: a student makes themselves a copy of the walkthrough
 * to try their own thing, but the room is a lecture, and they cannot type
 * even in their own notebook. The reverse is just as wrong: opening
 * `edit: 'room'` for one person also opens the notebook the lecture is
 * running in.
 *
 *   room  — as in the room. The default for notebooks created by the
 *           teacher, including the first one, and exactly today's
 *           behaviour: the room's rules as they were.
 *   owner — personal: the author and the teacher type, change the structure
 *           and run in it, the others watch. A student's own notebook gets
 *           this as soon as it is created (`ownBooks` below).
 *   all   — open to everyone: anyone types, changes the structure and runs,
 *           whatever the room's rules say.
 *   host  — the teacher only, under any room rules.
 *
 * EXACTLY three rules are overridden, `run`, `edit` and `structure`, plus
 * everything derived from them (formatting, "accept" for the oracle,
 * clearing the output of one's own cell, moving cells, Run All and Run Above
 * in this notebook). The other rules are shared by the room and are not
 * touched by a notebook: the kernel, terminal, board, files, history and
 * oracle are one per room, and there is nothing to say about them "in this
 * notebook".
 */
export type BookAccess = 'room' | 'owner' | 'all' | 'host'

/**
 * What the room remembers about one notebook.
 *
 * The map key is the notebook's ROOT in the document, not its path: a path
 * is an address, it gets renamed and freed, while a root is issued once and
 * lives with the notebook (shared/notebook.ts · rootForNewBook). That is why
 * "Akim's personal notebook" survives a file rename and does not pass to a
 * new file with the same name.
 *
 * `owner` is the participantId of whoever created the notebook, if it was
 * not the teacher; `ownerName` is their name AT THAT MOMENT. The name is kept
 * alongside instead of being looked up in the participant list: a notebook
 * outlives a semester, the participant may have been removed from the
 * database, and then "personal notebook: —" explains nothing.
 *
 * The record lives even with `access: 'room'`, and that is not garbage but
 * the very reason it is written right away: a teacher who decides to make
 * the notebook personal must have the author's name in the menu rather than
 * find it out after the fact.
 */
export interface BookRule {
  access: BookAccess
  /** Author's participantId; `null` if the teacher created it or the author is unknown. */
  owner: string | null
  /** The author's name at the time the notebook was created. */
  ownerName: string | null
}

/**
 * How many notebooks a room remembers, and how many characters of the
 * author's name it keeps.
 *
 * The ceiling here is the last safety net, not the working limit: rules
 * travel to every socket of the room in a `rules` frame and sit as a string
 * in the database, and a map grown by a bug or by hand in the database must
 * not cost the room a megabyte on every entry. The real limit is held by
 * `MAX_OWN_BOOKS` below: per person, with a clear refusal, not silently.
 *
 * Five hundred, not two hundred: two hundred would be hit in a cohort where
 * a hundred and fifty people each created a couple of notebooks, and it is
 * hit SILENTLY and in the bad direction, because an extra record simply
 * vanishes on read, and someone's personal notebook vanishes with it.
 * Eighty characters is the measure of a participant's name.
 *
 * The excess is not refused but dropped on read: rules are read totally
 * (see `readRules`), and nothing may fail on them.
 */
export const MAX_BOOK_RULES = 500
export const MAX_BOOK_OWNER_NAME = 80

/**
 * How many notebooks OF THEIR OWN a student creates in one room.
 *
 * Three is "the current one, the previous one and a draft", that is,
 * everything one's own notebook is needed for in a class. A ceiling is
 * needed because a notebook is expensive and permanent: the root stays in
 * the room document even when the file is removed (see the header of the
 * "notebooks" section in shared/notebook.ts), and twenty people with forty
 * notebooks each make a snapshot that does not shrink until the end of the
 * semester.
 *
 * Only live ones count: delete yours, create a new one.
 */
export const MAX_OWN_BOOKS = 3
/** A notebook root is `cells` or `nb:<id>`; it is never longer than 128 characters. */
const MAX_BOOK_ROOT = 128
const MAX_BOOK_OWNER_ID = 128

/**
 * Phrases with which the NOTEBOOK ITSELF refuses, not the room.
 *
 * Keys rather than strings, for the same reason as `CLASS_IS_OVER`: this
 * file does not know about i18n and must not; it is called both by the gate
 * on every frame and by the browser. Whoever talks to the person combines
 * them with the author's name.
 */
export const BOOK_IS_PERSONAL = 'server.bookIsPersonal'
export const BOOK_IS_THE_TEACHERS = 'server.bookIsTheTeachers'

export interface RoomRules {
  /**
   * Who may run cells.
   *
   * Enforced in server/src/control.ts — mayRun() guards run, runAll and
   * runAbove. The kernel is one process shared by everyone, so this is also the
   * only protection a lecture has against twenty people queueing the same cell.
   *
   * And not only cells: the same rule covers `file:run` (running a script
   * from the tree) and `term:run` (a command in the shared shell). Otherwise
   * "the teacher may run" would be not a boundary but a hint: the same
   * container, the same folder, just a different door. The terminal has no
   * rule of its own on purpose: the drawer is opened not by a right to it
   * but by the right to run.
   *
   * One combination worth remembering, and it is printed in the panel:
   * `run: 'host'` without `edit: 'host'` is not a boundary. The kernel reads
   * a cell's source at the moment the queue reaches it, not when Run was
   * pressed, so a student who may not run still writes the Python that the
   * teacher's Run will execute, in the same container.
   */
  run: RunWho

  /**
   * Who may change what the cells say — their text, and whether a cell is code
   * or a note.
   *
   * Enforced in server/src/collab/gate.ts, called from collab/index.ts before
   * the update is applied. The promise here is the same as for `run`: "this
   * did not happen", not "it happened and we undid it". Undoing is not
   * possible in a CRDT: rolling back a deletion does not resurrect the cell
   * but creates a new one, and everyone who has the old one open types into
   * a tombstone, with no error and not a single event.
   *
   * This also covers two buttons that rewrite cells wearing another face:
   * formatting and "accept" on an oracle suggestion.
   */
  edit: Who

  /**
   * Who may add, delete and reorder cells.
   *
   * Enforced in server/src/collab/gate.ts for add and delete, and in
   * control.ts for the move — moving went to the server because it recreates
   * the cell together with its output, and the client is not allowed to
   * write output.
   *
   * Separate from `edit`, because in a seminar these are different things: a
   * class that fills in a prepared worksheet but does not reshape it is the
   * most common case, and it now has its own value, `add`.
   */
  structure: StructureWho

  /**
   * Who may put a document on the room's shared screen.
   *
   * Enforced in server/src/control.ts — `board:open` and `board:close`.
   *
   * Anyone may always view and page through it themselves: the room's file
   * can be downloaded by anyone in it anyway. The rule is about something
   * else, the shared screen, and that is why it stands next to `wipe` and
   * `restart` rather than `files`.
   *
   * The default is `host`, but it is not nailed down: a seminar where
   * students take turns showing their materials is not an invention, and a
   * nail would close it off forever.
   */
  board: Who

  /**
   * Who may put files into the room's folder.
   *
   * Enforced in server/src/routes/files.ts. Taking a file out is already the
   * teacher's right, and it was before.
   *
   * It is exactly as strong as `run` allows: the kernel container mounts the
   * same folder, so `os.listdir()` is a listing, `open(...)` is a download,
   * and `os.remove(...)` is a deletion. This is about order in the folder,
   * not about secrecy, and the panel says exactly that.
   */
  files: Who

  /**
   * Who erases shared work: all outputs in the notebook, the terminal feed,
   * the oracle thread.
   *
   * Enforced in server/src/control.ts (clearOutputs, term:clear) and
   * routes/ai.ts (DELETE /ai/thread).
   *
   * Three erasures that until now had three different answers. Two of them
   * were already the teacher's right, and the third, `clearOutputs` without a
   * cell name, had no check at all: any participant wiped the results the
   * class had just computed, and nothing could bring them back except the
   * teacher restoring a version: output is written by the kernel, and a
   * client undo does not reach it. The default `host` is a fix, not a new
   * restriction.
   */
  wipe: Who

  /**
   * Who restarts the kernel, losing all of the room's variables.
   *
   * Enforced in server/src/control.ts. Today this is hard-coded with no way
   * to say otherwise; writing the hard-coded value down so that it can be
   * LOOSENED is what an open lab asks for when the teacher has already left
   * and the kernel has hung.
   */
  restart: Who

  /**
   * Who reads the room's history.
   *
   * Enforced in server/src/routes/history.ts. History is essentially a
   * keystroke recording: a solution pasted into a cell and erased before the
   * class can always be read in it later. Restoring a version and marking a
   * checkpoint stay with the teacher under any value.
   */
  history: Who

  /**
   * Whether the room's oracle answers at all, and how much it gives away.
   *
   * `inherit` means the instance decides, which is what every seminar does
   * today. The other three override it for this room only — one class is an
   * exercise and the next is a demonstration, and they should not have to share
   * a setting.
   *
   * Enforced in server/src/routes/ai.ts — oracleModeFor(). A room may tighten
   * and may not loosen: an instance that is off cannot be talked back on here,
   * because that decision belongs to whoever pays for the model.
   */
  oracle: 'inherit' | 'off' | 'hints' | 'full'

  /**
   * Who may let the oracle write into the seminar's files: "do" rather than
   * "ask".
   *
   * Enforced in server/src/routes/ai.ts.
   *
   * Separate from `oracle`, because this is a different question. `oracle`
   * is how much to hint; `agent` is whether it may take the room's folder
   * into its hands. The "do" mode edits files by itself, without pressing
   * "accept" on every edit: otherwise it cannot look at its own mistake and
   * fix it, and without that it is not an agent but the same answer in
   * different wrapping. The price is that edits are visible to everyone at
   * once; in exchange the whole turn is undone with one button.
   *
   * The default is `host`, not `room`, and it is the only new restriction: in
   * a lab of twenty people, twenty simultaneous "do"s in one folder are not
   * help but overwriting each other. A room where this fits is switched on
   * with one toggle.
   *
   * This rule neither opens nor closes the notebook: it is edited with the
   * rights of WHOEVER ASKED for the turn, with the same `edit` and
   * `structure`, with the same lock on the cell (`mayEditCell`), as if they
   * were typing themselves. The oracle here is the person's hands, not a
   * separate party: the edit goes into the room document in their name, and
   * the version in history has an author. A participant in a lecture does not
   * touch cells, even when `agent` lets them into "do" mode.
   *
   * The price is named separately, because without it this must not be
   * given: before the first cell edit the turn marks the version history
   * ("before the oracle's edit"), and one button returns the notebook to how
   * it was. The cell's output is not erased by this: it honestly goes stale,
   * exactly as after an edit by hand.
   *
   * Enforced in server/src/ai/agent.ts.
   */
  agent: 'off' | 'host' | 'room'
  /** Per-request tool actions: null inherits the server; 0 means unlimited. */
  agentSteps: number | null

  /**
   * How many questions per hour per person, or null, "as on the instance".
   *
   * The instance sets the default; a room goes below it and never above:
   * `oracleLimitsIn` takes the smaller of the two. Tightening, on the other
   * hand, is needed often and for a single class (a test where the oracle
   * gives one question per person), and going into the whole instance's
   * settings for it means changing them for all the other rooms as well.
   *
   * Enforced in server/src/routes/ai.ts. The ceiling for the whole room is
   * computed from the same number, so a room that lowered the personal limit
   * lowers that one too.
   */
  questionsPerHour: number | null

  /**
   * The interval between one person's questions, in seconds, or null.
   *
   * Stricter here means LARGER, so `oracleLimitsIn` takes the larger of the
   * two: the hourly ceiling catches spending, the interval catches rapid-fire
   * questions, and a seminar that needs the second one usually knows it a
   * minute before the start.
   *
   * Enforced in server/src/routes/ai.ts, and there, as on the instance, it
   * does not apply to the teacher: their questions come in a row because the
   * walkthrough goes in a row.
   */
  slowModeSeconds: number | null

  /**
   * A model for this room only, or null to use the instance's.
   *
   * NOT ENFORCED YET, and not drawn either: `routes/ai.ts` never reads it and
   * `web/src/lib/rule-rows.ts` has no row for it, so today the field only
   * survives a round trip through the database. It is kept rather than deleted
   * because a seminar that will ask two hundred questions and one that will ask
   * five do not want the same model, and the teacher knows which is which
   * before the class starts.
   *
   * It is measured by the same `LIMITS.model` as the instance's model. There
   * used to be a number of its own here: the name was cut to 80 characters
   * against 120 on the instance, and a room where this gets switched on one
   * day would have received a silently truncated model name, that is, a
   * request into nowhere with a provider error instead of an answer.
   */
  model: string | null
  /**
   * What "opening a cell" means in this room.
   *
   * `shared`, as always: a click on the lock opens the shared text, and the
   * whole room types into it. `council`: the click opens a council, where
   * everyone has their own sheet, and the teacher pages through the attempts
   * and shows them to the class. This is the whole difference between a
   * lecture and a council as modes at creation; the lock menu on the cell
   * itself still lets you pick any of the three positions.
   *
   * Read by the server in control.ts (`cell:open`); it is not a right: in
   * either case it is the teacher who opens the cell.
   */
  opens: 'shared' | 'council'

  /**
   * Overrides for individual notebooks: root → rule (see `BookRule`).
   *
   * The field may be missing altogether, and every room created before this
   * line lacks it: an empty map and a missing one are the same thing, "all
   * notebooks as in the room". `readRules` does not store an empty map, so
   * that the rules do not swell with records that mean nothing.
   *
   * Enforced in server/src/collab/gate.ts (typing and notebook structure) and
   * server/src/control.ts (run, move, format, clearing output, "accept" for
   * the oracle), through one shared `rulesForBook` below, the same one the
   * browser uses to compute grey buttons. There is no second copy of this
   * rule in the product on purpose: diverged copies here have already cost
   * one bug.
   *
   * Only the teacher changes it, the same way as all the other rules
   * (PATCH /api/sessions/:id/rules, routes/sessions.ts), where the role is
   * checked.
   */
  books?: Record<string, BookRule>

  /**
   * Whether a student may create THEIR OWN notebook in this room.
   *
   * Not about access to an existing notebook (that is `books` above) but
   * about the right to add one more to the room: create an empty one, bring
   * in an .ipynb placed in the folder, ask the oracle for the same. A
   * student's own notebook is always PERSONAL (the author and the teacher
   * edit and run in it, the others watch), so this right is exactly "may
   * work separately from the audience".
   *
   * The default is `off`, and this is a matter of principle: rights in the
   * room are handed out by the teacher. Otherwise, in a lecture where the
   * teacher types and runs, any participant would grant themselves the right
   * to type and run with one "new notebook" button, and the teacher would
   * find out after the fact.
   *
   * SEPARATE from `files`, and this is not duplication: `files` is about the
   * class's shared folder, where handouts and solutions go, and it says
   * nothing about a participant who needs a notebook of their own. So
   * `files: 'host'` with `ownBooks: 'on'` is a working pair (the notebook
   * file is written by the server, it is the notebook's projection), and so
   * is the reverse pair: an .ipynb may be put into the folder, but not
   * brought into the room as a notebook.
   *
   * Enforced in server/src/collab/books.ts, one door for all the ways of
   * creating a notebook, including the oracle.
   */
  ownBooks: 'off' | 'on'
  /**
   * How much memory and CPU ALL of the class's personal notebooks get
   * together.
   *
   * `null` means "as for the class": today's behaviour and the default. The
   * numbers apply to the container where personal notebooks live (pool.ts ·
   * KernelRole), not to one notebook: it holds dozens of kernels, and they
   * share its memory and CPU the way cells of one notebook share them.
   *
   * Why separate numbers, if by default they are the same. The teacher sets
   * the "Memory" field in the class settings for THEIR OWN work, for the
   * dataset they load at the lecture. They did not sign up to hand out as
   * much to thirty drafts, and on the machine that is exactly twice the
   * memory. And the other way round: in a cohort where all the work happens
   * in personal notebooks, they need more than the lecture. One number for
   * both serves only the case where the two happen to coincide.
   *
   * They are checked here by a general measure (whole, within reasonable
   * bounds), and against the bounds of the MACHINE in the same place where
   * the class's own memory is checked (routes/sessions.ts,
   * routes/admin-instance.ts): this file is about rights and does not know
   * how much memory Docker has.
   *
   * `rulesAfterClass` leaves them alone: the end of a class is about who may
   * do what, not about how much hardware has been given.
   */
  ownMemoryMb: number | null
  ownCpus: number | null

  /**
   * After how many seconds a notebook cell stops by itself; `null` means
   * never.
   *
   * The default is `null`, and this is a matter of principle: no room already
   * running has a limit, and a rollout has no right to cut off a walkthrough
   * that is in its fourth minute. The teacher turns it on, knowing the price.
   *
   * It was introduced against one problem, and a measured one. A notebook has
   * ONE shared queue: it holds both cells and council attempts
   * (server/src/kernel/index.ts · Runtime.queue). The council limit
   * (notebook.ts · CouncilSettings.runLimitSec) guards only attempts, and one
   * `while True` in an ORDINARY cell held the whole attempt queue until the
   * end of the class, even though the teacher had set "everyone in turn" and
   * a run limit. Hence the rule's place: not in the council but in the room,
   * because cells are run even where there is no council at all.
   *
   * Not a right but a ceiling, like `runQueueCap`: it forbids pressing
   * nothing and divides nobody into roles. A teacher's cell is stopped by it
   * just like a student's: the kernel is one, and heavy code does not get
   * lighter depending on who pressed (the same argument as for the attempt
   * limit).
   *
   * Enforced in server/src/kernel/index.ts: the shared alarm `armLimit`, one
   * per cell and per attempt. The stop is explained in the cell's output in
   * one line, without a `KeyboardInterrupt` traceback: that one is read as
   * "someone pressed stop" or as one's own error.
   *
   * `rulesAfterClass` leaves it alone: the end of a class is about rights,
   * not about how long the kernel is given to compute.
   */
  cellLimitSec: number | null

  /**
   * Whether commands that kill the kernel or wipe everything are executed in
   * cells.
   *
   * The default is `block`, and it applies both to new classes and to all
   * existing ones: a field missing from the record reads as a ban. This is
   * the only rule whose default tightens rooms that are already running, and
   * the price is named: on 20 Sep 2026 a class of thirty people lost its
   * kernel nine times in eleven minutes to two lines in a council attempt:
   * `import os` and `os._exit(0)`. Such a death cannot be told apart from
   * normal operation by anything: the process vanishes with no exception, no
   * signal in dmesg and no line in the log, and the class loses its
   * variables and its queue.
   *
   * What is closed: `exit()`, `quit()`, `os._exit`, `os.abort`, a deadly
   * signal TO THE KERNEL ITSELF (`os.kill`, `os.killpg`,
   * `signal.raise_signal`, `signal.pthread_kill`), `kernel.do_shutdown`,
   * `%reset`, `%reset -f`, `%reset_selective`, `%xdel`, and among shell
   * commands (`!cmd`, `%%bash`, `os.system`, `subprocess`),
   * `kill`/`pkill`/`killall` aimed at the kernel or at "everything",
   * `shutdown`, `reboot`, `halt`, `poweroff`, `init 0/6` and `rm -rf` of the
   * whole class root. `sys.exit()` is NOT touched: in ipykernel it is
   * `SystemExit`, and the kernel survives it.
   *
   * Not a right but a property of the room, like `cellLimitSec`: roles are
   * not distinguished here at all. The kernel is one per notebook, and
   * `os._exit(0)` from the teacher's cell costs the class exactly as much as
   * from a student's; the teacher has a way to restart the kernel, and that
   * button goes around the kernel.
   *
   * THIS IS A SPEED BUMP, NOT A SANDBOX, and nothing more may be promised
   * here: `ctypes`, reloading the `os` module through importlib, a fork bomb,
   * a segfault in a native library and `globals().clear()` get past it. The
   * room's terminal is a real shell, and whoever the `run` rule gives
   * `term:run` will bring the kernel down from there with one command.
   *
   * It is switched off for one case, and the case is real: a course on
   * Python itself, where these commands are the very subject.
   *
   * Enforced in server/src/kernel/danger.ts, by substitutions inside the
   * kernel process that server/src/kernel/index.ts installs on every kernel
   * start and restart, before the first user line. Inside a council attempt
   * the ban ALWAYS applies, whatever is set here: a student's attempt runs on
   * the shared kernel and cannot bring the class down with it even when
   * dangerous commands are allowed for a demonstration (council-isolation.ts
   * · hold/release).
   *
   * `rulesAfterClass` leaves it alone: the end of a class is about rights,
   * and the protection stays what it was.
   */
  danger: 'block' | 'allow'
}

/**
 * The ceiling of the cell limit: an hour, like the council attempt limit
 * (notebook.ts · COUNCIL_RUN_LIMIT_MAX).
 *
 * A number of its own rather than an import from there: this file is about
 * rights and does not know about the notebook. The floor is a second: zero
 * would mean "stop at once", and "never" is already written as `null`.
 */
export const MAX_CELL_LIMIT_SEC = 3600

/**
 * The bounds within which the rules accept the personal notebook numbers.
 *
 * The ceiling here is the last safety net, not the working limit: the real
 * one is set by the machine, and the route sets it (see the field above).
 * The point of these two numbers is that rules arriving from the database
 * or from someone else's frame bring neither `-1`, nor `1e9`, nor `0.5`.
 */
export const MIN_OWN_MEMORY_MB = 256
export const MAX_OWN_MEMORY_MB = 262144
export const MAX_OWN_CPUS = 64

/**
 * What a room is when nobody has said otherwise: exactly what Colloq has always
 * been. Every existing seminar reads as this, and so does every new one whose
 * teacher never opens the settings.
 */
export const OPEN_ROOM: RoomRules = {
  run: 'room',
  edit: 'room',
  structure: 'room',
  files: 'room',
  /*
   * Three new fields, and two of them are strict by default, because they
   * record what was already true: `term:clear` and clearing the oracle thread
   * were already the teacher's right, and the kernel restart is hard-coded
   * with no way to say otherwise. The only real change is `clearOutputs`,
   * which had no check at all; see the comment at `wipe`.
   */
  wipe: 'host',
  restart: 'host',
  board: 'host',
  agent: 'host',
  agentSteps: null,
  history: 'room',
  oracle: 'inherit',
  opens: 'shared',
  /*
   * Students' own notebooks are off: the teacher hands out rights, see the
   * field. `books` is absent here rather than an empty map: an empty map is
   * an object, `isOpenRoom` compares values, and two empty objects are never
   * equal.
   */
  ownBooks: 'off',
  // "As for the class", and this is today's behaviour too: one limit for both
  // containers until the teacher decides otherwise.
  ownMemoryMb: null,
  ownCpus: null,
  // A cell computes for as long as it computes: today's behaviour of every
  // room, and a rollout must not change it (see the field).
  cellLimitSec: null,
  /*
   * Dangerous commands, on the other hand, are closed by the rollout, and
   * this is the only default that tightens rooms already running. The
   * argument is in the field: one line written out of curiosity killed the
   * kernel for the whole class, and the cost of a mistake in the other
   * direction (the teacher of a Python course goes and switches one line) is
   * incomparably smaller.
   */
  danger: 'block',
  /*
   * Oracle ceilings are "as on the instance", and that is exactly today's
   * behaviour of every room: until now there was nowhere to take them from
   * except the instance settings.
   */
  questionsPerHour: null,
  slowModeSeconds: null,
  model: null,
}

/**
 * Lecture: the notebook belongs entirely to the teacher, except what they
 * open themselves.
 *
 * A preset, not a new rule: everything it is built from already exists in
 * the fields above, and the room stays adjustable after it is applied. The
 * point is that a "lecture" is nine coordinated values, and a teacher about
 * to start a class will not set them one by one without forgetting any.
 *
 * `history`, `oracle`, the oracle ceilings and `model` are taken from the
 * open room: a lecture is about who types and runs, not about who gets to
 * watch and ask.
 *
 * A lecture alone, without the cell lock, would be just a notebook on a
 * screen. It works as a pair: the teacher opens individual cells, and in
 * them the room types and runs under these very rules; see `mayEditCell`
 * below.
 *
 * All the fields are listed, every single one, without `...OPEN_ROOM`, for
 * the same reason as in `rulesAfterClass`: a rule added tomorrow must break
 * the type check here and demand a decision, not slip through silently.
 */
export const LECTURE_ROOM: RoomRules = {
  run: 'host',
  edit: 'host',
  structure: 'host',
  board: 'host',
  files: 'host',
  wipe: 'host',
  restart: 'host',
  agent: 'host',
  agentSteps: OPEN_ROOM.agentSteps,
  history: OPEN_ROOM.history,
  oracle: OPEN_ROOM.oracle,
  questionsPerHour: OPEN_ROOM.questionsPerHour,
  slowModeSeconds: OPEN_ROOM.slowModeSeconds,
  model: OPEN_ROOM.model,
  opens: 'shared',
  /*
   * The preset neither creates nor removes per-notebook overrides: they are
   * about particular notebooks of a particular room, while the preset is
   * about who types and runs in general. A lecture does not forbid own
   * notebooks separately: they are already off in an open room, and the
   * teacher turns them on when needed.
   */
  ownBooks: OPEN_ROOM.ownBooks,
  // How much hardware is given is not about the class format: the preset leaves it alone.
  ownMemoryMb: OPEN_ROOM.ownMemoryMb,
  ownCpus: OPEN_ROOM.ownCpus,
  // Nor how long the kernel is given to compute: a lecture is about who runs,
  // not about when a run is cut off.
  cellLimitSec: OPEN_ROOM.cellLimitSec,
  // The preset leaves dangerous commands alone: they concern the kernel shared
  // by all, not who types. A lecture is protected just like an open room.
  danger: OPEN_ROOM.danger,
}

/**
 * Council: the third door into the room, and at creation it stands next to
 * the first two as a card of its own.
 *
 * In terms of rights it is the same lecture: the teacher types, runs and
 * opens cells. The difference is exactly one: what "opening a cell" means.
 * In a lecture an open cell is shared text that the whole room types into;
 * in a council everyone has their own sheet, and the teacher pages through
 * the attempts and shows them to the class (see `opens`). A preset rather
 * than a separate room state: a mode is a set of rules at once, and a
 * second source of truth about what is allowed is deliberately not created
 * here (routes/admin-instance.ts explains why).
 */
export const COUNCIL_ROOM: RoomRules = {
  ...LECTURE_ROOM,
  opens: 'council',
}

const OPENS = new Set<RoomRules['opens']>(['shared', 'council'])
const WHO = new Set<Who>(['room', 'host'])
const RUN = new Set<RunWho>(['room', 'single', 'host'])
const STRUCTURE = new Set<StructureWho>(['room', 'add', 'host'])
const AGENT = new Set<RoomRules['agent']>(['off', 'host', 'room'])
const ORACLE = new Set<RoomRules['oracle']>(['inherit', 'off', 'hints', 'full'])
const BOOK_ACCESS = new Set<BookAccess>(['room', 'owner', 'all', 'host'])
const OWN_BOOKS = new Set<RoomRules['ownBooks']>(['off', 'on'])

/**
 * The per-notebook override map, from anything.
 *
 * Total, like everything else in `readRules`, and for the same reason: what
 * arrives here is both a database row written by a previous build and a
 * PATCH body from the browser. A record that could not be read is DROPPED
 * rather than failing the read: otherwise one crooked row would lock the
 * whole room.
 *
 * The ceilings are here and not at the entrance, because there is more than
 * one entrance: rules are written both by the teacher from the console and by
 * the server recording the author of a new notebook. Trimming in one place
 * is the only way to promise that the database holds what we can read back.
 *
 * `undefined` instead of an empty map, so that rules without a single
 * override read exactly like the rules of a room created before this line.
 */
function readBookRules(raw: unknown): Record<string, BookRule> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, BookRule> = {}
  let kept = 0
  for (const [root, value] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= MAX_BOOK_RULES) break
    if (!root || root.length > MAX_BOOK_ROOT) continue
    if (!value || typeof value !== 'object') continue
    const from = value as Partial<BookRule>
    if (!BOOK_ACCESS.has(from.access as BookAccess)) continue
    const owner =
      typeof from.owner === 'string' && from.owner ? from.owner.slice(0, MAX_BOOK_OWNER_ID) : null
    const ownerName =
      typeof from.ownerName === 'string' && from.ownerName.trim()
        ? from.ownerName.trim().slice(0, MAX_BOOK_OWNER_NAME)
        : null
    /*
     * "As in the room" without an author means nothing, so such a record is
     * not kept.
     *
     * This way the map cleans itself of whatever the teacher reset to the
     * default: a removed override of a notebook they created themselves
     * disappears instead of staying as a row nobody will later remove.
     */
    if (from.access === 'room' && owner === null) continue
    out[root] = { access: from.access as BookAccess, owner, ownerName }
    kept += 1
  }
  return kept > 0 ? out : undefined
}

/**
 * Read rules off whatever was stored, filling in anything absent.
 *
 * Deliberately total: a row written by an older build, a hand-edited database,
 * a field added after this seminar was created. None of those should be able to
 * open a room with no rules at all, so every unreadable field falls back to the
 * permissive default rather than to an error.
 */
export function readRules(raw: unknown): RoomRules {
  const source = (typeof raw === 'string' ? safeParse(raw) : raw) as Partial<RoomRules> | null
  if (!source || typeof source !== 'object') return { ...OPEN_ROOM }
  const who = (value: unknown, fallback: Who): Who =>
    WHO.has(value as Who) ? (value as Who) : fallback
  const one = <T>(set: Set<T>, value: unknown, fallback: T): T =>
    set.has(value as T) ? (value as T) : fallback
  /*
   * The oracle ceiling is read as totally as `model` below: not a number
   * means null, "as on the instance", that is, today's behaviour of any room.
   * The number is clamped by the same ruler as the instance setting
   * (shared/admin.ts · LIMITS): a room allowed more than the instance itself
   * can do would promise what does not exist, and `oracleLimitsIn` would
   * return the instance's value anyway.
   */
  const cap = (value: unknown, min: number, max: number): number | null =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(Math.max(Math.round(value), min), max)
      : null
  const books = readBookRules(source.books)
  return {
    /*
     * Each field falls back to its own default separately from the others,
     * and that is the migration. A row written by an old build holds 'room'
     * or 'host' in three fields that now have three values each: both survive
     * the read untouched, and the third value simply is not there. The three
     * new fields are missing from old rows altogether and read as their
     * defaults.
     */
    run: one(RUN, source.run, OPEN_ROOM.run),
    edit: who(source.edit, OPEN_ROOM.edit),
    structure: one(STRUCTURE, source.structure, OPEN_ROOM.structure),
    files: who(source.files, OPEN_ROOM.files),
    wipe: who(source.wipe, OPEN_ROOM.wipe),
    restart: who(source.restart, OPEN_ROOM.restart),
    board: who(source.board, OPEN_ROOM.board),
    agent: one(AGENT, source.agent, OPEN_ROOM.agent),
    agentSteps: Number.isInteger(source.agentSteps)
      ? cap(source.agentSteps, LIMITS.agentSteps.min, LIMITS.agentSteps.max) : null,
    history: who(source.history, OPEN_ROOM.history),
    oracle: ORACLE.has(source.oracle as RoomRules['oracle'])
      ? (source.oracle as RoomRules['oracle'])
      : OPEN_ROOM.oracle,
    /*
     * The floor is one question, not zero, although the instance has zero.
     * Zero means "the oracle is off", and the room already has
     * `oracle: 'off'` for that, whose refusal says so in words; zero here
     * would turn the class away with the phrase "all 0 questions used".
     */
    questionsPerHour: cap(source.questionsPerHour, 1, LIMITS.questionsPerHour.max),
    slowModeSeconds: cap(
      source.slowModeSeconds,
      LIMITS.slowModeSeconds.min,
      LIMITS.slowModeSeconds.max,
    ),
    // The same ceiling as the instance's model: a number of its own here
    // would mean a room unable to ask for a model the instance has.
    model:
      typeof source.model === 'string' && source.model.trim()
        ? source.model.trim().slice(0, LIMITS.model)
        : null,
    opens: one(OPENS, source.opens, OPEN_ROOM.opens),
    /*
     * Per-notebook overrides. The key appears in the object only where there
     * is something to store: an old row from the database comes without it
     * and goes back without it, and a room with only defaults does not carry
     * an empty map through the sockets.
     */
    ...(books ? { books } : {}),
    ownBooks: readOwnBooks(source.ownBooks),
    ownMemoryMb: readOwnAmount(source.ownMemoryMb, MIN_OWN_MEMORY_MB, MAX_OWN_MEMORY_MB),
    ownCpus: readOwnAmount(source.ownCpus, 1, MAX_OWN_CPUS),
    /*
     * The cell limit is read by the same total measure as the personal
     * notebook numbers: garbage, a fraction and a number out of bounds mean
     * `null`, "no limit", that is, today's behaviour. There is one safe side
     * here, and it is the old one: erring towards "keeps computing" is fine,
     * erring towards "cut off someone's walkthrough" is not.
     */
    cellLimitSec: readOwnAmount(source.cellLimitSec, 1, MAX_CELL_LIMIT_SEC),
    /*
     * Dangerous commands are the only field where an unknown value reads as
     * the STRICT default, not the lenient one.
     *
     * All rooms created before this line come without it altogether, and
     * they read as protected. That is intended: a mistake here can only go
     * towards "refused too much" (one line in the rules and a minute of
     * conversation), while in the other direction the price is already
     * measured, and it equals a lost class (see the field).
     */
    danger: source.danger === 'allow' ? 'allow' : OPEN_ROOM.danger,
  }
}

/**
 * A personal notebook number, or `null`, that is, "as for the class".
 *
 * Total, like everything in `readRules`: garbage, a fraction and a number
 * out of bounds become `null`, not a refusal. Nothing may fail on the rules:
 * every sync frame reads them, and a database row spoiled by someone's hand
 * must not lock the room.
 */
function readOwnAmount(raw: unknown, min: number, max: number): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null
  return raw >= min && raw <= max ? raw : null
}

/**
 * "May own notebooks be created", from anything, including yesterday's
 * record.
 *
 * For a short while the field had a different pair of values,
 * `'room' | 'owner'`: "what access a student's notebook gets". The value
 * moved together with the meaning: `'owner'` was exactly "let them create
 * personal ones", that is, today's `'on'`. Everything else, including the
 * former `'room'`, reads as a ban: the default here is strict, and erring
 * towards it is fine, the other way is not.
 */
function readOwnBooks(raw: unknown): RoomRules['ownBooks'] {
  if (OWN_BOOKS.has(raw as RoomRules['ownBooks'])) return raw as RoomRules['ownBooks']
  return raw === 'owner' ? 'on' : OPEN_ROOM.ownBooks
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** True when this room is the product's own default — nothing to show, nothing to explain. */
export function isOpenRoom(rules: RoomRules): boolean {
  /*
   * The notebook map has to be asked about separately, and here is why.
   * `OPEN_ROOM` has no `books` at all (see there), so iterating over the
   * template's keys never reaches it, while a room where one notebook was
   * made personal has stopped being the product default.
   */
  if (rules.books && Object.keys(rules.books).length > 0) return false
  return (Object.keys(OPEN_ROOM) as (keyof RoomRules)[]).every(
    (key) => rules[key] === OPEN_ROOM[key],
  )
}

/**
 * Which rule says "who types and runs here", and which is about everything
 * else.
 *
 * A record over all keys at once, not a list: a rule added tomorrow must
 * break the type check here and demand a decision; the same argument as for
 * `LECTURE_ROOM` and `rulesAfterClass`, and the only copy of this boundary.
 */
const IS_A_RIGHT: Record<keyof RoomRules, boolean> = {
  run: true,
  edit: true,
  structure: true,
  board: true,
  files: true,
  wipe: true,
  restart: true,
  agent: true,
  agentSteps: false,
  /* Watching and asking are not "who types": a lecture leaves them alone. */
  history: false,
  oracle: false,
  questionsPerHour: false,
  slowModeSeconds: false,
  model: false,
  /* What the lock does is not a right: the teacher opens the cell in any case. */
  opens: false,
  /*
   * Per-notebook overrides are NOT a room right, and this is a decision, not
   * an oversight.
   *
   * The only reader of this list is the "Lecture" banner above the notebook
   * (`isLectureRoom`), and it tells five hundred people one thing: in the
   * ROOM the teacher types and runs. That stays true even when one student
   * has been given their own notebook: the label on its tab speaks about it,
   * while a removed banner would leave the grey lecture notebook with no
   * explanation at all, exactly the trouble the banner exists to prevent.
   *
   * `ownBooks` is a right, but it must not touch the banner, for the same
   * reason: "own notebooks are allowed" says nothing about the ROOM'S
   * NOTEBOOK, which is what the banner is about. The end of a class closes it
   * anyway; see `rulesAfterClass`, where this is done by value rather than by
   * flag.
   */
  books: false,
  ownBooks: false,
  /*
   * Not rights but hardware: the "Lecture" banner is about who may do what,
   * and memory numbers have nothing to do with that question, just as the
   * oracle ceilings above do not.
   */
  ownMemoryMb: false,
  ownCpus: false,
  /*
   * The cell limit is not a right either but a ceiling, and it does not
   * touch the "Lecture" banner: "the teacher types and runs" stays true with
   * or without a limit. A room where auto-stop was simply switched on is not
   * struck off the lectures.
   */
  cellLimitSec: false,
  /*
   * Dangerous commands are not a right either, and for the same reason: roles
   * are not distinguished here at all, while the "Lecture" banner is precisely
   * about roles. A room where the teacher of a Python course allowed showing
   * `os._exit` does not stop being a lecture.
   */
  danger: false,
}

const RIGHTS = (Object.keys(IS_A_RIGHT) as (keyof RoomRules)[]).filter((key) => IS_A_RIGHT[key])

/**
 * The room follows the lecture preset, on the model of `isOpenRoom`.
 *
 * A match by values, not a flag in the database: a preset is a set of rules,
 * and a room assembled by hand from the same values is no different from a
 * lecture.
 *
 * ONLY the rights (`IS_A_RIGHT`) are compared, because the "Lecture" banner
 * above the notebook (Notebook.svelte) tells five hundred people exactly one
 * thing: the teacher types and runs. Comparing all keys would mean turning
 * it off because of a toggle that did not change rights: `opens` (a council
 * is the same lecture in terms of rights), the oracle switched off for a
 * test, closed history, a question ceiling of its own, a model of its own.
 * The lecture does not stop being a lecture because of that, while the grey
 * notebook without the banner is left without a single explanation.
 *
 * The template the rights are checked against is `rulesAfterClass(rules)`,
 * not `LECTURE_ROOM`: it is the same "only the teacher types", written once.
 * It also reads `agent: 'off'` correctly: a disabled agent is stricter than
 * the lecture's, not softer, and does not strike the room off the lectures.
 *
 * One consequence worth knowing by sight: the rights of `rulesAfterClass`
 * are a fixed point, so a FINISHED class reads as a lecture from here. In
 * essence that is true (only the teacher types and runs), but this must not
 * be used to ask "is the class running lecture-style": the end of a class
 * has its own flag.
 */
export function isLectureRoom(rules: RoomRules): boolean {
  const lecture = rulesAfterClass(rules)
  return RIGHTS.every((key) => rules[key] === lecture[key])
}

/**
 * A council room: a lecture where the lock opens a sheet of their own for
 * everyone.
 *
 * Not a third preset next to the two but a refinement of the lecture, just
 * as COUNCIL_ROOM itself is built from LECTURE_ROOM in one line. Asking "is
 * this a lecture" about a council is allowed and needed; asking "is this a
 * council" about a lecture is not.
 */
export function isCouncilRoom(rules: RoomRules): boolean {
  return isLectureRoom(rules) && rules.opens === 'council'
}

/**
 * May somebody with this role do the thing this rule governs?
 *
 * A function rather than a comparison written out at each call site, because
 * the host exception is the part that is easy to forget: a rule set to `host`
 * has to keep letting the host through, and a rule set to `room` has to let
 * everybody through including the host. Written twice, the second copy is where
 * the bug goes.
 */
export function allows(rule: Who, role: 'host' | 'participant'): boolean {
  return rule === 'room' || role === 'host'
}

/**
 * Whether running is allowed, and one cell or the whole sheet.
 *
 * `single` allows pressing on a cell and forbids Run All and Run Above: the
 * kernel is one, and the difference between "twenty people compute" and
 * "twenty people jammed the queue with eight hundred cells" is exactly this.
 */
export function allowsRun(
  rule: RunWho,
  role: 'host' | 'participant',
  kind: 'one' | 'bulk',
): boolean {
  if (role === 'host') return true
  if (rule === 'host') return false
  return kind === 'one' || rule === 'room'
}

/**
 * How many of their own cells a person keeps in the queue at the same time.
 *
 * Not a right but a ceiling: under `single` everyone has their own queue one
 * cell long, and pressing a second one waits rather than being silently
 * rejected.
 */
export function runQueueCap(rule: RunWho, role: 'host' | 'participant'): number {
  return rule === 'single' && role !== 'host' ? 1 : Number.POSITIVE_INFINITY
}

/**
 * Whether the notebook's structure may be changed, and what exactly.
 *
 * Three verbs, because `add` allows exactly the first: adding your own to a
 * prepared worksheet is allowed, removing and moving someone else's is not.
 */
export function allowsStructure(
  rule: StructureWho,
  role: 'host' | 'participant',
  verb: 'add' | 'remove' | 'move',
): boolean {
  if (role === 'host') return true
  if (rule === 'room') return true
  return rule === 'add' && verb === 'add'
}

/**
 * Whether this person may run the oracle in "do" mode.
 *
 * A separate function rather than `allows`, because the rule has three
 * values: `off` closes the mode for everyone, including the teacher: "in
 * this room the oracle does not touch files" is a property of the room, not
 * someone's right. The same argument as for the shell, back when it existed.
 */
export function allowsAgent(rule: RoomRules['agent'], role: 'host' | 'participant'): boolean {
  if (rule === 'off') return false
  return rule === 'room' || role === 'host'
}

/* ----------------------------------------------- rules of ONE notebook */

/**
 * Who is asking: the role in the room and their own name in it.
 *
 * The name is needed exactly to recognize the author of a personal notebook,
 * and so it may be `null`: a seat that did not name itself is certainly not
 * the author, and it will get a refusal, not access.
 */
export interface Asker {
  role: 'host' | 'participant'
  /** participantId; `null`: the asker did not name themselves and cannot be the author. */
  participantId: string | null
}

/** What the room remembers about this notebook. `null`: nothing, i.e. "as in the room". */
function bookRuleFor(rules: RoomRules, root: string | null): BookRule | null {
  if (!root || !rules.books) return null
  const rule = rules.books[root]
  return rule && rule.access !== 'room' ? rule : null
}

/**
 * The room's rules RECOMPUTED for one notebook and one person.
 *
 * The only place where "notebook access" lives, and both sides of the
 * product call exactly this: the server before accepting a frame, moving a
 * cell or queueing it; the browser before drawing a button grey. After that
 * both work with the usual `mayEditCell`, `allowsStructure` and
 * `mayRunCell`, as if the room had one notebook. There is no second copy of
 * this fork in the product on purpose: diverged copies of one rule here have
 * already cost a grey button where the right existed.
 *
 * `run`, `edit` and `structure` change, and, only for ONE'S OWN personal
 * notebook, `restart` with `wipe`. Everything else (terminal, board, files,
 * history, oracle, ceilings) is shared by the room and has no "which
 * notebook" dimension.
 *
 * `restart`/`wipe` deserve a separate word, because they used to be absent
 * here altogether. A personal notebook has its own kernel and its own
 * container (`bookHasOwnKernel`), so "restart" in it takes away one person's
 * variables, their own, and "clear outputs" clears their own output.
 * Requiring the teacher for this would mean raising a hand in the middle of
 * a lecture to declare `x` again in one's own draft. A notebook open to ALL
 * (`all`) is left out of this on purpose: it has the room's kernel, and a
 * restart in it is a restart of the class.
 *
 * Returns THE SAME object when there is nothing to change: this is not
 * economy but a promise to callers that compare rules by reference (the
 * browser's `$derived` and the server's rules cache) that an ordinary room
 * does not produce a new object on every sync frame.
 *
 * The teacher passes straight through: `allows`, `allowsRun` and
 * `allowsStructure` let the `host` role through anyway, and a notebook
 * closed "to the teacher only" is not closed to them.
 *
 * The end of a class does not reach here and cannot: `rulesAfterClass` does
 * not carry the override map over (see there), so the effective rules of a
 * finished class arrive here without `books` and leave as they came.
 */
export function rulesForBook(rules: RoomRules, root: string | null, who: Asker): RoomRules {
  if (who.role === 'host') return rules
  const rule = bookRuleFor(rules, root)
  if (!rule) return rules
  const own = rule.access === 'owner' && ownsBook(rule, who)
  const mine = rule.access === 'all' || own
  /*
   * "My" notebook opens fully, not "as in the room", and that is the point:
   * the student works on their own while the lecture goes on next to them.
   * `run: 'room'`, not `single`: "one at a time" is a queue ceiling, not a
   * right, and a separate `runQueueCap` computes it from the room's rules.
   *
   * The kernel and output of one's own notebook are one's own too; see the
   * note above.
   */
  if (own) {
    return { ...rules, run: 'room', edit: 'room', structure: 'room', restart: 'room', wipe: 'room' }
  }
  if (mine) return { ...rules, run: 'room', edit: 'room', structure: 'room' }
  return { ...rules, run: 'host', edit: 'host', structure: 'host' }
}

function ownsBook(rule: BookRule, who: Asker): boolean {
  return rule.owner !== null && who.participantId !== null && rule.owner === who.participantId
}

/**
 * Whether this notebook computes in the SEPARATE container, the one where
 * the class's personal notebooks live.
 *
 * Every notebook of the room has its own kernel: the lecture and the seminar
 * are different notebooks, and variables of one do not appear in the other
 * (server/src/kernel/index.ts). This question is about something else: in
 * WHICH container to start the kernel, and it has exactly two answers: the
 * room's container or the personal notebooks' container.
 *
 * Personal notebooks need a separate container for two reasons, and both are
 * about a boundary that cannot be drawn inside one container. A GPU is given
 * to a container whole: the card cannot be taken away from one process
 * inside, and `CUDA_VISIBLE_DEVICES` is removed by one line in a cell. And
 * the memory limit is shared by the container: the OOM killer picks the
 * heaviest process, that is, the lecture's kernel with the dataset loaded,
 * not the greedy student.
 *
 * One place for the whole product on purpose: a second copy of the
 * `access === 'owner'` comparison is exactly what makes a diverged rule
 * differ from the rule.
 *
 * `all` and `host` do not get here: "open to everyone" is still the class's
 * shared notebook (it has its own kernel, the container is the room's), and
 * "teacher only" all the more so.
 *
 * This must be asked by the STORED rules (db.ts · storedRules), not the
 * effective ones: `rulesAfterClass` does not carry the `books` map over, and
 * the bell must not move kernels from container to container.
 */
export function bookHasOwnKernel(rules: RoomRules, root: string | null): boolean {
  if (!root || !rules.books) return false
  return rules.books[root]?.access === 'owner'
}

/**
 * How the NOTEBOOK refuses, not the room, and `null` when the notebook has
 * nothing to do with it.
 *
 * Separate from `rulesForBook`, because these are different questions: one
 * answers "is it allowed", the other "what to tell the person". What to say
 * is about the notebook: hearing "in this seminar the teacher types" while
 * standing in someone else's personal notebook means going to look for a
 * teacher who forbade nothing.
 *
 * The phrase's key rather than the phrase itself, by the `CLASS_IS_OVER`
 * argument: this file is about rights, not words, and it is called on every
 * sync frame.
 */
export function bookRefusal(
  rules: RoomRules,
  root: string | null,
  who: Asker,
): { key: string; name: string } | null {
  if (who.role === 'host') return null
  const rule = bookRuleFor(rules, root)
  if (!rule) return null
  if (rule.access === 'all') return null
  if (rule.access === 'owner') {
    if (ownsBook(rule, who)) return null
    return { key: BOOK_IS_PERSONAL, name: rule.ownerName ?? '' }
  }
  return { key: BOOK_IS_THE_TEACHERS, name: '' }
}

/**
 * The lock on a cell: may THIS person write into THIS cell.
 *
 * A lecture closes the whole notebook, and then the only way to let the
 * class type something is to open a single cell for them. An open cell is a
 * right on top of the rules: `edit: 'host'` stays in force for the rest of
 * the notebook, and what loosens it is not a room setting but the teacher,
 * by hand and for a while.
 *
 * A function rather than an inline check, exactly by the `allows` argument:
 * the server (collab/gate.ts) and the browser (web/src/lib/may.ts) must
 * answer this question identically. Once they diverge, they give either a
 * button that can be pressed and brings a refusal or, worse, a grey button
 * where the right exists.
 *
 * An open cell gives EXACTLY the text. It does not allow removing it,
 * moving it or changing its type: in a lecture the notebook's structure
 * belongs to the teacher, and a cell opened for work must not open a way to
 * delete that very cell.
 *
 * `cellOpen` here is strictly `isCellOpen(cell)`, that is, the "open to
 * everyone" position. A council comes here as `false` on purpose: in a
 * council everyone has their own sheet, and the cell's shared text is closed
 * as in a closed cell. Council rights are below:
 * `mayWriteCouncil`/`mayRunCouncil`/`mayLeadCouncil`.
 *
 * The end of a class is stronger than the lock, so `actsAfterClass` is the
 * first factor: otherwise "End class" would leave the room as many doors as
 * the teacher managed to open during the class, and they would have to be
 * closed one by one, remembering which ones were opened.
 */
export function mayEditCell(
  rules: RoomRules,
  role: 'host' | 'participant',
  cellOpen: boolean,
  finished: boolean,
): boolean {
  return actsAfterClass(finished, role) && (allows(rules.edit, role) || cellOpen)
}

/**
 * The same for running, and by the measure of ONE cell.
 *
 * `allowsRun(..., 'one')`, not `'bulk'`: an open cell is permission to
 * compute it, not to Run All over someone else's notebook. A notebook has
 * one queue, and a lecture is the last place where twenty people queue the
 * whole sheet.
 */
export function mayRunCell(
  rules: RoomRules,
  role: 'host' | 'participant',
  cellOpen: boolean,
  finished: boolean,
): boolean {
  return actsAfterClass(finished, role) && (allowsRun(rules.run, role, 'one') || cellOpen)
}

/* ----------------------------------------------------------------- council */

/**
 * Whether this person writes their own attempt in a council.
 *
 * The room's rules have nothing to do with it, and this is not a caveat but
 * the essence of the position: a council is opened precisely where `edit` is
 * the teacher's, so that everyone writes THEIR OWN sheet without touching
 * the shared one. Only the end of the class stops it: after the bell
 * attempts are not accepted, and the submitted ones stay available for
 * review.
 *
 * `closed`: the council on this cell is already closed (the lock moved to
 * another position): the text stays with the student as a draft but does
 * not go to the server.
 */
export function mayWriteCouncil(
  role: 'host' | 'participant',
  finished: boolean,
  closed: boolean,
): boolean {
  return !closed && actsAfterClass(finished, role)
}

/**
 * Whether this person runs an attempt in a council.
 *
 * The teacher runs any attempt, including after the class. A student runs
 * only their own, when studentRun === true. The request mode allows asking
 * for approval but by itself gives no right to execute.
 */
export function mayRunCouncil(
  role: 'host' | 'participant',
  studentRun: boolean | 'request',
  finished: boolean,
): boolean {
  if (!actsAfterClass(finished, role)) return false
  return role === 'host' || studentRun === true
}

/**
 * Whether one leads the council: show to the class, reply, mark, remove,
 * switch the lock and the knobs, ask the oracle about the solutions.
 *
 * Only the teacher, and after the bell it is still them: submitted attempts
 * stay available for review until the end of the class, and going through
 * them after the class is their right.
 */
export function mayLeadCouncil(role: 'host' | 'participant'): boolean {
  return role === 'host'
}

/**
 * Whom the room may follow through the document.
 *
 * Only the teacher: `leaderFor` (web/src/lib/follow.ts) takes exactly the
 * `host` role as leader, and nobody reads anyone else's position.
 *
 * The rule is here rather than in two copies, because it has two sides and
 * they must match: one picks the leader from presence, the other decides
 * whether to publish one's own position at all. While everyone published, a
 * single teacher step at a lecture turned into N presence frames from N
 * listeners and N×N deliveries: at five hundred that is millions of
 * messages per scrolled page.
 */
export function mayBeFollowed(role: 'host' | 'participant'): boolean {
  return role === 'host'
}

/**
 * The oracle mode a room actually runs under.
 *
 * Two settings meet here: what the instance allows and what the seminar asked
 * for. A room may tighten and may never loosen — an instance that is off
 * cannot be talked back on, because that decision belongs to whoever pays for
 * the model.
 *
 * Exported from shared because the server enforces it and the panel draws
 * from it, and those two were computing different answers: the panel asked
 * `/api/ai/status`, which knows nothing about a seminar, so a room set to
 * hints still showed Explain, Fix and Debug — and every press came back 403.
 */
export function oracleModeIn(
  rules: RoomRules,
  instance: 'off' | 'hints' | 'full',
): 'off' | 'hints' | 'full' {
  const wanted = rules.oracle
  if (wanted === 'inherit') return instance
  if (instance === 'off') return 'off'
  if (instance === 'hints' && wanted === 'full') return 'hints'
  return wanted
}

/** Two oracle ceilings: questions per hour per person and the interval between them. */
export interface OracleLimits {
  questionsPerHour: number
  slowModeSeconds: number
  agentSteps?: number
}

/** A room can tighten a server ceiling; zero represents an unlimited ceiling. */
export function agentStepsIn(room: number | null, instance: number): number {
  if (room === null) return instance
  if (instance === 0) return room
  return room === 0 ? instance : Math.min(room, instance)
}

/**
 * The ceilings a room actually works under.
 *
 * The same rule as `oracleModeIn` above, and for the same reason: a room
 * tightens and never loosens. Loosening is not allowed because the model is
 * paid for by whoever runs the instance: their number is their bill, and a
 * seminar able to raise its own limit would turn the instance setting from
 * a ceiling into advice. Going lower, on the other hand, is useful: a test
 * for one class should not cost a trip to settings shared by all the other
 * rooms.
 *
 * Stricter goes in different directions, hence not one `Math.min` for both
 * fields: there must be FEWER questions and a LONGER interval between them.
 *
 * `null` means "as on the instance": the room said nothing, and the instance
 * answers.
 */
export function oracleLimitsIn(rules: RoomRules, instance: OracleLimits): OracleLimits {
  return {
    questionsPerHour:
      rules.questionsPerHour === null
        ? instance.questionsPerHour
        : Math.min(instance.questionsPerHour, rules.questionsPerHour),
    slowModeSeconds:
      rules.slowModeSeconds === null
        ? instance.slowModeSeconds
        : Math.max(instance.slowModeSeconds, rules.slowModeSeconds),
  }
}

/**
 * The class is over.
 *
 * Not a rule value but a room state on top of the rules: the teacher
 * pressed "End class", and from that minute a participant reads and
 * watches, and only the teacher acts. The room stays alive (the notebook,
 * files, the terminal feed and the oracle's answers are in place), because
 * that is exactly where people go after the class.
 *
 * The stored rules are not touched: a class can be ended and reopened any
 * number of times, and each time the room returns to exactly the setup it
 * was ended from. Hence a function here, not a database write.
 *
 * All the fields are listed, every single one, without `...rules`, on
 * purpose: a rule added tomorrow must break the type check here and demand
 * a decision, not slip through silently as open.
 */
export function rulesAfterClass(rules: RoomRules): RoomRules {
  return {
    run: 'host',
    edit: 'host',
    structure: 'host',
    board: 'host',
    files: 'host',
    wipe: 'host',
    restart: 'host',
    /*
     * `off` is a property of the room, not someone's right (see the `agent`
     * field), and a finished class does not soften it.
     */
    agent: rules.agent === 'off' ? 'off' : 'host',
    agentSteps: rules.agentSteps,
    /*
     * These stay as they were. `history` is reading, and reading is exactly
     * what must remain. `oracle` and `model` describe not a right to act but
     * the model and its level of detail; `oracle` has no "who" dimension at
     * all, so a finished class forbids "asking the oracle" by a separate role
     * check (server/src/routes/ai.ts), not by this field.
     */
    history: rules.history,
    oracle: rules.oracle,
    // What "opening a cell" means is a room property, and after the bell cells
    // are not opened at all; the field goes through as it was, so that the
    // morning after the class remembers the mode.
    opens: rules.opens,
    /*
     * Oracle ceilings come along too: they are about spending, not rights.
     * After the bell only the teacher asks, and the interval does not apply
     * to them anyway.
     */
    questionsPerHour: rules.questionsPerHour,
    slowModeSeconds: rules.slowModeSeconds,
    model: rules.model,
    /*
     * There are NO per-notebook overrides here, and this is the most
     * important line in the function.
     *
     * The end of a class is stronger than everything else, including access
     * to an individual notebook: "open to everyone" and "personal" are
     * permissions, and after the bell only the teacher acts. The map is not
     * carried over here at all, and so `rulesForBook` on top of these rules
     * finds nothing and opens nothing. The order does not matter then, but
     * it would if the map got here: then one personal notebook would survive
     * the bell silently.
     *
     * The STORED rules are intact meanwhile (`db.ts · storedRules`): the
     * class is reopened, and the personal notebook comes back as what it
     * was.
     *
     * Own notebooks are not created after the bell: it is the same kind of
     * action as editing and running, and it is closed here, not by a
     * separate check in `books.ts`, by the same argument as everything else
     * in this function. The STORED choice stays intact (`db.ts ·
     * storedRules`), and a reopened class brings it back.
     */
    ownBooks: 'off',
    /*
     * The bell does not touch the personal notebook numbers.
     *
     * The end of a class is about rights: it closes doors, it does not take
     * hardware away. Besides, it has already closed the door to personal
     * notebooks one line above, and the number will be needed the very
     * second the class is reopened.
     */
    ownMemoryMb: rules.ownMemoryMb,
    ownCpus: rules.ownCpus,
    /*
     * The bell does not touch the cell limit, by the same argument: it is
     * about rights, not about how long the kernel is given to compute. And
     * after the bell only the teacher runs, and the limit stops their cell
     * exactly as it stops a student's; removing it silently would be a
     * surprise.
     */
    cellLimitSec: rules.cellLimitSec,
    /*
     * The protection against dangerous commands survives the bell as it was,
     * in both directions. There is no need to tighten it here (it is strict
     * by default already), and it must not be removed: after the class the
     * teacher stays in the room, and `os._exit(0)` in their cell costs them
     * the same variables it costs the class.
     */
    danger: rules.danger,
  }
}

/**
 * One phrase for all refusals of a finished class, both on the server and in
 * tooltips.
 *
 * Separate from the rules: what matters to a person is not which rule
 * stopped them but that the class is over. Hearing instead "in this seminar
 * the teacher runs" means going to look for a teacher who changed nothing.
 */
export const CLASS_IS_OVER = 'server.classOver'

/**
 * Whether this person acts in a room whose class is over.
 *
 * For what rules do not express: asking the oracle, opening the terminal
 * drawer, answering `input()`. Actions that have a rule are closed by
 * `rulesAfterClass`; this is the same boundary for everything else.
 */
export function actsAfterClass(finished: boolean, role: 'host' | 'participant'): boolean {
  return !finished || role === 'host'
}
