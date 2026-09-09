import { tr } from '@shared/i18n'
/**
 * Замок на ячейке — что делает щелчок и что обещает подсказка.
 *
 * Щелчок остаётся щелчком: закрыта ↔ открыта, без меню и без диалога, потому
 * что ячейку открывают посреди фразы, не отводя глаз от аудитории, и ошибка
 * чинится тем же нажатием. А вот КУДА открывает щелчок, решает правило комнаты
 * (shared/rules.ts · `opens`): в лекции — общий текст всем, в консилиуме —
 * каждому свой лист. Сервер читает это правило в control.ts на `cell:open`;
 * здесь то же правило читается для подсказки и для второго нажатия — иначе
 * кнопка обещала бы «открыть комнате», а открывала консилиум, и после первого
 * щелчка в консилиумной комнате второй раскрывал бы меню вместо того, чтобы
 * закрыть ячейку.
 *
 * Меню остаётся за удержанием, правой кнопкой и — в комнате, где щелчок
 * открывает всем, — за щелчком по замку в положении «консилиум»: туда щелчком
 * не попадали, и одно нажатие не знает, куда вернуть.
 */
import type { CellLock } from '@shared/notebook'
import type { RoomRules } from '@shared/rules'

export type Opens = RoomRules['opens']

/** Что делает одно нажатие на замок: шлёт `cell:open` или раскрывает меню. */
export type LockPress = { kind: 'open'; open: boolean } | { kind: 'menu' }

export function lockPress(state: CellLock, opens: Opens): LockPress {
  if (state === 'closed') return { kind: 'open', open: true }
  // Положение, в которое щелчок не приводит, щелчком и не снимается: там
  // одно нажатие не знает, закрыть или открыть всем.
  if (state === 'council' && opens !== 'council') return { kind: 'menu' }
  return { kind: 'open', open: false }
}

/** aria-label кнопки: коротко, что случится по нажатию. */
export function lockLabel(state: CellLock, opens: Opens): string {
  if (state === 'closed') {
    return opens === 'council'
      ? tr('room.ui.1078')
      : tr('room.ui.1079')
  }
  if (state === 'council' && opens !== 'council') return tr('room.ui.1080')
  return tr('room.ui.1081')
}

/** Подсказка кнопки: что по щелчку и что по удержанию. */
export function lockHint(state: CellLock, opens: Opens): string {
  if (opens === 'council') {
    // Удержание ведёт в меню, где есть и общий текст: щелчком его здесь не взять.
    if (state === 'closed') return tr('room.ui.1082')
    if (state === 'council') return tr('room.ui.1083')
    return tr('room.ui.1083')
  }
  if (state === 'closed') return tr('room.ui.1084')
  if (state === 'council') return tr('room.ui.1085')
  return tr('room.ui.1083')
}
