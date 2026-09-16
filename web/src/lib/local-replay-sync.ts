import { messageSync, type WebsocketProvider } from 'y-websocket'
import { messageYjsSyncStep2 } from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import type { LocalStore } from './persistence.svelte'

/**
 * IndexedDB can finish after localhost's socket opens, or merge another tab's
 * cached updates later. These are reconciliation updates, not new keystrokes:
 * use the same message type and server validation as the opening handshake.
 * Ordinary edits retain y-websocket's handler and its smaller frame budget.
 * Session providers disable BroadcastChannel; the server is their only peer.
 */
export function syncLocalReplay(provider: WebsocketProvider, store: Pick<LocalStore, 'isReplay'>): void {
  const sendEdit = provider._updateHandler
  provider.doc.off('update', sendEdit)
  provider._updateHandler = (update: Uint8Array, origin: unknown) => {
    if (!store.isReplay(origin)) {
      sendEdit(update, origin)
      return
    }
    const ws = provider.ws
    // A disconnected provider will reconcile the document on its next handshake.
    if (!provider.wsconnected || !ws || ws.readyState !== ws.OPEN) return
    const frame = encoding.createEncoder()
    encoding.writeVarUint(frame, messageSync)
    encoding.writeVarUint(frame, messageYjsSyncStep2)
    encoding.writeVarUint8Array(frame, update)
    ws.send(encoding.toUint8Array(frame))
  }
  // Keep the replacement in _updateHandler so provider.destroy removes it.
  provider.doc.on('update', provider._updateHandler)
}
