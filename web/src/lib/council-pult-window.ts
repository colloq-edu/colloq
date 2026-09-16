/**
 * Окно пульта консилиума: как его открыть, где оно стояло и открыто ли оно.
 *
 * Пульт — отдельное окно браузера, а не панель: список 308 и работа 591 обязаны
 * стоять рядом (Paper · 05c · доска 11), и в правой панели тетради это не
 * помещается. Отсюда две задачи, которых в продукте до сих пор не было.
 *
 * ПЕРВАЯ — место. Браузер помнит размеры окон сам только для окна, открытого
 * пользователем; окно, открытое скриптом, каждый раз встаёт туда, куда указали.
 * Поэтому место и размер запоминаются на комнату в localStorage, и второй раз
 * пульт открывается ровно туда же. Это ЛУЧШЕЕ УСИЛИЕ: последнее слово всё равно
 * за браузером и за оконным менеджером, и отказ здесь ничего не ломает.
 *
 * ВТОРАЯ — «открыт ли». Под ячейкой стоит одна кнопка, и она обязана знать,
 * что делать: открыть окно, поднять его или перевести на эту ячейку (пульт в
 * комнате один — иначе это второе место с именами, ради чего окно и заводили).
 * Ссылки на окно для этого мало: `window.open` возвращает handle, но ни
 * `closed`, ни `onunload` через перезагрузку тетради не переживают, а вкладку
 * с тетрадью перезагружают. Окно само стучится раз в секунду в
 * BroadcastChannel, и тетрадь считает его открытым, пока последний стук младше
 * трёх секунд. Молчание — закрыто: отсутствие вести о смерти не должно навсегда
 * оставлять кнопку в положении «Пульт открыт».
 *
 * Без рун и без DOM: `beatsAlive` и `windowFeatures` проверяются тестами.
 */

/** Общий на весь браузер — в сообщении стоит комната и ячейка. */
export const PULT_CHANNEL = 'colloq-council-pult'
/** Как часто окно стучит. */
export const PULT_BEAT_MS = 1000
/** Старше этого — считаем закрытым. Три стука: одного пропущенного мало. */
export const PULT_STALE_MS = 3000

export const PULT_WIDTH = 1120
export const PULT_HEIGHT = 820
export const PULT_MIN_WIDTH = 760
export const PULT_MIN_HEIGHT = 600

export interface PultBeat {
  sessionId: string
  cellId: string
  at: number
  /** Окно уходит: `pagehide` шлёт это, чтобы не ждать трёх секунд молчания. */
  closed?: boolean
}

export interface PultPlace {
  left: number
  top: number
  width: number
  height: number
}

/** Живо ли окно по последнему стуку. `null` — не стучалось ни разу. */
export function beatsAlive(beat: PultBeat | null, now: number): boolean {
  if (!beat || beat.closed) return false
  // Часы соседнего окна — те же самые (`Date.now` одной машины), но на
  // усыплённом ноутбуке стук из будущего на пару миллисекунд встречается.
  return now - beat.at < PULT_STALE_MS
}

/** Имя окна: одна комната — одно окно, вторая ячейка его переиспользует. */
export function pultWindowName(sessionId: string): string {
  return `colloq-council-pult-${sessionId}`
}

/** Адрес пульта. Тот же разбор, что в lib/routes.ts. */
export function pultPath(sessionId: string, cellId: string): string {
  return `/s/${sessionId}/council/${cellId}`
}

const placeKey = (sessionId: string): string => `colloq.council.pult.${sessionId}`

/** Где окно стояло в прошлый раз. Мусор в хранилище — как будто ничего нет. */
export function readPultPlace(sessionId: string): PultPlace | null {
  try {
    const raw = localStorage.getItem(placeKey(sessionId))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const place = parsed as Record<string, unknown>
    const numbers = ['left', 'top', 'width', 'height'].map((key) => place[key])
    if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value))) return null
    return {
      left: Math.round(place.left as number),
      top: Math.round(place.top as number),
      width: Math.max(PULT_MIN_WIDTH, Math.round(place.width as number)),
      height: Math.max(PULT_MIN_HEIGHT, Math.round(place.height as number)),
    }
  } catch {
    return null
  }
}

export function savePultPlace(sessionId: string, place: PultPlace): void {
  try {
    localStorage.setItem(placeKey(sessionId), JSON.stringify(place))
  } catch {
    // Приватное окно, переполненное хранилище — место просто не запомнится.
  }
}

/**
 * Строка `features` для `window.open`.
 *
 * `popup=yes` обязателен: без него Chrome открывает ВКЛАДКУ и молча
 * игнорирует размеры, а пульт во вкладке — это второй раз та же тетрадь.
 * Координаты ставятся только когда они известны: `left=NaN` роняет всю строку.
 */
export function windowFeatures(place: PultPlace | null): string {
  const parts = [
    'popup=yes',
    'noopener=no',
    `width=${place?.width ?? PULT_WIDTH}`,
    `height=${place?.height ?? PULT_HEIGHT}`,
  ]
  if (place) parts.push(`left=${place.left}`, `top=${place.top}`)
  return parts.join(',')
}

/**
 * Открыть пульт — или поднять уже открытый.
 *
 * Имя окна делает всю работу: второй `window.open` с тем же именем не
 * открывает второе окно, а возвращает первое, и его остаётся сфокусировать.
 * `null` — окно заблокировано: зовущий говорит об этом словами, потому что
 * молчащая кнопка читается как сломанная.
 */
export function openPult(sessionId: string, cellId: string): Window | null {
  const place = readPultPlace(sessionId)
  let opened: Window | null = null
  try {
    opened = window.open(pultPath(sessionId, cellId), pultWindowName(sessionId), windowFeatures(place))
  } catch {
    return null
  }
  try {
    opened?.focus()
  } catch {
    // Кросс-оконный focus умеет отказывать; окно при этом открыто.
  }
  return opened
}

/**
 * Стучать из окна пульта. Возвращает «перестать»: последним сообщением уходит
 * `closed`, чтобы тетрадь развернула консоль сразу, а не через три секунды.
 */
export function announcePult(sessionId: string, cellId: string): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const channel = new BroadcastChannel(PULT_CHANNEL)
  const beat = (closed = false): void => {
    const message: PultBeat = { sessionId, cellId, at: Date.now(), ...(closed ? { closed: true } : {}) }
    try {
      channel.postMessage(message)
    } catch {
      // Канал закрыли раньше таймера — стучать больше некуда.
    }
  }
  beat()
  const timer = setInterval(() => beat(), PULT_BEAT_MS)
  const bye = (): void => beat(true)
  window.addEventListener('pagehide', bye)
  return () => {
    clearInterval(timer)
    window.removeEventListener('pagehide', bye)
    bye()
    channel.close()
  }
}

/**
 * Слушать стук из тетради. `onbeat` зовётся на каждое сообщение ЭТОЙ комнаты;
 * решение «жив или нет» принимает зовущий по `beatsAlive` — ему же нужен
 * таймер на затухание.
 */
export function watchPult(sessionId: string, onbeat: (beat: PultBeat) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const channel = new BroadcastChannel(PULT_CHANNEL)
  channel.onmessage = (event: MessageEvent<PultBeat>) => {
    const beat = event.data
    if (!beat || beat.sessionId !== sessionId) return
    onbeat(beat)
  }
  return () => channel.close()
}

/**
 * Что делать с окном, когда преподаватель просит пульт ЭТОЙ ячейки.
 *
 * Окно на комнату одно (`pultWindowName`), а консилиумов в тетради может идти
 * несколько, и три случая различаются по последнему стуку:
 *  — не стучится — открыть;
 *  — стучится по этой ячейке — поднять, не перезагружая;
 *  — стучится по другой — перевести его сюда, а не открывать второе окно
 *    рядом: два пульта одной комнаты — это два места с именами, ради чего
 *    окно и заводили.
 * Решение отдельной функцией и без DOM — его проверяет тест.
 */
export type PultReach = 'open' | 'navigate' | 'focus'

export function pultReach(beat: PultBeat | null, cellId: string, now: number): PultReach {
  if (!beatsAlive(beat, now)) return 'open'
  return beat?.cellId === cellId ? 'focus' : 'navigate'
}

/**
 * Поднять уже открытое окно, НЕ перезагружая его.
 *
 * `window.open` с пустым адресом находит окно по имени и ничего в нём не
 * открывает — иначе повторный адрес перезагрузил бы пульт и стёр отбор,
 * курсор и раскрытые группы, то есть весь способ смотреть. Зовётся только
 * когда стук говорит, что окно живо: без живого окна пустой адрес открыл бы
 * пустое.
 */
export function focusPult(sessionId: string): Window | null {
  try {
    const opened = window.open('', pultWindowName(sessionId))
    opened?.focus()
    return opened
  } catch {
    return null
  }
}
