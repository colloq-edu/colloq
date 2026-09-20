/** Explicit UI translations. User content and protocol values never pass through this layer. */
import { commonMessages } from './locales/common.js'
import { adminMessages } from './locales/admin.js'
import { roomMessages } from './locales/room.js'
import { serverMessages } from './locales/server.js'
import { activityMessages } from './locales/activity.js'
import { competitionsMessages } from './locales/competitions.js'
import { registerMessages } from './i18n-runtime.js'
export * from './i18n-runtime.js'

// Server and source-level tests keep the complete dictionary. Vite uses the
// small browser entry dictionary and loads these catalogs with later screens.
registerMessages(
  commonMessages,
  adminMessages,
  roomMessages,
  serverMessages,
  activityMessages,
  competitionsMessages,
)
