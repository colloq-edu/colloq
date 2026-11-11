// Optional room features register this catalog before module evaluation.
// The build keeps only keys absent from the entry and static room graph.
import { registerMessages } from '@shared/i18n-runtime'
import { commonMessages } from '@shared/locales/common'
import { roomMessages } from '@shared/locales/room'
import { activityMessages } from '@shared/locales/activity'
import { serverMessages } from '@shared/locales/server'

registerMessages(commonMessages, roomMessages, activityMessages, serverMessages)
