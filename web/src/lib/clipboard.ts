import { tr } from '@shared/i18n'
/**
 * Copy text where there is no `navigator.clipboard`.
 *
 * The async clipboard exists only in a secure context: https or localhost. A
 * seminar hosted in a department at http://10.0.0.5:5173 is the usual way to
 * use it, and there the whole of `navigator.clipboard` is simply `undefined`.
 * Every "copy" button fell into its own catch and at best printed the link on
 * screen, while in SessionScreen it silently did nothing.
 *
 * The old `document.execCommand('copy')` works in this context. It has been
 * declared deprecated, and rightly so — but no replacement is offered where it
 * is called, so it stays as the fallback while such installations exist.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Permission was denied or the context is not right after all — down to
      // the fallback.
    }
  }

  const field = document.createElement('textarea')
  field.value = text
  // Off screen, but in the document and not hidden: an invisible field copies nothing.
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.top = '-1000px'
  field.style.opacity = '0'
  document.body.append(field)

  // Whatever was selected before the click is not ours, and we must put it back.
  const selection = document.getSelection()
  const had = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

  try {
    field.select()
    field.setSelectionRange(0, text.length)
    if (!document.execCommand('copy')) throw new Error(tr('room.ui.1043'))
  } finally {
    field.remove()
    if (had && selection) {
      selection.removeAllRanges()
      selection.addRange(had)
    }
  }
}
