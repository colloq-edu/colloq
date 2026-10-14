/**
 * A machine's text in this server's words (§13b note 9). The machine's
 * bundle carries no translations: the sentences its core builds come as
 * markers (shared/remote-runner.ts · remoteTextMarker), and home renders each
 * in its own language when it takes the text in — an outcome's detail and
 * log, a decline's detail, a problem's detail. A key this server does not
 * know (a newer build's) reads as the bare key, as translate answers one.
 *
 * A module of its own that imports only the translations and the contract,
 * so that the views (remote/views.ts) can render a problem without pulling
 * the queue's pump in behind them.
 */
import { hasTranslation, tr } from '@shared/i18n'
import { remoteRenderTexts } from '@shared/remote-runner'

export function homeWords(text: string): string {
  return remoteRenderTexts(text, (key, params) => tr(key, params), hasTranslation)
}
