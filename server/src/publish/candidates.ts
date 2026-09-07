/**
 * Моменты, которые могут стать шагами.
 *
 * Шаг — это версия, названная человеком: «перед упражнением», «версия, которая
 * ломалась». Технически это строка истории, но не всякая: годится только та,
 * что разворачивается хотя бы в одну ячейку, и это проверяется тут, на горстке
 * строк, а не потом, когда студент откроет пустую страницу.
 *
 * Всплески правок (`edit`, `quiet`) кандидатами не бывают. Их десятки за пару,
 * их никто не называл, и «шаг» из них получился бы механический — момент, в
 * который просто перестали печатать.
 */
import { db } from '../db.js'
import { getCells } from '@shared/notebook'
import { openReplay } from './replay.js'

/**
 * Строки, за которыми стоит целый документ.
 *
 * Строками, а не `VersionKind`: `keyframe` в базе есть, а в объединении типов
 * его нет — он служебный и в ленте не показывается. Приводить его к типу,
 * который его не знает, значило бы соврать компилятору ради красоты импорта.
 */
const NAMED: ReadonlySet<string> = new Set(['opened', 'checkpoint', 'restore', 'keyframe'])

export interface Candidate {
  seq: number
  /** Что предлагается как имя. Пусто — момент безымянный, его надо назвать. */
  label: string
  at: number
  cellCount: number
  kind: string
}

/**
 * Сколько НАЗВАННЫХ строк брать. Семестр в одной комнате — это выброс.
 *
 * Раньше здесь стояло окно на четыреста строк ЛЮБОГО вида, а по `kind`
 * отсеивалось уже отданное. Всплеск правок закрывается каждые четыре килобайта
 * обновлений, на любую смену состава тетради и по двенадцати секундам тишины —
 * комната на тридцать человек выдаёт их сотнями за пару, и чекпоинт,
 * поставленный на пятнадцатой минуте, из окна вылетал. Строка при этом жива в
 * базе: терялась ровно та функция, ради которой её ставили.
 */
const MAX_NAMED = 400

/**
 * Названные строки истории — запросом, а не фильтром по отданному.
 *
 * Виды перечисляет `NAMED`, чтобы список был один: индекс `doc_history_session`
 * закрывает этот запрос целиком.
 */
const selectNamed = db.prepare(`
  SELECT seq, kind, created_at, label
  FROM doc_history
  WHERE session_id = ? AND kind IN (${[...NAMED].map(() => '?').join(', ')})
  ORDER BY seq DESC LIMIT ?
`)

interface NamedRow {
  seq: number
  kind: string
  created_at: number
  label: string | null
}

/**
 * Что уже посчитано — по комнате и строке.
 *
 * История неизменяема: строка, развёрнутая один раз, столько же ячеек даст и
 * через час. Панель публикации перечитывается на каждое нажатие в поле имени
 * шага, и без этого каждый раз платился бы весь разворот заново.
 *
 * В памяти, а не в базе: своя таблица пережила бы удаление семинара
 * (`discardHistory`) и осталась бы лежать мусором, за которым некому прийти.
 * Забывать посчитанное не нужно и после удаления: `seq` — это AUTOINCREMENT на
 * всю базу, номер удалённой строки не достаётся никому другому, а сама память
 * выселяется по комнатам.
 */
const MEMO_ROOMS = 16
const memos = new Map<string, Map<number, number>>()

function memoFor(sessionId: string): Map<number, number> {
  const found = memos.get(sessionId)
  if (found) {
    // Перекладываем в конец: выселяется та комната, которую дольше всех не
    // открывали, а не та, которую первой открыли.
    memos.delete(sessionId)
    memos.set(sessionId, found)
    return found
  }
  const fresh = new Map<number, number>()
  memos.set(sessionId, fresh)
  for (const key of memos.keys()) {
    if (memos.size <= MEMO_ROOMS) break
    memos.delete(key)
  }
  return fresh
}

/**
 * Счётчик ячеек, идущий по строкам ВПЕРЁД одним документом.
 *
 * Сам проход — в `replay.ts`, общий с публикацией: разворачивать новый `Y.Doc`
 * на каждую строку означало платить снимок целиком (с выводами — мегабайты)
 * плюс все дельты после него, и так до четырёхсот раз подряд, синхронно, в
 * процессе, который в эту минуту держит сокеты комнаты. Здесь остаётся только
 * то, что своё: счёт ячеек и память о посчитанном.
 */
interface Walk {
  count(seq: number): number
  close(): void
}

function walk(sessionId: string): Walk {
  const memo = memoFor(sessionId)
  const replay = openReplay(sessionId)

  return {
    count(seq) {
      const known = memo.get(seq)
      if (known !== undefined) return known
      let n = 0
      try {
        n = getCells(replay.at(seq)).length
      } catch (err) {
        // Строка не разворачивается — шагом такая быть не может, а проход
        // после неё начинает с чистого документа сам (replay.ts).
        console.error(`publish: строка истории ${sessionId}#${seq} не разворачивается`, err)
      }
      memo.set(seq, n)
      return n
    },
    close: replay.close,
  }
}

function namedRows(sessionId: string): NamedRow[] {
  return (
    (selectNamed.all(sessionId, ...NAMED, MAX_NAMED) as NamedRow[])
      // Запрос отдаёт свежие первыми — студент идёт по времени вперёд. И проход
      // по возрастанию — то, на чём держится счёт одним документом.
      .sort((a, b) => a.seq - b.seq)
  )
}

function candidateOf(row: NamedRow, cellCount: number): Candidate {
  return {
    seq: row.seq,
    /*
     * Имя предлагается только там, где его написал человек. У `keyframe` и
     * `opened` его нет и быть не может: это служебные снимки, и «Снимок №14»
     * в рельсе у студента — не название момента, а признание, что назвать
     * его забыли.
     */
    label: row.kind === 'checkpoint' ? (row.label ?? '') : '',
    at: row.created_at,
    cellCount,
    kind: row.kind,
  }
}

export function candidatesFor(sessionId: string): Candidate[] {
  const rows = namedRows(sessionId)
  const walker = walk(sessionId)
  const out: Candidate[] = []
  try {
    for (const row of rows) {
      const cellCount = walker.count(row.seq)
      // Версия, которая не разворачивается в тетрадь, шагом быть не может.
      if (cellCount === 0) continue
      out.push(candidateOf(row, cellCount))
    }
  } finally {
    walker.close()
  }
  return out
}

/** Сколько строк проходить между вдохами. */
const CHUNK = 8

/**
 * То же, но с паузами: между кусками работы процесс успевает разослать кадры.
 *
 * Первый разворот истории комнаты за семестр — это всё равно секунды, и
 * пролежать их целиком на цикле событий значит на эти секунды остановить
 * синхронизацию и курсоры у всех, кто в комнате. Панель публикации ждать может,
 * занятие — нет.
 */
export async function candidatesForAsync(sessionId: string): Promise<Candidate[]> {
  const rows = namedRows(sessionId)
  const walker = walk(sessionId)
  const out: Candidate[] = []
  try {
    for (let i = 0; i < rows.length; i += 1) {
      if (i > 0 && i % CHUNK === 0) await new Promise((done) => setImmediate(done))
      const cellCount = walker.count(rows[i].seq)
      if (cellCount === 0) continue
      out.push(candidateOf(rows[i], cellCount))
    }
  } finally {
    walker.close()
  }
  return out
}
