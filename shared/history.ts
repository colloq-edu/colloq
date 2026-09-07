/**
 * What the room did to its notebook, and how to get any of it back.
 *
 * A seminar notebook is edited by twenty people at once, live, on a projector.
 * That is exactly the situation where somebody deletes the cell everyone was
 * looking at, or pastes over a working example, and the room stops while the
 * teacher tries to remember what was there. Ctrl+Z does not help: the person
 * who has to undo it is rarely the person who did it.
 *
 * So the room keeps a history, and the history answers two questions — who
 * changed this, and what did it look like before.
 */
import type { DiffLine } from './diff.js'

/*
 * Строка разницы — одна на весь продукт, и объявлена она там, где её считают.
 *
 * Здесь стояла вторая копия того же интерфейса, слово в слово. Копии
 * разъезжаются на первом же добавленном поле: `CellDiff.lines` типизирован
 * этим, а routes/history.ts кладёт в него результат `diffLines` из diff.ts —
 * и расхождение вылезло бы не проверкой типов, а пустым местом на экране.
 */
export type { DiffLine }

/** What kind of moment this is. Ordinary typing is an `edit`. */
export type VersionKind =
  /** A burst of edits by one person, closed by silence or by somebody else typing. */
  | 'edit'
  /** A point somebody named on purpose: "before the exercise". */
  | 'checkpoint'
  /** Somebody put an older version back. Recorded so it can itself be undone. */
  | 'restore'
  /** The room's first state — the notebook it opened with. */
  | 'opened'
  /**
   * A burst that changed no text — outputs, run states, a moved cell.
   *
   * Never shown: the timeline is the history of what the room wrote. But
   * always stored, because Yjs replay cannot skip an update — every later one
   * names the clocks it was built on. A skipped burst is a hole, and every
   * version rebuilt across the hole came out wrong.
   */
  | 'quiet'

/*
 * A history holds finished facts and nothing else. There is deliberately no
 * "somebody is typing right now" here: an unfinished edit is not a version, it
 * is a rumour about one, and a log that reports rumours is a log you cannot
 * trust the rest of. What is in flight is visible where it belongs — in the
 * notebook, under that person's cursor.
 */

/** One line of the timeline. Deliberately small: the list is loaded whole. */
export interface Version {
  /** Monotonic within a session. Also the address of the state after this edit. */
  seq: number
  kind: VersionKind
  /** Who did it. Null for the server's own writes — seeding, an import. */
  authorId: string | null
  authorName: string | null
  authorColor: string | null
  createdAt: number
  /** Only a checkpoint has one. */
  label: string | null
  /** What it touched, already in words: "edited cell 04", "added 3 cells". */
  summary: string
  /**
   * Только у отката: версия, которую он вернул.
   *
   * Адрес, а не время. Подпись «restored the version from 15:04» сервер
   * собирал по своему часовому поясу — в контейнере это UTC, — а строки ленты
   * рисует браузер по своему: в аудитории UTC+3 подпись указывала на строку,
   * которой в списке нет. Часы рисует тот, кто смотрит, по `createdAt` этой
   * версии.
   */
  targetSeq: number | null
  /** Characters written and removed, for the two numbers at the end of the row. */
  added: number
  removed: number
  /** Cell ids this version touched, so the sheet can mark them. */
  cells: string[]
}

/** A cell as of some version. Enough to render it read-only and to diff it. */
export interface HistoricCell {
  id: string
  type: 'code' | 'markdown'
  source: string
}

export interface VersionContent {
  seq: number
  cells: HistoricCell[]
}

export interface CellDiff {
  cellId: string
  /** Null when the cell did not exist yet — the whole thing is an addition. */
  before: string | null
  /** Null when the cell was deleted. */
  after: string | null
  lines: DiffLine[]
}

export interface VersionDetail {
  version: Version
  diffs: CellDiff[]
}

/**
 * Ответ ленты: строки — и целиком ли она.
 *
 * История комнаты ограничена по объёму, и у очень долгого семинара начало
 * срезано целым отрезком (server/src/db.ts · trimHistory). Без этого поля
 * панель показывает остаток ровно так же, как показала бы полную ленту, и по
 * ней не отличить «тут ничего не писали» от «до этого места не сохранилось» —
 * а смотрят историю обычно как раз тогда, когда что-то потеряли.
 *
 * Признак ровно об этом и ни о чём другом: список может быть неполон ещё и
 * потому, что окно ленты — четыреста строк (routes/history.ts · MAX_VERSIONS),
 * но те версии в базе есть, и говорить о них надо другими словами.
 *
 * Считает сервер, `db.ts · historyTrimmed`, по самой старой строке комнаты.
 */
export interface VersionList {
  versions: Version[]
  trimmed: boolean
}

/** How many characters a burst may accumulate before it is closed on size alone. */
export const BURST_MAX_CHARS = 4_000

/**
 * How long one person may keep typing before the burst is closed anyway.
 *
 * A burst is meant to be "one thing somebody did". Left unbounded, a teacher
 * writing a long cell for four minutes produces a single version covering the
 * whole thing, and the one state worth going back to — the moment before the
 * paragraph that broke it — is not in the list.
 */
export const BURST_MAX_MS = 90_000

/** Silence after which a burst is considered finished. */
export const BURST_IDLE_MS = 12_000

/**
 * Потолок по числу строк между полными снимками.
 *
 * Собрать версию N — это повторить обновления поверх ближайшего снимка не выше
 * неё, и это число — потолок на такую работу, а не длина истории.
 *
 * Ограничивает длину повтора, а не место: место считается по байтам (см.
 * maybeKeyframe). Без потолка крошечная тетрадь с тысячей мелких правок
 * собиралась бы из тысячи кусков.
 *
 * Было 25 — и это был единственный порог, из-за чего трёхмегабайтная тетрадь
 * писала снимок на каждые двадцать пять нажатий. Теперь по байтам решает
 * правило дороже, а этот порог остался тем, чем должен был быть с самого
 * начала: страховкой от длинного повтора. Двести обновлений — это доли
 * секунды на сборку и заведомо реже, чем сработает правило по байтам на любой
 * тетради, которую стоит беречь.
 */
export const KEYFRAME_EVERY = 200

/**
 * Ниже этого полный снимок не пишут, сколько бы дельт ни накопилось.
 *
 * Для пустой тетради «дельт накопилось столько же, сколько весит документ» —
 * это два нажатия, и снимок на каждое второе. Шестьдесят четыре килобайта —
 * это заведомо меньше любого разумного семинара и заведомо больше любого шума.
 */
export const KEYFRAME_MIN_BYTES = 64 * 1024
