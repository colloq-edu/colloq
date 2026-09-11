import { registerMessages } from '@shared/i18n-runtime'
import { commonMessages } from '@shared/locales/common'
import { roomMessages } from '@shared/locales/room'
import { adminMessages } from '@shared/locales/admin'
import { serverMessages } from '@shared/locales/server'
import { activityMessages } from '@shared/locales/activity'

registerMessages(commonMessages, roomMessages, adminMessages, serverMessages, activityMessages)
