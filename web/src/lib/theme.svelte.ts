/**
 * Colour theme — the one piece of state in Colloq that is deliberately NOT
 * shared. The notebook, the kernel, the thread and the terminal are the room's;
 * whether the room is drawn on white or on navy is each viewer's own business,
 * so this never touches the Y.Doc or awareness.
 */
import type { ThemeName } from '@shared/protocol'

export type { ThemeName }

export interface ThemeStore {
  readonly current: ThemeName
  set(next: ThemeName): void
  toggle(): void
}

const STORAGE_KEY = 'colloq.theme.v1'

const media: MediaQueryList | null =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

function readStored(): ThemeName | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === 'light' || raw === 'dark' ? raw : null
  } catch {
    // Private browsing throws on access, not just on write.
    return null
  }
}

function systemTheme(): ThemeName {
  return media?.matches ? 'dark' : 'light'
}

/** null means "no choice made yet", which is what keeps us following the OS. */
let chosen: ThemeName | null = readStored()
let current = $state<ThemeName>(chosen ?? systemTheme())

function apply(next: ThemeName): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  // Always stamped, even when it only mirrors the OS, so anything that needs to
  // branch on the theme (the CodeMirror palette) can read one attribute.
  root.dataset.theme = next
  // index.html hard-codes class="dark" and a dark color-scheme meta; both are
  // wrong the moment someone picks light, and that file is not ours to edit.
  root.classList.toggle('dark', next === 'dark')
  root.style.colorScheme = next
}

function onSystemChange(event: MediaQueryListEvent): void {
  if (chosen) return
  current = event.matches ? 'dark' : 'light'
  if (!borrowed) apply(current)
}

/**
 * The neighbouring window of the same room — the council console — follows
 * the switch.
 *
 * The theme choice is stored per browser (`colloq.theme.v1`), not per tab,
 * and the second window must obey the same toggle: switch the theme in the
 * notebook, and the console next to it on a second monitor must repaint
 * along with it rather than wait for a reload. `storage` arrives only in
 * OTHER documents — the one that wrote has already repainted itself.
 *
 * `key === null` — storage was cleared entirely: we go back to the system
 * theme.
 */
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== STORAGE_KEY) return
  chosen = readStored()
  const next = chosen ?? systemTheme()
  if (next === current) return
  current = next
  // A screen that borrowed the theme (the lecture console) ignores a choice
  // made elsewhere: it is dark because of the physics of the lecture hall,
  // not by taste.
  if (!borrowed) apply(next)
}

let started = false

export function initTheme(): void {
  if (started) return
  started = true
  apply(current)
  media?.addEventListener('change', onSystemChange)
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
}

function setTheme(next: ThemeName): void {
  chosen = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // A preference we cannot persist is still worth honouring for this visit.
  }
  current = next
  apply(next)
}

/** A screen borrowed the theme: a choice made elsewhere does not repaint it. */
let borrowed = false

/**
 * Borrow a theme for the lifetime of one screen.
 *
 * The console is held in a dark lecture hall where only the projector shines:
 * a white 1180×820 slab in the teacher's hands shines in their face, is
 * visible to the front row and constricts the pupil that has to look at a
 * slide a second later. So the console is always dark — not by the tablet
 * owner's taste but by the physics of the room.
 *
 * Exactly BORROW, not choose: the person's saved choice is not touched at
 * all, and on leaving the console for the room they get the theme they came
 * with. The returned function puts everything back.
 *
 * Only the lecture console borrows. The council console does NOT: it is kept
 * not in a dark hall but next to the notebook, as a second window on the same
 * monitor, and a light room with a dark window beside it looks like two
 * different programs on one screen.
 */
export function borrowTheme(next: ThemeName): () => void {
  const was = borrowed
  borrowed = true
  apply(next)
  return () => {
    borrowed = was
    // Not to the remembered theme but to the current one: while the screen was
    // open, the theme may have been switched in another window, and what must
    // come back is the one chosen NOW.
    apply(current)
  }
}

export const theme: ThemeStore = {
  get current(): ThemeName {
    return current
  },
  set: setTheme,
  toggle: () => setTheme(current === 'dark' ? 'light' : 'dark'),
}

// Importing this module is enough to dress the document: module evaluation runs
// before the first paint, so a stored choice never flashes the other theme even
// if the entry point forgets to call initTheme().
initTheme()
