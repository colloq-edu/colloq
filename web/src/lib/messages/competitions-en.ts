/*
 * The same as competitions-ru.ts, in the other language; see room-ru.ts about
 * the two kinds of file.
 */
import { registerMessages } from '@shared/i18n-runtime'
import { commonMessages } from '@shared/locales/common'
import { competitionsMessages } from '@shared/locales/competitions'
import { serverMessages } from '@shared/locales/server'

registerMessages(commonMessages, competitionsMessages, serverMessages)
