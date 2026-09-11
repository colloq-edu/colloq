import entryMessages from 'virtual:colloq-entry-messages'
import { registerMessages } from '@shared/i18n-runtime'
export * from '@shared/i18n-runtime'

// Generated from the static entry graph, with both languages intact. The
// language chosen by the server can therefore paint correctly immediately.
registerMessages(entryMessages)
