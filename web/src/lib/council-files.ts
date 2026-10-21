/**
 * A pool attempt's own file, taken (docs/architecture/remote-classes.md §9.7,
 * D10): what the attempt wrote into its folder on the machine, kept here and
 * named on its card — its author's, from their sheet (CellView), and the
 * teachers', from the console's work (PultWork).
 *
 * Two steps, as for a class folder's file (FilesPanel · download): a ticket
 * asked with the session's token in a header, then an anchor that carries
 * the ticket alone — good for this one file for five minutes, never the
 * token that opens the control socket.
 */
import { tr } from '@shared/i18n'
import { api } from '@/lib/api'

/** Let the browser take the file; the refusal's words when it would not come (null — it went). */
export async function takeAttemptFile(sessionId: string, token: string, cellId: string, participantId: string, name: string): Promise<string | null> {
  try {
    const ticket = await api.councilFileTicket(sessionId, cellId, participantId, name, token)
    const anchor = document.createElement('a')
    anchor.href = api.councilFileUrl(sessionId, cellId, participantId, name, ticket.token)
    anchor.download = name.slice(name.lastIndexOf('/') + 1)
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    return null
  } catch (error) {
    return error instanceof Error ? tr(error.message) : tr('room.ui.612')
  }
}
