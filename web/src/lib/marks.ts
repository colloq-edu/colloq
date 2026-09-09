/**
 * Метки комнаты — список и правило выдачи — переехали в shared/marks.ts.
 *
 * Не по вкусу к общим папкам: судьёй уникальности стал сервер (он подменяет
 * занятую метку свободной на входе, routes/sessions.ts · `/join`), а выбирать
 * ему не из чего, кроме этого самого списка. Пока список был только здесь,
 * второй копии было взяться неоткуда — кроме как написать её на сервере, и
 * тогда две сорокастрочные таблицы эмодзи разъезжались бы молча: сервер выдал
 * бы зверя, которого браузер не рисует вовсе (см. `isMark`).
 *
 * Имена остаются прежними, чтобы экран входа, картинка человека и подборщик
 * метки продолжали спрашивать их у своего соседа, а не у общей папки.
 */
import { tr } from '@shared/i18n'
import { MARKS as sourceMarks, markName as sourceMarkName } from '@shared/marks'
export { freeMark, isMark, type Mark, type MarkSet } from '@shared/marks'
/** Labels are getters so an open picker follows the instance language. */
export const MARKS = sourceMarks.map(entry => ({
  mark: entry.mark,
  get name() { return tr('room.mark.' + entry.name) },
  get alt() { return [entry.name, entry.alt, entry.name === 'sauropod' || entry.name === 'T. rex' ? 'динозавр' : ''].filter(Boolean).join(' ') },
}))
export function markName(mark: string | null): string { return tr('room.mark.' + sourceMarkName(mark)) }
