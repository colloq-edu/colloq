/*
 * Словарь читалки — один язык; про два вида файла см. room-ru.ts.
 *
 * Публичные страницы рисуют тетрадь и её вывод, то есть говорят словами
 * комнаты; своего каталога у них нет. Серверный — тот же урезанный набор слов
 * состояния, что и у комнаты: тетрадь в читалке та же самая, и подписи под
 * ячейками в ней те же.
 */
import { registerMessages } from '@shared/i18n-runtime'
import { commonMessages } from '@shared/locales/common'
import { roomMessages } from '@shared/locales/room'
import { serverMessages } from '@shared/locales/server'

registerMessages(commonMessages, roomMessages, serverMessages)
