/**
 * A course's colour square: the mark that ties one course together across
 * the panel — its cards on «Новое занятие», its chips on «Преподаватели»,
 * its folder on «Занятия».
 *
 * A course stores no colour, and asking a teacher to pick one is a decision
 * nobody wants to make for thirty courses. The colour is derived from the id
 * instead, so the same course has the same square on every screen and in
 * every browser, and a rename does not repaint it. The first three are the
 * mockup's (Paper, page 11); the rest keep the same weight on white and on
 * the dark theme's canvas, so no square reads as a warning or a status.
 * Twelve, not seven: with a hash two courses on one screen share a square
 * one time in twelve instead of one in seven.
 */
export const COURSE_COLORS = [
  '#0FA0D7', '#374B9B', '#2F8A5F', '#B7791F', '#8A55B8', '#C2475E', '#3E7F8C',
  '#6B8E23', '#D2691E', '#5A6FD6', '#A0527A', '#1F9E89',
] as const

export function courseColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return COURSE_COLORS[hash % COURSE_COLORS.length]
}
