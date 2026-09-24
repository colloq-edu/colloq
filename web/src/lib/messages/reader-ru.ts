/*
 * The reader's dictionary — one language; about the two kinds of file see
 * room-ru.ts.
 *
 * Public pages draw a notebook and its output, that is, they speak in the
 * room's words; they have no catalog of their own. The server one is the same
 * trimmed set of status words as the room's: the notebook in the reader is the
 * very same, and so are the captions under its cells.
 */
import { registerMessages } from '@shared/i18n-runtime'
import { commonMessages } from '@shared/locales/common'
import { roomMessages } from '@shared/locales/room'
import { serverMessages } from '@shared/locales/server'

registerMessages(commonMessages, roomMessages, serverMessages)
