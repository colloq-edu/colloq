import { tr } from '@shared/i18n'
/**
 * The rows that describe a room — one per rule.
 *
 * One place for the panel and for the console inside the room — otherwise two
 * surfaces ask the same thing in different words, and a teacher who set
 * "read-only" from the panel looks in the room for a switch that is called
 * something else.
 *
 * The order is neither alphabetical nor by importance but follows the course
 * of a class: first what a person does by hand in the notebook, then the
 * kernel, then everything shared.
 *
 * The rows are of two kinds. For most, the answer is chosen from two or three
 * words; for the two oracle ceilings the answer is a number, and a switch
 * cannot set it. They share exactly as much as RoomRulesRows.svelte draws: a
 * title, a caption and one control on the right.
 *
 * The number of rows is deliberately not named here: it has already drifted
 * from the array below twice. That every room rule is named exactly once and
 * that every option survives to `readRules` is checked by
 * tests/weblib-rule-rows.test.mts; `oracle` and `model` are asked elsewhere,
 * and that is recorded there too.
 *
 * The LANGUAGE of these rows is the room's, not that of the panel that uses
 * the same list. The teacher panel is English in places, and it is tempting
 * to translate the captions along with it. It must not be done: the same list
 * draws the rules console inside the room, and the room is Russian throughout
 * — from "Submit" to "The class is over" — and translating for the panel's
 * sake would give one setting two names, exactly what the second paragraph is
 * about. The whole decision is recorded in the header of
 * components/RoomRulesRows.svelte; what matters here is the consequence: these
 * rows must not be translated separately, and if the panel's language is one
 * day chosen to be English, they will move into it only together with the
 * room's texts and in one piece — half of it would leave a rule with two
 * names. That the captions stayed in the room's language is checked by the
 * same test.
 */
import { LIMITS } from '@shared/admin'
import { MAX_CELL_LIMIT_SEC, type RoomRules } from '@shared/rules'

export interface RuleOption {
  value: string
  label: string
}

/** A switch row: one rule, two or three values, one lit. */
export interface ChoiceRow {
  kind: 'choice'
  key: keyof RoomRules &
    (
      | 'run'
      | 'edit'
      | 'structure'
      | 'board'
      | 'files'
      | 'agent'
      | 'wipe'
      | 'restart'
      | 'history'
      | 'opens'
      | 'ownBooks'
      | 'danger'
    )
  title: string
  note: string
  options: RuleOption[]
}

/**
 * A number row: an oracle ceiling the room lowers for itself.
 *
 * Empty means "as on the instance": that is the default and today's behaviour
 * of any room. The bounds are the same as for the instance setting
 * (shared/admin.ts · LIMITS), so that a room does not ask for what the
 * instance cannot do.
 */
export interface LimitRow {
  kind: 'limit'
  key: keyof RoomRules &
    ('questionsPerHour' | 'slowModeSeconds' | 'agentSteps' | 'cellLimitSec')
  title: string
  note: string
  /** The caption by the field — so that the number is not left bare. */
  unit: string
  min: number
  max: number
  /**
   * How to name the instance's current value — and `undefined` when there is
   * none.
   *
   * A function, not a template: for the oracle ceilings zero means not "zero"
   * but a special state, and "0 per hour" next to an input field is a riddle,
   * not a hint.
   *
   * Optional since a number row stopped being only an oracle ceiling: the cell
   * limit has no instance value at all, and an empty field there means "no
   * limit", not "as on the server". An invented line "as on the server: —"
   * would answer a question nobody asked.
   */
  atInstance?: (value: number) => string
}

export type RuleRow = ChoiceRow | LimitRow

const EVERYONE = { value: 'room', get label() { return tr('room.ui.1127') } }
const TEACHER = { value: 'host', get label() { return tr('room.ui.675') } }

/**
 * The words here are the room's; about the language and why it is not edited
 * from here — see the file header.
 */
export const RULE_ROWS: RuleRow[] = [
  {
    kind: 'choice',
    key: 'opens',
    get title() { return tr('room.ui.1128') },
    // This is the whole difference between a lecture and a council as modes:
    // the rights are the same, but "open a cell" means different things.
    get note() { return tr('room.ui.1129') },
    options: [
      { value: 'shared', get label() { return tr('room.ui.1130') } },
      { value: 'council', get label() { return tr('room.ui.1131') } },
    ],
  },
  {
    kind: 'choice',
    key: 'edit',
    get title() { return tr('room.ui.1132') },
    get note() { return tr('room.ui.1133') },
    options: [EVERYONE, TEACHER],
  },
  {
    kind: 'choice',
    key: 'run',
    // Not only cells: the same rule covers "Run" above a file and a command in
    // the shared shell (control.ts, file:run and term:run). A row that promised
    // cells alone read as "the terminal stays open" — while `python train.py`
    // there is the same container and the same CPU time.
    get title() { return tr('room.ui.1134') },
    get note() { return tr('room.ui.1135') },
    options: [EVERYONE, { value: 'single', get label() { return tr('room.ui.1136') } }, TEACHER],
  },
  {
    /*
     * Right AFTER "who runs", and the place is chosen the same way as for
     * personal notebooks under files: the two rules read together. The first
     * is who may press, the second how long what was pressed may compute. A
     * notebook has one kernel, and the second rule is the only thing that
     * stops one run from occupying it until the end of the class — including
     * the council attempt queue, which has a limit of its own that is of no
     * use while an ordinary cell without a limit stands ahead of it.
     */
    kind: 'limit',
    key: 'cellLimitSec',
    get title() { return tr('room.rules.cellLimit.title') },
    // The hint names both the default ("empty — never") and that the limit
    // applies to the teacher's cells too: without the second it reads as a
    // restriction for students, and that is not so.
    get note() { return tr('room.rules.cellLimit.note') },
    get unit() { return tr('room.rules.cellLimit.unit') },
    min: 1,
    max: MAX_CELL_LIMIT_SEC,
  },
  {
    /*
     * The third row about the kernel, right after "who runs" and "how long it
     * may compute": all three are about one thing — a notebook has one kernel
     * for everyone. The first is about who may press, the second about when a
     * run is cut off, this one about lines after which it is not the run that
     * is cut off but the class.
     */
    kind: 'choice',
    key: 'danger',
    get title() { return tr('room.rules.danger.title') },
    /*
     * The caption must say four things, and each is an answer to a question
     * people come here with: WHAT exactly will not execute, WHY (one line
     * kills the kernel or wipes the variables for the whole class), FOR WHOM
     * this gets turned off (a course on Python itself) and WHAT is not promised
     * here — it is a speed bump, not a sandbox, and it does not close the
     * terminal.
     */
    get note() { return tr('room.rules.danger.note') },
    options: [
      { value: 'block', get label() { return tr('room.rules.danger.block') } },
      { value: 'allow', get label() { return tr('room.rules.danger.allow') } },
    ],
  },
  {
    kind: 'choice',
    key: 'structure',
    get title() { return tr('room.ui.1137') },
    // "Someone else's" was untrue here by default: the rule does not know the
    // author, and under "append only" a participant cannot remove even their
    // own freshly added cell. The words are the same the room shows in a
    // refusal (may.ts).
    get note() { return tr('room.ui.1138') },
    options: [EVERYONE, { value: 'add', get label() { return tr('room.ui.1139') } }, TEACHER],
  },
  {
    kind: 'choice',
    key: 'board',
    get title() { return tr('room.ui.1140') },
    get note() { return tr('room.ui.1141') },
    options: [EVERYONE, TEACHER],
  },
  {
    kind: 'choice',
    key: 'files',
    get title() { return tr('room.ui.1142') },
    get note() { return tr('room.ui.1143') },
    options: [EVERYONE, TEACHER],
  },
  {
    kind: 'choice',
    key: 'ownBooks',
    /*
     * Right AFTER files, and the place is chosen: the two rules stand next to
     * each other precisely so that the difference between them reads at a
     * glance. The row above is about the class's shared folder; this one is
     * about the participant's own notebook, whose file the server writes as a
     * projection. They do get confused: "but I allowed files".
     */
    get title() { return tr('room.rules.ownBooks.title') },
    // The hint names the default too: "off by default" is half the answer to
    // the question people come here with ("why can't they?"), and without it
    // the switch reads as broken.
    get note() { return tr('room.rules.ownBooks.note') },
    options: [
      { value: 'off', get label() { return tr('room.rules.ownBooks.off') } },
      { value: 'on', get label() { return tr('room.rules.ownBooks.on') } },
    ],
  },
  {
    kind: 'choice',
    key: 'agent',
    get title() { return tr('room.ui.1144') },
    get note() { return tr('room.ui.1145') },
    options: [EVERYONE, TEACHER, { value: 'off', get label() { return tr('room.ui.1146') } }],
  },
  /*
   * The two oracle ceilings stand here and not in the instance settings,
   * because the decision about them is made a minute before class: a test is
   * "one question per person today", not a new setting for all rooms at once.
   * The instance stays the ceiling meanwhile: one can go below it, but not
   * above it — the instance pays for the model.
   */
  {
    kind: 'limit',
    key: 'agentSteps',
    get title() { return tr('common.agentSteps') },
    get note() { return tr('common.agentStepsNote') + ' ' + tr('common.agentStepsRoomNote') },
    get unit() { return tr('common.agentStepsUnit') },
    min: LIMITS.agentSteps.min,
    max: LIMITS.agentSteps.max,
    atInstance: (value) => value === 0 ? tr('common.unlimitedActions') : tr('common.actionCount', { count: value }),
  },
  {
    kind: 'limit',
    key: 'questionsPerHour',
    get title() { return tr('room.ui.1147') },
    get note() { return tr('room.ui.1148') },
    get unit() { return tr('room.ui.1149') },
    /*
     * The floor is one question, not zero: "no oracle today" is the row above,
     * and it says so in words, while a zero here would turn the class away
     * with the refusal "all 0 questions used".
     */
    min: 1,
    max: LIMITS.questionsPerHour.max,
    atInstance: (value) => (value === 0 ? tr('room.ui.1150') : tr('room.ui.1151', { p0: value })),
  },
  {
    kind: 'limit',
    key: 'slowModeSeconds',
    get title() { return tr('room.ui.1152') },
    get note() { return tr('room.ui.1153') },
    get unit() { return tr('room.ui.1154') },
    min: LIMITS.slowModeSeconds.min,
    max: LIMITS.slowModeSeconds.max,
    atInstance: (value) => (value === 0 ? tr('room.ui.1155') : tr('room.ui.1156', { p0: value })),
  },
  {
    kind: 'choice',
    key: 'history',
    get title() { return tr('room.ui.1157') },
    get note() { return tr('room.ui.1158') },
    options: [EVERYONE, TEACHER],
  },
  {
    kind: 'choice',
    key: 'restart',
    get title() { return tr('room.ui.1159') },
    get note() { return tr('room.ui.1160') },
    options: [EVERYONE, TEACHER],
  },
  {
    kind: 'choice',
    key: 'wipe',
    get title() { return tr('room.ui.1161') },
    // "Always clears" promised a button that did not exist at all. One's own
    // cell is a separate action in its toolbar, and its rule is a different
    // one: typing.
    get note() { return tr('room.ui.1162') },
    options: [EVERYONE, TEACHER],
  },
]
