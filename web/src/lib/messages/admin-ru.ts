/*
 * The teacher panel's dictionary — one language; about the two kinds of file
 * see room-ru.ts.
 *
 * `room` is not superfluous here: the panel shows seminar cards and their
 * rules in the same words as the room.
 */
import { registerMessages } from '@shared/i18n-runtime'
import { commonMessages } from '@shared/locales/common'
import { adminMessages } from '@shared/locales/admin'
import { roomMessages } from '@shared/locales/room'
import { activityMessages } from '@shared/locales/activity'
import { serverMessages } from '@shared/locales/server'
/* The competition words are shared with `/k`: the panel takes the outcome
   badges and the competition state from there, so that the teacher's and the
   student's do not drift apart. */
import { competitionsMessages } from '@shared/locales/competitions'

registerMessages(
  commonMessages,
  adminMessages,
  roomMessages,
  activityMessages,
  serverMessages,
  competitionsMessages,
)
