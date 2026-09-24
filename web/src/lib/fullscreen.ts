/**
 * Full screen — where it exists.
 *
 * The projection must take the whole screen: a Safari tab bar over a slide is
 * a Safari tab bar seen by the whole audience. But the API differs everywhere,
 * and the difference is not cosmetic: on iPad the unprefixed
 * `requestFullscreen` appeared only in Safari 16.4, before that there was the
 * WebKit-prefixed one, and on iPhone there is no element full screen at all,
 * so the button must not be shown there — it would simply do nothing.
 *
 * Hence three functions instead of one: ask whether it exists at all; request
 * it; release it. The projection works without it too — just with someone
 * else's frame around the edges.
 */

interface WebkitElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void
}

interface WebkitDocument extends Document {
  webkitFullscreenEnabled?: boolean
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}

/** Whether this browser can expand an element to full screen. */
export function fullscreenPossible(): boolean {
  const doc = document as WebkitDocument
  return doc.fullscreenEnabled === true || doc.webkitFullscreenEnabled === true
}

/** Whether it is expanding something right now. */
export function fullscreenNow(): boolean {
  const doc = document as WebkitDocument
  return (doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null) !== null
}

/**
 * Expand.
 *
 * Must be called from a click handler: the browser allows full screen only on
 * a live human gesture, and a call from an effect after navigation is
 * silently rejected. A refusal here is not an error — it is "not allowed", and
 * after it the projection keeps working in the window.
 */
export async function goFullscreen(node: HTMLElement): Promise<void> {
  const target = node as WebkitElement
  try {
    if (typeof target.requestFullscreen === 'function') await target.requestFullscreen()
    else if (typeof target.webkitRequestFullscreen === 'function') await target.webkitRequestFullscreen()
  } catch {
    /* refused — the window will do too */
  }
}

export async function leaveFullscreen(): Promise<void> {
  const doc = document as WebkitDocument
  try {
    if (!fullscreenNow()) return
    if (typeof doc.exitFullscreen === 'function') await doc.exitFullscreen()
    else if (typeof doc.webkitExitFullscreen === 'function') await doc.webkitExitFullscreen()
  } catch {
    /* already out */
  }
}
