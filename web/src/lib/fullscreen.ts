/**
 * Полный экран — там, где он есть.
 *
 * Проекция обязана занимать весь экран: полоса вкладок Safari поверх слайда —
 * это полоса вкладок Safari, которую видит вся аудитория. Но API везде разный,
 * и разница не косметическая: на iPad беспрефиксный `requestFullscreen`
 * появился только в Safari 16.4, до него — вебкитовский с префиксом, а на
 * iPhone элементного полного экрана нет вовсе, и кнопку там показывать нельзя
 * — она бы просто ничего не делала.
 *
 * Отсюда три функции вместо одной: спросить, есть ли он вообще; попросить;
 * отпустить. Проекция работает и без него — просто с чужой рамкой по краям.
 */

interface WebkitElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void
}

interface WebkitDocument extends Document {
  webkitFullscreenEnabled?: boolean
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}

/** Умеет ли этот браузер разворачивать элемент во весь экран. */
export function fullscreenPossible(): boolean {
  const doc = document as WebkitDocument
  return doc.fullscreenEnabled === true || doc.webkitFullscreenEnabled === true
}

/** Разворачивает ли он что-то прямо сейчас. */
export function fullscreenNow(): boolean {
  const doc = document as WebkitDocument
  return (doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null) !== null
}

/**
 * Развернуть.
 *
 * Обязано вызываться из обработчика нажатия: браузер разрешает полный экран
 * только по живому жесту человека, и вызов из эффекта после навигации молча
 * отклоняется. Отказ здесь не ошибка — это «нельзя», и проекция после него
 * продолжает работать в окне.
 */
export async function goFullscreen(node: HTMLElement): Promise<void> {
  const target = node as WebkitElement
  try {
    if (typeof target.requestFullscreen === 'function') await target.requestFullscreen()
    else if (typeof target.webkitRequestFullscreen === 'function') await target.webkitRequestFullscreen()
  } catch {
    /* отказали — окно тоже годится */
  }
}

export async function leaveFullscreen(): Promise<void> {
  const doc = document as WebkitDocument
  try {
    if (!fullscreenNow()) return
    if (typeof doc.exitFullscreen === 'function') await doc.exitFullscreen()
    else if (typeof doc.webkitExitFullscreen === 'function') await doc.webkitExitFullscreen()
  } catch {
    /* уже вышли */
  }
}
