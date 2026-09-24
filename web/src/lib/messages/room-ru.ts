/*
 * The room's dictionary — one language, and only the catalogs the room reads.
 *
 * The file exists in two forms. This one is the source: node and the tests
 * load it, and it registers the catalogs whole, in both languages. In the
 * build its contents are replaced by the `colloq-screen-language` plugin
 * (web/vite.config.ts): it takes the catalogs listed below, keeps ONE language
 * of them — the one in the file name — and cuts `server` down to the keys the
 * browser can actually look up. So the list of imports here is not decoration
 * but the very place the plugin learns the area's contents from; the contents
 * must be changed here.
 *
 * The second language is loaded only once it is chosen — see
 * screen-language.ts.
 */
import { registerMessages } from '@shared/i18n-runtime'
import { commonMessages } from '@shared/locales/common'
import { roomMessages } from '@shared/locales/room'
import { activityMessages } from '@shared/locales/activity'
import { serverMessages } from '@shared/locales/server'

registerMessages(commonMessages, roomMessages, activityMessages, serverMessages)
