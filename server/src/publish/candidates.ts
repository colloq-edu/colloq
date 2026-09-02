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
import * as Y from 'yjs'
import { db, updatesUpTo } from '../db.js'
import { getCells } from '@shared/notebook'

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
 * Сколько ячеек в тетради на момент этой версии — и есть ли она вообще.
 *
 * Разворачивается настоящий документ, а не читается `cells` из строки: там
 * лежит список изменённых ячеек всплеска, а не состав тетради. Считается тем же
 * путём, которым собирается страница (`readNotebook` → `getCells`): корень
 * `cells` — это первая тетрадь только пока её не удалили, а после удаления
 * счёт по нему давал ноль, и все чекпоинты второй тетради молча выпадали.
 */
function cellsAt(sessionId: string, seq: number): number {
  const doc = new Y.Doc()
  try {
    doc.transact(() => {
      for (const update of updatesUpTo(sessionId, seq)) Y.applyUpdate(doc, update, 'publish')
    })
    return getCells(doc).length
  } catch {
    return 0
  } finally {
    doc.destroy()
  }
}

export function candidatesFor(sessionId: string): Candidate[] {
  const rows = (selectNamed.all(sessionId, ...NAMED, MAX_NAMED) as NamedRow[])
    // Запрос отдаёт свежие первыми — студент идёт по времени вперёд.
    .sort((a, b) => a.seq - b.seq)

  const out: Candidate[] = []
  for (const row of rows) {
    const cellCount = cellsAt(sessionId, row.seq)
    // Версия, которая не разворачивается в тетрадь, шагом быть не может.
    if (cellCount === 0) continue
    out.push({
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
    })
  }
  return out
}
