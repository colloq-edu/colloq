/*
 * Словарь панели преподавателя — один язык; про два вида файла см. room-ru.ts.
 *
 * `room` здесь не лишний: панель показывает карточки семинаров и их правила
 * теми же словами, что и комната.
 */
import { registerMessages } from '@shared/i18n-runtime'
import { commonMessages } from '@shared/locales/common'
import { adminMessages } from '@shared/locales/admin'
import { roomMessages } from '@shared/locales/room'
import { activityMessages } from '@shared/locales/activity'
import { serverMessages } from '@shared/locales/server'
/* Слова соревнований — общие с `/k`: плашки исходов и состояние соревнования
   панель берёт оттуда, чтобы у преподавателя и у студента они не разъехались. */
import { competitionsMessages } from '@shared/locales/competitions'

registerMessages(
  commonMessages,
  adminMessages,
  roomMessages,
  activityMessages,
  serverMessages,
  competitionsMessages,
)
