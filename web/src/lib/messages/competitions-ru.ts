/*
 * Словарь страниц соревнований — один язык; про два вида файла см. room-ru.ts.
 *
 * Свой набор, а не комнатный: `/k/**` — это ни комната, ни панель, ни читалка.
 * Общие слова («Обновить страницу», отказы сервера) и каталог соревнований —
 * всё, что здесь говорят; тетради, ячеек и ядра на этих страницах нет.
 */
import { registerMessages } from '@shared/i18n-runtime'
import { commonMessages } from '@shared/locales/common'
import { competitionsMessages } from '@shared/locales/competitions'
import { serverMessages } from '@shared/locales/server'

registerMessages(commonMessages, competitionsMessages, serverMessages)
