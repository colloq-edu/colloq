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
  apply(current)
}

let started = false

export function initTheme(): void {
  if (started) return
  started = true
  apply(current)
  media?.addEventListener('change', onSystemChange)
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

/**
 * Одолжить тему на время одного экрана.
 *
 * Пульт держат в тёмной аудитории, где светит только проектор: белая плита
 * 1180×820 в руках преподавателя светит ему в лицо, видна первому ряду и
 * сажает зрачок, которому через секунду смотреть на слайд. Поэтому пульт
 * всегда тёмный — не по вкусу владельца планшета, а по физике помещения.
 *
 * Именно ОДОЛЖИТЬ, а не выбрать: сохранённый выбор человека не трогается
 * вовсе, и, выйдя из пульта в комнату, он получает ту тему, с которой пришёл.
 * Возвращаемая функция ставит всё на место.
 */
export function borrowTheme(next: ThemeName): () => void {
  const was = current
  if (was === next) return () => {}
  current = next
  apply(next)
  return () => {
    current = was
    apply(was)
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
