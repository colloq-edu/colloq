/*
 * То же, что reader-ru.ts, другим языком; см. room-ru.ts про два вида файла.
 */
import { registerMessages } from '@shared/i18n-runtime'
import { commonMessages } from '@shared/locales/common'
import { roomMessages } from '@shared/locales/room'
import { serverMessages } from '@shared/locales/server'

registerMessages(commonMessages, roomMessages, serverMessages)
