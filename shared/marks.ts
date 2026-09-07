/**
 * The room's vocabulary of marks, and the rule for handing one out.
 *
 * Ten emoji in a row was the old picker, and ten is fewer than a seminar
 * group: the eleventh student had to share a cursor with someone. Forty is
 * one screenful at eight across and still leaves headroom for a full class.
 *
 * `name` is what the search box matches, so it is the word a student would
 * actually type; `alt` carries the second word people reach for — "dinosaur"
 * finds both dinosaurs, "ladybug" finds the ladybird.
 *
 * Живёт в shared, а не у экрана входа, потому что судья уникальности —
 * сервер: он подменяет занятую метку свободной на входе (routes/sessions.ts ·
 * `/join`), и выбирать ему не из чего, кроме этого списка. Два списка,
 * разошедшиеся на одну строку, дали бы комнату, где сервер раздаёт зверя,
 * которого браузер не рисует вовсе.
 */
export interface Mark {
  mark: string
  name: string
  alt?: string
}

export const MARKS: readonly Mark[] = [
  { mark: '🦊', name: 'fox' },
  { mark: '🐢', name: 'turtle', alt: 'tortoise' },
  { mark: '🐙', name: 'octopus' },
  { mark: '🦉', name: 'owl' },
  { mark: '🐝', name: 'bee' },
  { mark: '🐬', name: 'dolphin' },
  { mark: '🦋', name: 'butterfly' },
  { mark: '🐧', name: 'penguin' },
  { mark: '🦩', name: 'flamingo' },
  { mark: '🐨', name: 'koala' },
  { mark: '🦔', name: 'hedgehog' },
  { mark: '🐳', name: 'whale' },
  { mark: '🦜', name: 'parrot' },
  { mark: '🐞', name: 'ladybird', alt: 'ladybug beetle' },
  { mark: '🦈', name: 'shark' },
  { mark: '🐸', name: 'frog' },
  { mark: '🦌', name: 'deer' },
  { mark: '🐿️', name: 'squirrel' },
  { mark: '🦇', name: 'bat' },
  { mark: '🐺', name: 'wolf' },
  { mark: '🦅', name: 'eagle' },
  { mark: '🐡', name: 'pufferfish', alt: 'blowfish' },
  { mark: '🦂', name: 'scorpion' },
  { mark: '🐌', name: 'snail' },
  { mark: '🦕', name: 'sauropod', alt: 'dinosaur brontosaurus' },
  { mark: '🦖', name: 'T. rex', alt: 'dinosaur tyrannosaurus' },
  { mark: '🐊', name: 'crocodile', alt: 'alligator' },
  { mark: '🦚', name: 'peacock' },
  { mark: '🦡', name: 'badger' },
  { mark: '🐫', name: 'camel' },
  { mark: '🦥', name: 'sloth' },
  { mark: '🦦', name: 'otter' },
  { mark: '🦫', name: 'beaver' },
  { mark: '🐆', name: 'leopard', alt: 'cheetah' },
  { mark: '🦓', name: 'zebra' },
  { mark: '🦒', name: 'giraffe' },
  { mark: '🦘', name: 'kangaroo' },
  { mark: '🐘', name: 'elephant' },
  { mark: '🦏', name: 'rhino', alt: 'rhinoceros' },
  { mark: '🦛', name: 'hippo', alt: 'hippopotamus' },
]

const BY_MARK = new Map(MARKS.map((entry) => [entry.mark, entry]))

/**
 * Метка ли это вообще.
 *
 * Спрашивает Avatar, и вопрос не праздный: метка приезжает в чужие браузеры
 * через присутствие, то есть как угодно правленным клиентом, а рисуется у
 * каждого в комнате — в списке людей, в шапке, под ячейкой, в терминале.
 * Строка из этого списка — единственное, что продукт когда-либо выдаёт;
 * всё остальное рисовать НЕ надо.
 */
export function isMark(value: string | null | undefined): boolean {
  return !!value && BY_MARK.has(value)
}

/** The word the card puts in front of the student: "The fox is yours". */
export function markName(mark: string | null): string {
  return (mark && BY_MARK.get(mark)?.name) || 'mark'
}

/**
 * Кто уже носит метку — только этот вопрос, и всё равно чем отвечено.
 *
 * Экран входа держит таблицу «метка → цвет носителя» (она же рисует занятых
 * серым), сервер — просто множество занятых. Общей функции нужна одна
 * операция, и требовать ради неё одинаковую коллекцию с обеих сторон значит
 * заставить одну из них строить лишнюю.
 */
export type MarkSet = { has(mark: string): boolean }

/**
 * A mark nobody in this room holds. `prefer` is what this browser used last;
 * it is kept when the room has left it free, so a student who comes back next
 * week is the same animal they were.
 *
 * A full room hands out a duplicate rather than refusing to let someone in —
 * two foxes is a worse cursor, not a closed door.
 */
export function freeMark(taken: MarkSet, prefer?: string | null): string {
  if (prefer && BY_MARK.has(prefer) && !taken.has(prefer)) return prefer
  const free = MARKS.filter((entry) => !taken.has(entry.mark))
  const pool = free.length > 0 ? free : MARKS
  return pool[Math.floor(Math.random() * pool.length)].mark
}
