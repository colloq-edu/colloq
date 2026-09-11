/*
 * Словарь комнаты — один язык, и только те каталоги, которые комната читает.
 *
 * Файл существует в двух видах. Этот — исходный: его грузят node и тесты, и он
 * регистрирует каталоги целиком, обоими языками. В сборке его содержимое
 * подменяет плагин `colloq-screen-language` (web/vite.config.ts): он берёт
 * перечисленные ниже каталоги, оставляет от них ОДИН язык — тот, что в имени
 * файла, — и режет `server` до ключей, которые браузер правда умеет искать.
 * Поэтому список импортов здесь — не украшение, а то самое место, откуда
 * плагин узнаёт состав области; менять состав надо здесь.
 *
 * Второй язык догружается только когда его выбрали, — см. screen-language.ts.
 */
import { registerMessages } from '@shared/i18n-runtime'
import { commonMessages } from '@shared/locales/common'
import { roomMessages } from '@shared/locales/room'
import { activityMessages } from '@shared/locales/activity'
import { serverMessages } from '@shared/locales/server'

registerMessages(commonMessages, roomMessages, activityMessages, serverMessages)
