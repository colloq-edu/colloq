/**
 * What this device is, in the words the lecture uses ("presented from the
 * iPad", "taken over · Mac · 21:14").
 *
 * Read here, in the browser, because only the browser can tell: iPadOS
 * Safari introduces itself to the server as a Mac (desktop-class browsing),
 * and the one thing that gives it away is a touch screen, which a server
 * never sees. The server accepts only the names in `DEVICE_KINDS`.
 */
import type { DeviceKind } from '@shared/lecture'

export function deviceKindOf(agent: string, touchPoints: number): DeviceKind {
  if (/iPad/.test(agent)) return 'ipad'
  if (/iPhone|iPod/.test(agent)) return 'iphone'
  // A "Mac" with a touch screen is an iPad asking for the desktop site.
  if (/Macintosh|Mac OS X/.test(agent)) return touchPoints > 1 ? 'ipad' : 'mac'
  if (/Android/.test(agent)) return /Mobile/.test(agent) ? 'android' : 'android-tablet'
  if (/CrOS/.test(agent)) return 'chromebook'
  if (/Windows/.test(agent)) return 'windows'
  if (/Linux|X11/.test(agent)) return 'linux'
  return 'other'
}

export function deviceKind(): DeviceKind {
  if (typeof navigator === 'undefined') return 'other'
  return deviceKindOf(navigator.userAgent ?? '', navigator.maxTouchPoints ?? 0)
}
