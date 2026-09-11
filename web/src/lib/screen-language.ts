let full: Promise<unknown> | null = null
const ensureMessages = () => (full ??= import('./full-language'))

/** Catalog registration precedes module evaluation, including top-level tr(). */
export async function loadLocalizedScreen<T>(
  screen: () => Promise<T>,
  messages: () => Promise<unknown> = ensureMessages,
): Promise<T> {
  await messages()
  return screen()
}
