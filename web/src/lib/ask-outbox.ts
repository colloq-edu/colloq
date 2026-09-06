/**
 * Вопрос, который уже отправлен, но ещё не вернулся из документа.
 *
 * Между Enter и появлением вопроса в общей ленте лежит целый круг: HTTP до
 * сервера через ретранслятор, запись в документ комнаты, рассылка обратно по
 * сокету. На семинаре это доли секунды, и видно их прекрасно — поле опустело,
 * а в ленте пусто, и человек нажимает Enter второй раз. Поэтому вопрос встаёт
 * в ленту сразу, своей строкой, а настоящая запись потом занимает её место.
 *
 * Модуль чистый: сюда ходит тест, и здесь нет ни сокетов, ни документа.
 */
import type { ChatSnapshot } from '@shared/notebook'

export interface Outgoing {
  /** Строка, нарисованная этой вкладкой. Формой — та же запись ленты. */
  row: ChatSnapshot
  /**
   * Записи, которые лежали в ленте, когда вопрос уходил.
   *
   * По ним отличают «мой вопрос доехал» от «мой такой же вопрос, заданный
   * десять минут назад». Без этого Retry на собственном вопросе снимал бы
   * свежую строку в тот же кадр, в который её поставили, — и человек снова
   * видел бы пустоту, ровно ту, от которой всё это и заведено.
   */
  before: ReadonlySet<string>
}

/**
 * Собрать строку для вопроса, который сейчас уйдёт.
 *
 * Форма — настоящей записи ленты, вплоть до `state: 'streaming'`: строка
 * обязана выглядеть как то, чем станет, иначе замена будет видна рывком. Всё,
 * чего у неё не может быть (ответ, размышление, шаги, предложение), — пусто,
 * и это правда: сервер ещё не сказал ни слова.
 */
export function outgoingRow(input: {
  id: string
  me: { id: string; name: string; color: string }
  question: string
  action?: string | null
  cellId?: string | null
  cellIds?: string[]
  mode?: 'ask' | 'agent'
  at: number
}): ChatSnapshot {
  return {
    id: input.id,
    participantId: input.me.id,
    name: input.me.name,
    color: input.me.color,
    question: input.question,
    action: input.action ?? null,
    cellId: input.cellId ?? input.cellIds?.[0] ?? null,
    cellIds: input.cellIds ?? [],
    createdAt: input.at,
    answer: '',
    state: 'streaming',
    patch: null,
    patchBase: null,
    patchState: 'open',
    patchBy: null,
    reasoning: '',
    thoughtMs: null,
    mode: input.mode === 'agent' ? 'agent' : 'ask',
    steps: [],
    undo: 'none',
    undoBy: null,
  }
}

/**
 * Убрать те строки, чьи записи уже доехали.
 *
 * Своя запись узнаётся по автору и тексту — но только среди тех, которых при
 * отправке в ленте ещё не было. Два одинаковых вопроса подряд разбираются по
 * очереди: первая пришедшая запись достаётся первой отправленной, иначе одна
 * запись сняла бы обе строки и второй вопрос снова провалился бы в пустоту.
 */
export function settleOutbox(
  pending: readonly Outgoing[],
  fresh: readonly ChatSnapshot[],
): Outgoing[] {
  if (pending.length === 0) return pending as Outgoing[]
  const taken = new Set<string>()
  const left = pending.filter((mine) => {
    const landed = fresh.find(
      (entry) =>
        !taken.has(entry.id) &&
        !mine.before.has(entry.id) &&
        entry.participantId === mine.row.participantId &&
        entry.question === mine.row.question,
    )
    if (!landed) return true
    taken.add(landed.id)
    return false
  })
  /*
   * Ничего не сняли — отдаём ТОТ ЖЕ массив, а не его копию.
   *
   * `filter` всегда выделяет новый, и вызывающий, сравнивая по ссылке, писал
   * бы новое значение на каждый кадр ленты. Один раз это уже стоило комнате
   * бесконечного цикла эффектов, и подпорка стоит одной строки.
   */
  return left.length === pending.length ? (pending as Outgoing[]) : left
}
