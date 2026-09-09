import { tr } from '@shared/i18n'
/**
 * Одна кнопка на все состояния выполнения ячейки.
 *
 * Первое место в тулбаре над ячейкой всегда рисовало «запустить» — и на
 * работающей ячейке, и на стоящей в очереди. Нажатие в этот момент уходило на
 * сервер и там молча выбрасывалось: `requestRun` пропускает ячейку, которая уже
 * выполняется, и ячейку, которая уже в очереди. То есть кнопка была включена,
 * обещала действие и не делала ничего — а «стоп» тем временем жил внизу ячейки,
 * в другом месте и другой формы. Отсюда и жалоба: странно сделано.
 *
 * Теперь это один слот с тремя лицами: запуск на успокоившейся ячейке, отмена
 * на стоящей в очереди, стоп на работающей. Решение вынесено сюда, потому что
 * шесть исходов и три правила доступа посреди разметки — это ровно тот способ,
 * которым была написана исходная неправда.
 *
 * Импортируется только `@shared/notebook` и соседний `./controls`: путь `@/`
 * знает сборщик, но не знает tsx, а этот модуль обязан оставаться проверяемым.
 */
import type { CellState } from '@shared/notebook'
import { controlDisabled, controlTitle } from './controls'

export interface RunSlotGates {
  connected: boolean
  /** Правила комнаты разрешают этому человеку запускать ячейки. */
  mayRun: boolean
  /** Он же поставил её в очередь, либо он ведущий. */
  canCancel: boolean
  /** Он же её запустил, либо он ведущий. */
  canInterrupt: boolean
}

export interface RunSlot {
  action: 'run' | 'cancel' | 'interrupt'
  icon: 'play' | 'x' | 'stop'
  size: 11 | 12 | 13
  /** Класс цвета для самого значка. */
  tint: string
  label: string
  disabled: boolean
  title: string
}

export function runSlot(state: CellState, gates: RunSlotGates): RunSlot {
  const { connected } = gates

  if (state === 'running') {
    return {
      action: 'interrupt',
      icon: 'stop',
      size: 11,
      // Не акцентный: на работающей ячейке акцентом горит всё остальное —
      // полоса, номер, слово RUNNING. Кнопка остановки, выкрашенная тем же
      // цветом, спорила бы с состоянием, о котором он и говорит.
      tint: 'text-ink',
      get label() { return tr('room.ui.1163') },
      disabled: controlDisabled(connected, gates.canInterrupt),
      title: controlTitle(
        connected,
        gates.canInterrupt
          ? tr('room.ui.1163')
          : tr('room.ui.1164'),
      ),
    }
  }

  if (state === 'queued') {
    return {
      action: 'cancel',
      icon: 'x',
      size: 13,
      tint: 'text-ink',
      get label() { return tr('room.ui.1165') },
      disabled: controlDisabled(connected, gates.canCancel),
      /*
       * Фраза отказа здесь новая, и она понадобилась именно из-за этого слота.
       *
       * Внизу ячейки «отменить» просто прячут, когда нельзя, — там это
       * последняя кнопка в ряду, и её исчезновение ничего не двигает. В
       * тулбаре спрятать первый слот значит подвинуть «вверх» и «вниз» под
       * курсор, который целился в одну из них. Поэтому здесь гасят, а гашёная
       * кнопка обязана уметь объяснить себя.
       */
      title: controlTitle(
        connected,
        gates.canCancel
          ? tr('room.ui.1166')
          : tr('room.ui.1167'),
      ),
    }
  }

  return {
    action: 'run',
    icon: 'play',
    size: 12,
    tint: 'text-accent-text',
    get label() { return tr('room.ui.1168') },
    disabled: controlDisabled(connected, gates.mayRun),
    title: controlTitle(
      connected,
      gates.mayRun ? tr('room.ui.1168') : tr('room.ui.1169'),
    ),
  }
}
