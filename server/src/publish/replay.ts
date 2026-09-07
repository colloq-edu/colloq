/**
 * Проход по истории комнаты одним документом.
 *
 * Развернуть тетрадь «на момент строки N» стоит снимка целиком (с выводами —
 * мегабайты) плюс всех дельт после него. Пока это делалось на каждую строку
 * заново, столько раз оно и стоило: до четырёхсот раз у панели кандидатов и до
 * сорока у публикации, синхронно, в процессе, который в эту минуту держит
 * сокеты чужого занятия.
 *
 * Здесь снимок и каждая дельта применяются по одному разу на весь проход:
 * документ идёт от строки к строке вперёд, а собирается заново только там, где
 * между ними появился новый снимок — тогда он дешевле дельт, которые он собой
 * и заменил. Это же условие спасает от подрезанной на ходу истории (db.ts ·
 * trimHistory): она оставляет за собой кейфрейм, и проход, увидев его впереди
 * своего состояния, начинает с него, а не досчитывает по строкам, которых уже
 * нет.
 *
 * Порядок — по возрастанию `seq`, и только он: назад документ не отматывается
 * (CRDT так не умеет), и просьба о строке ниже уже пройденной собирает новый.
 *
 * Строка, которая не разворачивается, роняет `at` наружу — и документ при этом
 * бросается: в нём половина применённого, и следующая строка обязана начать с
 * чистого. Что значит такая строка, решает зовущий: панель кандидатов считает
 * её пустой, публикация — сломанным шагом.
 *
 * Правило «повтор начинается с ближайшего кейфрейма» живёт в db.ts
 * (`updatesUpTo`) и здесь не повторяется: оттуда берётся начало прохода, а
 * запрос ниже — только его продолжение поверх состояния, которое уже собрано.
 */
import * as Y from 'yjs'
import { db, updatesUpTo } from '../db.js'

/** Ближайший снимок целого документа не выше строки. */
const selectKeyframeAt = db.prepare(`
  SELECT seq FROM doc_history
  WHERE session_id = ? AND seq <= ? AND kind = 'keyframe'
  ORDER BY seq DESC LIMIT 1
`)

/** Строки, которых в уже собранном документе ещё нет. */
const selectAfter = db.prepare(`
  SELECT update_blob FROM doc_history
  WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC
`)

/** Помечает записи, сделанные повтором, — как и в остальной публикации. */
const ORIGIN = 'publish'

export interface Replay {
  /** Тетрадь на момент строки: тот же документ, продвинутый вперёд. */
  at(seq: number): Y.Doc
  /** Отпустить документ: пока проход открыт, он держит всю тетрадь в памяти. */
  close(): void
}

export function openReplay(sessionId: string): Replay {
  let doc: Y.Doc | null = null
  /** До какой строки документ уже досчитан. */
  let applied = -1

  const drop = (): void => {
    doc?.destroy()
    doc = null
    applied = -1
  }

  const keyframeAt = (seq: number): number => {
    const row = selectKeyframeAt.get(sessionId, seq) as { seq: number } | undefined
    return row ? row.seq : 0
  }

  return {
    at(seq) {
      try {
        if (doc === null || seq < applied || keyframeAt(seq) > applied) {
          drop()
          const fresh = new Y.Doc()
          fresh.transact(() => {
            for (const update of updatesUpTo(sessionId, seq)) Y.applyUpdate(fresh, update, ORIGIN)
          })
          doc = fresh
        } else {
          const rows = selectAfter.all(sessionId, applied, seq) as { update_blob: Buffer }[]
          const same = doc
          same.transact(() => {
            for (const row of rows) Y.applyUpdate(same, new Uint8Array(row.update_blob), ORIGIN)
          })
        }
        applied = seq
        return doc
      } catch (err) {
        drop()
        throw err
      }
    },
    close: drop,
  }
}
