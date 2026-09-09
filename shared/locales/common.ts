import type { MessageCatalog } from '../i18n-types.js'
export const commonMessages: MessageCatalog = {
  'common.loadingApp': { ru: 'Загрузка Colloq', en: 'Loading Colloq' },
  'common.loading': { ru: 'Загрузка…', en: 'Loading…' },
  'common.greeting': { ru: 'Здравствуйте, {name}', en: 'Hello, {name}' },
  'common.people': {
    ru: {
      one: '{count} человек',
      few: '{count} человека',
      many: '{count} человек',
      other: '{count} человека',
    },
    en: { one: '{count} person', other: '{count} people' },
  },
  'common.reload': { ru: 'Обновить', en: 'Reload' },
  'common.moduleLoadFailed': {
    ru: 'Часть приложения не загрузилась — возможно, сервер обновился. Перезагрузите страницу: сохранённая тетрадь останется на месте.',
    en: 'Part of the app could not load; the server may have been updated. Reload the page. Your saved notebook will remain available.',
  },
  'common.invalidLanguage': {
    ru: 'Выберите русский или английский язык.',
    en: 'Choose Russian or English.',
  },
  'common.languageReadFailed': {
    ru: 'Не удалось прочитать настройки языка.',
    en: 'Could not read the language setting.',
  },
  'common.networkError': {
    ru: 'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.',
    en: 'Could not reach the server — check the connection and try again.',
  },
  'common.http401': { ru: 'Нужно войти (401)', en: 'Not signed in (401)' },
  'common.http403': { ru: 'Нет доступа (403)', en: 'Not allowed (403)' },
  'common.http404': { ru: 'Не найдено (404)', en: 'Not found (404)' },
  'common.http413': { ru: 'Превышен допустимый размер (413)', en: 'Too large (413)' },
  'common.http429': { ru: 'Слишком много запросов (429)', en: 'Too many requests (429)' },
  'common.serverFailed': { ru: 'Ошибка сервера ({status})', en: 'The server failed ({status})' },
  'common.requestFailed': {
    ru: 'Не удалось выполнить запрос ({status})',
    en: 'The request failed ({status})',
  },
  'common.notFound': { ru: 'Не найдено', en: 'not found' },
  'common.badJson': { ru: 'Некорректное тело JSON-запроса', en: 'malformed JSON body' },
  'common.bodyTooLarge': { ru: 'Тело запроса слишком большое', en: 'request body too large' },
  'common.badRequest': { ru: 'Некорректный запрос', en: 'bad request' },
  'common.internalError': { ru: 'Внутренняя ошибка сервера', en: 'internal error' },
  'common.runtimeUnavailable': {
    ru: 'Среда выполнения недоступна',
    en: 'Kernel runtime is unavailable',
  },
  'common.settingsRequired': {
    ru: 'Передайте объект настроек.',
    en: 'a settings object is required',
  },
  'common.unknownProvider': { ru: 'Неизвестный провайдер.', en: 'unknown provider' },
  'common.unknownOracleMode': { ru: 'Неизвестный режим оракула.', en: 'unknown oracle mode' },
  'common.mustBeText': { ru: 'Поле «{field}» должно быть текстом.', en: '{field} must be text' },
  'common.mustBeNumber': {
    ru: 'Поле «{field}» должно быть числом.',
    en: '{field} must be a number',
  },
  'common.urlScheme': {
    ru: 'Адрес API должен начинаться с http:// или https://.',
    en: 'the base URL must start with http:// or https://',
  },
}
