/**
 * Russian plural agreement: один шаг, два шага, пять шагов (one step, two
 * steps, five steps).
 *
 * In shared rather than next to a screen, because a label with a number is
 * drawn by TWO renderers: the room and reader components, and the static pages
 * the server builds for Pages (`server/src/publish/render.ts`). While the rule
 * lived only in `web/src/lib`, the second one had its own ternary copy
 * ("n < 5 ? шага : шагов", "N шага"), and it lied: "5 шага", "12 шага",
 * "21 шагов" — in the header of every multi-step page on colloq.ru.
 *
 * There is one rule and all of it is here: one, except eleven; two to four,
 * except twelve to fourteen; everything else.
 *
 * Returns the WORD, not "number word": on a course page the singular is
 * spelled out as a word ("одна страница", one page), and only the code that
 * builds the phrase can put it there.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}
