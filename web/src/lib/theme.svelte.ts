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
 * Соседнее окно той же комнаты — пульт консилиума — следует за переключателем.
 *
 * Выбор темы хранится на браузер (`colloq.theme.v1`), а не на вкладку, и
 * второе окно обязано слушаться того же тумблера: переключили тему в тетради,
 * и пульт рядом на втором мониторе обязан перекраситься вместе с ней, а не
 * ждать перезагрузки. `storage` приходит только в ДРУГИЕ документы — тот, кто
 * писал, уже перекрасился сам.
 *
 * `key === null` — хранилище очистили целиком: возвращаемся к системной.
 */
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== STORAGE_KEY) return
  chosen = readStored()
  const next = chosen ?? systemTheme()
  if (next === current) return
  current = next
  // Экран, одолживший тему (лекционный пульт), чужого выбора не слушается: он
  // тёмный по физике аудитории, а не по вкусу.
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

/** Экран одолжил тему: чужой выбор его не перекрашивает. */
let borrowed = false

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
 *
 * Одалживает только лекционный пульт. Пульт консилиума — НЕТ: его держат не в
 * тёмном зале, а рядом с тетрадью, вторым окном на том же мониторе, и светлая
 * комната со тёмным окном рядом — это две разные программы на одном экране.
 */
export function borrowTheme(next: ThemeName): () => void {
  const was = borrowed
  borrowed = true
  apply(next)
  return () => {
    borrowed = was
    // Не к запомненной теме, а к нынешней: пока экран был открыт, тему могли
    // переключить в соседнем окне, и вернуть надо ТУ, что выбрана сейчас.
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
