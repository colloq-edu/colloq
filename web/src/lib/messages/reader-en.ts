/*
 * The same as reader-ru.ts, in the other language; see room-ru.ts about the
 * two kinds of file.
 */
import { registerMessages } from '@shared/i18n-runtime'
import { commonMessages } from '@shared/locales/common'
import { roomMessages } from '@shared/locales/room'
import { serverMessages } from '@shared/locales/server'

registerMessages(commonMessages, roomMessages, serverMessages)
