import { tr } from '@shared/i18n'
/**
 * Консилиум на клиенте — чистая арифметика пульта, без Svelte и без сокета.
 *
 * Здесь остаётся то, что читают ОБА оставшихся места: окно пульта
 * (components/council/pult) и плашка показанного. Группировка, слово в чипе
 * состояния, имя группы и состояние оракула — по одной копии на клиент:
 * сложенное в двух местах рано или поздно складывается по-разному.
 *
 * Порядок стопки, сегменты полосы групп, соседи по стрелкам и «редкие группы»
 * жили здесь, пока консоль стояла под ячейкой карточкой с «‹ ›». Консоль
 * переехала в отдельное окно и стала лентой (council-pult.ts), и считать
 * стопку больше некому — эти функции ушли вместе с ней, а не остались «на
 * будущее»: непозванный код с тестом читается как работающая возможность.
 *
 * Ключ группы попыткам ставит сервер той же `normalizeAttempt`, что
 * реэкспортирована отсюда: пульт по нему только группирует, не пересчитывает.
 */
import type { CouncilAttempt, CouncilGroup, CouncilOracle } from '@shared/protocol'
import { groupAttempts } from '@shared/protocol'
export { normalizeAttempt } from '@shared/notebook'

/*
 * Группировка — общая, из shared/protocol.ts.
 *
 * Здесь лежали свои `bySubmission` и `groupAttempts`, третья копия одного и
 * того же правила: своя была у серверной стопки, своя у оракула, своя у
 * пульта, — и они уже разошлись разрывом при равенстве. Разрыв решает, кто
 * представитель группы, то есть чей код стоит первым в ленте и на чью группу
 * ложится черновик ответа; при расхождении «так же ещё 311» и размер группы
 * считались от разных наборов. `CouncilAttempt` подходит под `GroupMember` как
 * есть — `groupKey` ему ставит сервер той же `normalizeAttempt`.
 */
export { groupAttempts }

/**
 * Слово в чипе состояния. Для упавшей — имя исключения, потому что «ошибка»
 * ничего не говорит, а `TypeError` в чипе сразу отвечает, что показать классу.
 */
export function statusLabel(attempt: Pick<CouncilAttempt, 'status' | 'run'>): string {
  switch (attempt.status) {
    case 'correct':
      return tr('room.ui.1046')
    case 'wrong':
      return tr('room.ui.1047')
    case 'failed': {
      const error = attempt.run?.outputs.find((o) => o.kind === 'error')
      return error && error.kind === 'error' && error.ename ? error.ename : tr('room.ui.1048')
    }
    case 'ran':
      return tr('room.ui.1049')
    default:
      return tr('room.ui.1050')
  }
}

/** Имя группы: от оракула, а пока его нет — первая непустая строка кода. */
export function groupTitle(group: Pick<CouncilGroup, 'label' | 'sample'>): string {
  if (group.label) return group.label
  const line = group.sample.split('\n').find((l) => l.trim())
  return line?.trim() ?? tr('room.ui.1051')
}

export type OracleView = 'idle' | 'reading' | 'ready' | 'stale'

/**
 * В каком состоянии рисовать вкладку оракула. «Отстала» — счёт на месте, по
 * числу сдавших против `basedOn`: сводка обновляется только рукой, и о чужой
 * сдаче сервер ей ничего не говорит — `council:oracle` на «Сдать» не ходит
 * намеренно. Своего `stale` у сервера нет и не было: в кадре приезжают только
 * три остальных состояния.
 */
export function oracleState(oracle: CouncilOracle | null, submitted: number): OracleView {
  if (!oracle) return 'idle'
  if (oracle.state === 'idle' || oracle.state === 'reading') return oracle.state
  return submitted > oracle.basedOn ? 'stale' : 'ready'
}

/** «С тех пор сдали ещё N» — разница с тем, сколько попыток модель читала. */
export function staleBy(oracle: CouncilOracle, submitted: number): number {
  return Math.max(submitted - oracle.basedOn, 0)
}
