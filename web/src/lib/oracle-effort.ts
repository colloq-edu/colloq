/**
 * The reasoning effort, remembered in the browser.
 *
 * Not a room rule and not a person's setting on the server: it is the same as
 * "Ask/Do" next to the field — a choice that holds between questions and
 * concerns nobody but this tab. The room has more rules than fit on the
 * screen already, and a person who set "right away" wants it for today, not
 * for the whole seminar.
 *
 * `null` — "as on the instance": then neither an `effort` field nor anything
 * else goes into the request, and other instances behave exactly as before
 * this knob. It is also the default.
 */
import type { ReasoningEffort } from '@shared/admin'
import { isReasoningEffort } from '@shared/admin'

const KEY = 'colloq.oracle.effort'

/**
 * What is chosen in this browser. Any read error means "as on the instance":
 * a private window, blocked site data and a foreign string in the key must
 * not get in the way of asking.
 */
export function rememberedEffort(): ReasoningEffort | null {
  try {
    const raw = localStorage.getItem(KEY)
    return isReasoningEffort(raw) ? raw : null
  } catch {
    return null
  }
}

/** Remember the choice; `null` erases the entry — back to the instance default. */
export function rememberEffort(effort: ReasoningEffort | null): void {
  try {
    if (effort === null) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, effort)
  } catch {
    /* could not remember it — the choice still holds until the tab closes */
  }
}
