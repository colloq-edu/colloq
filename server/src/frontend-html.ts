import { normalizeLocale, type Locale } from '@shared/i18n'

/** Small public bootstrap data: the browser need not fetch it before mounting. */
export function withInitialLanguage(html: string, language: Locale): string {
  const locale = normalizeLocale(language)
  const meta = `<meta name="colloq-language" content="${locale}">`
  const localized = html.replace(/<html\b([^>]*)>/i, (_tag, attributes: string) => {
    const next = /\blang\s*=/i.test(attributes)
      ? attributes.replace(/\blang\s*=\s*(['"])[^'"]*\1/i, `lang="${locale}"`)
      : `${attributes} lang="${locale}"`
    return `<html${next}>`
  })
  return /<\/head>/i.test(localized)
    ? localized.replace(/<\/head>/i, `${meta}</head>`)
    : meta + localized
}
