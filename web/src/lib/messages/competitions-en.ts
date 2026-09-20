/*
 * То же, что competitions-ru.ts, другим языком; см. room-ru.ts про два вида файла.
 */
import { registerMessages } from '@shared/i18n-runtime'
import { commonMessages } from '@shared/locales/common'
import { competitionsMessages } from '@shared/locales/competitions'
import { serverMessages } from '@shared/locales/server'

registerMessages(commonMessages, competitionsMessages, serverMessages)
