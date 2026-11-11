import { tr } from '@shared/i18n'

/** A bounded latest exception shares the text ceiling with streams and notices. */
export function boundedOutputError(
  ename: string, evalue: string, traceback: string[],
  maxChars: number, lineChars: number, maxLines: number,
): { ename: string; evalue: string; traceback: string[] } {
  const clip = (text: string, max: number): string => text.length <= max ? text
    : tr('server.colloqMoreCharactersCutHere.cfc854', { p0: text.slice(0, max), p1: text.length - max })
  // Select frames before clipping: a pathological traceback may have millions.
  const frames = traceback.length > maxLines
    ? [...traceback.slice(0, 20), tr('server.moreFrames.6caf4c', { p0: traceback.length - maxLines + 1 }), ...traceback.slice(-(maxLines - 21))]
    : traceback
  const result = { ename: clip(ename, lineChars), evalue: clip(evalue, lineChars), traceback: frames.map(line => clip(line, lineChars)) }
  // JSON escaping costs bytes too. Drop middle frames first, preserving the
  // final useful frame and the exception name/value for as long as possible.
  let chars = JSON.stringify(result).length
  while (chars > maxChars && result.traceback.length > 1) {
    const [removed] = result.traceback.splice(Math.floor((result.traceback.length - 1) / 2), 1)
    chars -= JSON.stringify(removed).length + 1 // Removed frame and its comma.
  }
  while (JSON.stringify(result).length > maxChars) {
    if (result.traceback[0] && result.traceback[0].length > 128) result.traceback[0] = clip(result.traceback[0], Math.floor(result.traceback[0].length / 2))
    else if (result.evalue.length > 128) result.evalue = clip(result.evalue, Math.floor(result.evalue.length / 2))
    else if (result.ename.length > 128) result.ename = clip(result.ename, Math.floor(result.ename.length / 2))
    else break
  }
  return result
}
