import { tr } from '@shared/i18n'
/**
 * Доступ к ОТДЕЛЬНОЙ тетради — то, что человек про него видит.
 *
 * Права считает `shared/rules.ts` (`rulesForBook`), и второй копии этого
 * решения здесь нет и быть не должно. Здесь только слова и форма: метка на
 * вкладке, четыре строки меню и патч, который уезжает тем же маршрутом, что и
 * все остальные правила комнаты.
 *
 * Чистый модуль, без Svelte: то, что решает, какое слово стоит на вкладке,
 * проверяется тестом, а не глазами на снимке.
 */
import type { BookAccess, BookRule, RoomRules } from '@shared/rules'

/** Тетрадь комнаты вместе с тем, что комната про неё помнит. */
export interface BookTab {
  path: string
  root: string
  /** Запись в правилах или `null` — «про эту тетрадь ничего не сказано». */
  rule: BookRule | null
  /**
   * Её ядро сейчас занято: считается ячейка или стоит очередь.
   *
   * У каждой тетради своё ядро, и считать они могут одновременно. Без этой
   * точки соседняя вкладка, в которой полторы минуты идёт обучение, выглядит
   * ровно как пустая — и человек переключается туда посмотреть, идёт ли ещё.
   */
  busy?: boolean
}

/**
 * Короткая метка на вкладке — и только там, где доступ НЕ «как в комнате».
 *
 * Метка у каждой тетради была бы шумом: у большинства доступ комнатный, и
 * подпись «как в комнате» на каждой вкладке говорит ровно ничего. Появляется
 * она тогда, когда тетрадь живёт не по правилам комнаты, — то есть тогда, когда
 * серая кнопка внутри нуждается в объяснении.
 *
 * Автор видит про свою «моя», а не «личная · <своё имя>»: имя собственной
 * тетради человеку сообщать незачем, а «моя» — это ровно то, что ему нужно
 * знать в лекции, где всё остальное серое.
 */
export interface BookMark {
  text: string
  tone: 'mine' | 'personal' | 'all' | 'host'
}

export function bookMark(rule: BookRule | null, meId: string | null): BookMark | null {
  if (!rule || rule.access === 'room') return null
  if (rule.access === 'all') return { text: tr('room.book.mark.all'), tone: 'all' }
  if (rule.access === 'host') return { text: tr('room.book.mark.host'), tone: 'host' }
  if (rule.owner !== null && meId !== null && rule.owner === meId) {
    return { text: tr('room.book.mark.mine'), tone: 'mine' }
  }
  return {
    text: rule.ownerName
      ? tr('room.book.mark.personal', { name: rule.ownerName })
      : tr('room.book.mark.personalNoName'),
    tone: 'personal',
  }
}

/** Строка меню «Доступ»: что выбирают и что при этом случится. */
export interface AccessOption {
  access: BookAccess
  label: string
  hint: string
  /**
   * Выбрать нельзя — и меню говорит почему, а не прячет строку.
   *
   * Касается ровно «Личной»: сделать тетрадь личной можно только тогда, когда у
   * неё есть автор, а автор записывается в тот миг, когда её заводит студент
   * (server/src/collab/books.ts). У преподавательской тетради автора нет, и
   * спрятанная строка читалась бы как «такого не бывает» — а бывает, просто не
   * у этой.
   */
  disabled: boolean
}

export function accessOptions(rule: BookRule | null): AccessOption[] {
  const owner = rule?.ownerName ?? null
  const known = Boolean(rule?.owner)
  return [
    {
      access: 'room',
      label: tr('room.book.access.room'),
      hint: tr('room.book.access.roomHint'),
      disabled: false,
    },
    {
      access: 'owner',
      label: owner
        ? tr('room.book.access.owner', { name: owner })
        : tr('room.book.access.ownerNoAuthor'),
      // Подсказка у недоступной строки говорит, ПОЧЕМУ её нельзя выбрать, а не
      // что она делает: последнее здесь бесполезно.
      hint: known ? tr('room.book.access.ownerHint') : tr('room.book.access.ownerNone'),
      disabled: !known,
    },
    {
      access: 'all',
      label: tr('room.book.access.all'),
      hint: tr('room.book.access.allHint'),
      disabled: false,
    },
    {
      access: 'host',
      label: tr('room.book.access.host'),
      hint: tr('room.book.access.hostHint'),
      disabled: false,
    },
  ]
}

/**
 * Патч правил, которым меняется доступ к одной тетради.
 *
 * Правила комнаты меняются одним маршрутом (PATCH /api/sessions/:id/rules), и
 * доступ к тетради — не исключение: он живёт в тех же правилах, едет тем же
 * кадром и так же проверяет роль на сервере. Карта пересылается целиком, потому
 * что PATCH накладывает присланное поверх сохранённого по ВЕРХНЕМУ уровню, а
 * `books` — один ключ этого уровня.
 *
 * Автор из записи сохраняется, даже когда доступ вернули к комнатному: имя
 * нужно меню, чтобы в следующий раз снова предложить «Личная — Аким», и терять
 * его от одного передумывания нельзя. Запись без автора при `room` сервер
 * отбросит сам (shared/rules.ts · readRules), так что карта не пухнет.
 */
export function accessPatch(
  rules: RoomRules,
  root: string,
  access: BookAccess,
): Partial<RoomRules> {
  const was = rules.books?.[root] ?? null
  const books: Record<string, BookRule> = { ...(rules.books ?? {}) }
  books[root] = {
    access,
    owner: was?.owner ?? null,
    ownerName: was?.ownerName ?? null,
  }
  return { books }
}
