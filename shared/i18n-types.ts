export type Locale = 'ru' | 'en'
export type PluralText = {
  other: string
  zero?: string
  one?: string
  two?: string
  few?: string
  many?: string
}
export type MessageText = string | PluralText
export type MessageCatalog = Record<string, { ru: MessageText; en: MessageText }>
export type TranslationParams = Record<string, string | number>
