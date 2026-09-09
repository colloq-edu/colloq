import { getLocale } from '@shared/i18n'
import { plural as russianPlural } from '@shared/plural'

/** Choose display forms with the instance language, not the browser language. */
export function plural(count: number, one: string, few: string, many: string): string {
  if (getLocale() === 'ru') return russianPlural(count, one, few, many)
  // Russian “человек” serves as both singular and many; English has two forms.
  if (one === 'person' || one === 'people') return Math.abs(count) === 1 ? 'person' : 'people'
  return Math.abs(count) === 1 ? one : many
}
