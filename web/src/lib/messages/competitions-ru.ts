/*
 * The competition pages' dictionary — one language; about the two kinds of
 * file see room-ru.ts.
 *
 * A set of its own, not the room's: `/k/**` is neither the room nor the panel
 * nor the reader. The common words ("Reload the page", server refusals) and
 * the competitions catalog are all that is said here; there are no notebooks,
 * cells or kernel on these pages.
 */
import { registerMessages } from '@shared/i18n-runtime'
import { commonMessages } from '@shared/locales/common'
import { competitionsMessages } from '@shared/locales/competitions'
import { serverMessages } from '@shared/locales/server'

registerMessages(commonMessages, competitionsMessages, serverMessages)
