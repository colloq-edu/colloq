/*
 * The same as room-ru.ts, in the other language; why there are two files and
 * where the build plugin learns the area's contents from is explained there.
 */
import { registerMessages } from '@shared/i18n-runtime'
import { commonMessages } from '@shared/locales/common'
import { roomMessages } from '@shared/locales/room'
import { activityMessages } from '@shared/locales/activity'
import { serverMessages } from '@shared/locales/server'

registerMessages(commonMessages, roomMessages, activityMessages, serverMessages)
