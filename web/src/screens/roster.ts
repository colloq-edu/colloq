import { tr } from '@shared/i18n'
/**
 * Лица в полосе состояния — и то, как не пересобирать их на каждый чужой курсор.
 *
 * `yCollab` объявляет положение курсора через присутствие на каждое движение
 * выделения: при сотне печатающих это сотни кадров присутствия в секунду, и
 * каждый из них будил в комнате всю бухгалтерию людей — новый массив из 500
 * объектов, склейку 500 имён в `title`, перерисовку стопки аватаров. Ничего из
 * этого от курсора не меняется: полоса рисует ИМЯ, МЕТКУ и ЦВЕТ, а они за пару
 * не меняются вовсе.
 *
 * Поэтому здесь два чистых куска: сравнение «то же самое ли рисуем» без единой
 * аллокации (его хватает, чтобы вернуть ТОТ ЖЕ массив и остановить всё, что
 * ниже) и строка имён с потолком — 500 имён в `title` не читает никто, а
 * склеивать их на каждый кадр приходилось.
 *
 * Настоящая починка — выше по течению, в коалесинге присутствия (см. handoff
 * по `#readPeers`); это то, что можно сделать со стороны экрана, и оно снимает
 * всё, что происходит ПОСЛЕ прихода кадра.
 */

/** Человек так, как его рисует полоса состояния. */
export interface Face {
  id: string
  name: string
  avatar: string | null
  color: string
  /** Подпись под наведением: имя, и «(you)» — если это ты. */
  title: string
}

/** То немногое из присутствия, от чего лицо в полосе зависит. */
export interface Someone {
  user: { id: string; name: string; avatar: string | null; color: string }
  isSelf: boolean
}

export function faceOf(person: Someone): Face {
  return {
    id: person.user.id,
    name: person.user.name,
    avatar: person.user.avatar,
    color: person.user.color,
    get title() { return person.isSelf ? tr('room.person.self', { name: person.user.name }) : person.user.name },
  }
}

/**
 * Рисуем ли мы то же самое, что и в прошлый раз.
 *
 * Ни одной аллокации: сравниваются четыре примитива на человека, а не
 * собирается ключ строкой. Порядок значим и это верно — список приходит
 * отсортированным, и перестановка двух имён в стопке видна.
 */
export function sameFaces(prev: readonly Face[], people: readonly Someone[]): boolean {
  if (prev.length !== people.length) return false
  for (let i = 0; i < people.length; i++) {
    const was = prev[i]
    const now = people[i]
    if (
      was.id !== now.user.id ||
      was.name !== now.user.name ||
      was.avatar !== now.user.avatar ||
      was.color !== now.user.color ||
      // «(you)» в подписи — тоже то, что видно.
      was.title !== (now.isSelf ? tr('room.person.self', { name: now.user.name }) : now.user.name)
    ) {
      return false
    }
  }
  return true
}

/**
 * Имена под наведением — с потолком.
 *
 * Подсказка на пятьсот имён не читается и не помещается: браузер обрезает её
 * сам, но склеить строку всё равно приходится. Двадцать имён — это уже больше,
 * чем успевают прочитать, а хвост назван числом.
 */
export function namesLine(faces: readonly Face[], cap = 20): string {
  if (faces.length <= cap) return faces.map((face) => face.title).join(', ')
  const shown = faces.slice(0, cap).map((face) => face.title)
  return tr('room.people.more', { names: shown.join(', '), count: faces.length - cap })
}
