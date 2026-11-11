/*
 * The room dictionary's catalog sources. Node tests register them whole;
 * the build keeps the selected language and the keys in SessionScreen's
 * static dependency graph, excluding copy already registered by the entry.
 *
 * room-extra carries the rest. loadLocalizedFeature registers it before an
 * optional component evaluates, and reloadAreaMessages includes it after a
 * language switch once such a feature has been opened.
 */
import { registerMessages } from '@shared/i18n-runtime'
import { commonMessages } from '@shared/locales/common'
import { roomMessages } from '@shared/locales/room'
import { activityMessages } from '@shared/locales/activity'
import { serverMessages } from '@shared/locales/server'

registerMessages(commonMessages, roomMessages, activityMessages, serverMessages)
